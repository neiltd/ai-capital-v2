// Deterministic, rule-based advisor for the Thai Tax Planner. NO LLM CALL —
// per explicit human decision (real "buy this" suggestions against real
// money get auditable rules, not an LLM, for v1; see the design-review
// README §4/§6). This module is pure: given the current plan, the real
// portfolio's asset-class allocation, and a fund-facts table, it returns
// ranked recommendations. All reasoning is inspectable in the functions below
// — no hidden prompt, no sampling.

import type { AssetClass, Position } from '@/lib/next/types'
import type { ContribId, PlanResult } from './tax-engine'
import { toUsd } from '@/lib/next/format'

/* ------------------------------ allocation -------------------------------- */

export interface AllocationClassView {
  assetClass: AssetClass
  label: string
  usd: number
  pct: number // 0..1 of total book
  targetPct: number | null
}

export interface AllocationSummary {
  totalUsd: number
  byClass: AllocationClassView[]
  /** Share of the book held in THB-native positions (currency, not asset
   *  class — cash + Thai equity + Thai funds all count). */
  thbNativePct: number
  usEquityPct: number
}

export function computeAllocation(
  positions: Position[],
  usdThb: number,
  classMeta: Record<AssetClass, { label: string }>,
  classOrder: AssetClass[],
  targets: Partial<Record<AssetClass, number>> | null,
): AllocationSummary {
  const totalUsd = positions.reduce((s, p) => s + toUsd(p, usdThb), 0)
  const byClassUsd: Record<string, number> = {}
  let thbUsd = 0
  let usEquityUsd = 0
  for (const p of positions) {
    const v = toUsd(p, usdThb)
    byClassUsd[p.assetClass] = (byClassUsd[p.assetClass] ?? 0) + v
    if (p.currency === 'THB') thbUsd += v
    if (p.assetClass === 'us_equity') usEquityUsd += v
  }
  const byClass: AllocationClassView[] = classOrder.map((assetClass) => ({
    assetClass,
    label: classMeta[assetClass].label,
    usd: byClassUsd[assetClass] ?? 0,
    pct: totalUsd > 0 ? (byClassUsd[assetClass] ?? 0) / totalUsd : 0,
    targetPct: targets?.[assetClass] ?? null,
  }))
  return {
    totalUsd,
    byClass,
    thbNativePct: totalUsd > 0 ? thbUsd / totalUsd : 0,
    usEquityPct: totalUsd > 0 ? usEquityUsd / totalUsd : 0,
  }
}

/* ------------------------------- fund facts -------------------------------- */

/** SAMPLE/ILLUSTRATIVE fund-facts table for v1 — expense ratios, track
 *  record and category are placeholders, not a live data feed. A real
 *  fund-data ingestion pipeline is explicitly deferred to a future phase
 *  (design-review decision #5). Every card built from this table carries a
 *  caveat in the UI saying so. Tickers are real K-Asset fund names chosen
 *  because the real book is already K-Asset-heavy (PFM009, both ThaiESG
 *  positions) — picked for illustrative continuity, not verified pricing. */
export interface FundFact {
  ticker: string
  label: string
  category: ContribId
  focus: 'global_equity' | 'thai_equity'
  expenseRatioPct: number // illustrative
  trackRecordYears: number // illustrative
  note: string
}

export const FUND_FACTS: FundFact[] = [
  {
    ticker: 'KGARMF',
    label: 'K Global Allocation RMF',
    category: 'rmf',
    focus: 'global_equity',
    expenseRatioPct: 1.6,
    trackRecordYears: 8,
    note: 'Illustrative sample — expense ratio and track record are placeholders, not a live fund-facts feed. Verify before buying.',
  },
  {
    ticker: 'K-TNZ-THAIESG',
    label: 'K Target Net Zero (existing holding)',
    category: 'thaiesg',
    focus: 'thai_equity',
    expenseRatioPct: 1.1,
    trackRecordYears: 2,
    note: 'Illustrative sample. Topping an existing holding avoids new product sprawl — figures still need verification before buying.',
  },
]

/* ---------------------------- recommendations ------------------------------ */

export interface AdvisorRec {
  id: string
  category: ContribId
  categoryLabel: string
  fund: string
  fundLabel: string
  amountTHB: number
  conviction: 'high' | 'medium' | 'low'
  taxWhy: string
  investWhy: string
  caveat: string
}

const CATEGORY_LABELS: Record<ContribId, string> = {
  social_security: 'Social security',
  provident_fund: 'Provident fund (PVD)',
  rmf: 'RMF',
  pension_insurance: 'Pension life insurance',
  thaiesg: 'ThaiESG',
  life_insurance: 'Life insurance',
  health_insurance: 'Health insurance',
  parent_health_insurance: "Parents' health insurance",
  mortgage_interest: 'Mortgage interest',
  donations_general: 'Donations — general',
  donations_education: 'Donations — education',
}

const fmt0 = (v: number) => '฿' + Math.round(v).toLocaleString('en-US')
const pct0 = (v: number) => (v * 100).toFixed(0) + '%'
/** Round a suggested purchase amount down to the nearest ฿1,000 so
 *  recommendations read as deliberate figures, not raw cap arithmetic. */
const roundDown1k = (v: number) => Math.floor(v / 1000) * 1000

/**
 * Rule table (deterministic — every branch below is the whole "model", there
 * is no LLM in the loop):
 *
 *  1. RMF — recommend filling whatever's left of the SMALLER of (a) RMF's own
 *     30%-of-income cap and (b) the remaining ฿500k retirement-combo room,
 *     bounded by available THB cash. High conviction when the book is both
 *     THB-heavy (>55% THB-native) and light on US/global equity (<20%) — the
 *     diversification case is strongest exactly when both are true.
 *  2. ThaiESG — recommend filling remaining room, but DELIBERATELY sized down
 *     to 25% of that room when the book is already THB-heavy (>55%
 *     THB-native): ThaiESG funds buy more Thai-equity risk, which argues
 *     against maxing the category even though the deduction is available.
 *     This is the "senior investor, not deduction-maximizer" rule from the
 *     design review.
 *  3. Health insurance — recommend filling the (usually small) remaining
 *     ฿25k cap; framed as protection with a deduction attached, not an
 *     investment.
 *
 * Categories not covered (provident_fund, social_security, pension_insurance,
 * mortgage_interest, donations, life_insurance, parent_health_insurance) are
 * either payroll-administered (not a discretionary "buy") or have no fund-tie
 * -in in this book, so the engine stays silent on them rather than
 * fabricating a recommendation with nothing to base it on.
 */
export function generateRecommendations(
  plan: PlanResult,
  allocation: AllocationSummary,
  fundFacts: FundFact[],
  dryPowderThb: number,
): AdvisorRec[] {
  const recs: AdvisorRec[] = []
  const thbHeavy = allocation.thbNativePct > 0.55
  const usLight = allocation.usEquityPct < 0.2

  // --- 1. RMF -----------------------------------------------------------
  const rmf = plan.contributions.rmf
  const comboRemaining = Math.max(0, plan.retirementCombo.cap - plan.retirementCombo.used)
  const rmfOwnRemaining = Math.max(0, rmf.ownCap - rmf.effective)
  const rmfRoom = Math.min(comboRemaining, rmfOwnRemaining)
  if (rmfRoom > 1000) {
    const amount = roundDown1k(Math.min(rmfRoom, dryPowderThb))
    if (amount >= 1000) {
      const fund = fundFacts.find((f) => f.category === 'rmf')
      recs.push({
        id: 'rec-rmf',
        category: 'rmf',
        categoryLabel: CATEGORY_LABELS.rmf,
        fund: fund?.ticker ?? 'RMF',
        fundLabel: fund?.label ?? 'Retirement Mutual Fund',
        amountTHB: amount,
        conviction: thbHeavy && usLight ? 'high' : 'medium',
        taxWhy: `RMF room: ${fmt0(rmfRoom)} remains open (cap 30% of income, ${fmt0(
          comboRemaining,
        )} left of the shared ฿500,000 retirement ceiling). This purchase deducts in full.`,
        investWhy: `Your book is ${pct0(allocation.thbNativePct)} THB-native assets and only ${pct0(
          allocation.usEquityPct,
        )} US equity — a globally-diversified RMF adds the exposure the book lacks, and the hold-to-55 lock matches a retirement horizon rather than fighting it.`,
        caveat: fund?.note ?? 'Fund facts are illustrative — verify before buying.',
      })
    }
  }

  // --- 2. ThaiESG ---------------------------------------------------------
  const esg = plan.contributions.thaiesg
  const esgRoomFull = Math.max(0, esg.ownCap - esg.effective)
  if (esgRoomFull > 1000) {
    const sized = thbHeavy ? esgRoomFull * 0.25 : esgRoomFull
    const amount = roundDown1k(Math.min(sized, dryPowderThb))
    if (amount >= 1000) {
      const fund = fundFacts.find((f) => f.category === 'thaiesg')
      recs.push({
        id: 'rec-thaiesg',
        category: 'thaiesg',
        categoryLabel: CATEGORY_LABELS.thaiesg,
        fund: fund?.ticker ?? 'ThaiESG',
        fundLabel: fund?.label ?? 'ThaiESG fund',
        amountTHB: amount,
        conviction: thbHeavy ? 'medium' : 'high',
        taxWhy: `${fmt0(esgRoomFull)} of ThaiESG room remains (cap ฿300,000, separate from the retirement combo).${
          thbHeavy ? ' Sized below the available room — see investing rationale.' : ' Topping an existing holding avoids product sprawl.'
        }`,
        investWhy: thbHeavy
          ? `Deliberately sized BELOW the ${fmt0(
              esgRoomFull,
            )} available room: ThaiESG funds are Thai-equity-heavy and the book is already ${pct0(
              allocation.thbNativePct,
            )} THB-native. The tax saving does not justify maxing this category.`
          : `The book has room for more Thai-equity exposure — topping an existing ThaiESG holding captures the deduction without adding a new product.`,
        caveat: fund?.note ?? '5-year lock per lot. Fund facts are illustrative — verify before buying.',
      })
    }
  }

  // --- 3. Health insurance -------------------------------------------------
  const health = plan.contributions.health_insurance
  const healthRoom = Math.max(0, health.ownCap - health.effective)
  if (healthRoom > 0) {
    const amount = Math.min(healthRoom, dryPowderThb)
    if (amount > 0) {
      recs.push({
        id: 'rec-health',
        category: 'health_insurance',
        categoryLabel: CATEGORY_LABELS.health_insurance,
        fund: '—',
        fundLabel: 'Self health-insurance premium',
        amountTHB: Math.round(amount),
        conviction: 'medium',
        taxWhy: `Fills the ${fmt0(LIMITS_HEALTH_CAP)} health cap (inside the ฿100,000 life+health combined ceiling).`,
        investWhy: 'Not an investment — protection with a deduction attached. Cheapest real risk-reduction per baht in the plan.',
        caveat: 'Confirm the policy actually covers you before buying for the deduction — coverage terms are not modeled here.',
      })
    }
  }

  return recs
}

const LIMITS_HEALTH_CAP = 25_000

/* --------------------------------- flags ------------------------------------ */

export interface AgentFlag {
  level: 'critical' | 'warning' | 'info'
  title: string
  detail: string
}

/** Things a senior Thai-tax agent would raise before any purchase. Built from
 *  real numbers passed in (not hardcoded samples) — the ThaiESG proxy value
 *  and PFM009 balance below come from the real portfolio snapshot. */
export function buildAgentFlags(args: { pfm009ValueThb: number; thaiEsgProxyThb: number }): AgentFlag[] {
  return [
    {
      level: 'warning',
      title: 'PFM009 is a confirmed provident fund (PVD)',
      detail: `PFM009 (${fmt0(
        args.pfm009ValueThb,
      )}, "Social Security Fund (KBank)") is confirmed as a PVD position — its 2026 employee contributions consume the shared ฿500,000 retirement combo cap, wired into the Provident fund row below. However this system doesn't track per-year PVD contribution history yet (only the cumulative balance) — 2026 YTD contribution starts at ฿0 here; enter your actual 2026 contribution manually if you know it.`,
    },
    {
      level: 'warning',
      title: 'ThaiESG "contributed" is a proxy, not a fact',
      detail: `${fmt0(
        args.thaiEsgProxyThb,
      )} shown as used ThaiESG room is the CURRENT VALUE of the two ThaiESG positions, not 2026 purchase cost. Deduction room is consumed by cost of this year's buys — computing that needs trade history (backend gap; the portfolio snapshot only carries current value).`,
    },
    {
      level: 'info',
      title: 'SSF is closed — ignore older guides',
      detail:
        "The SSF deduction lapsed after tax year 2024; existing lots still carry their 10-year hold. ThaiESG (with its 2024–2026 ฿300,000-cap window) replaced it. No SSF row on this page, by design.",
    },
    {
      level: 'info',
      title: 'Remitting foreign money home is a tax event',
      detail:
        'Under Por. 161/2566, foreign-source income remitted to Thailand while you are a Thai tax resident is assessable in the year remitted. Plan the timing of moving any foreign brokerage/salary money back — this page does not model remittance timing.',
    },
    {
      level: 'info',
      title: 'Easy E-Receipt has no confirmed 2026 round',
      detail:
        'The annual shopping-stimulus deduction (last seen as Easy E-Receipt 2.0, ฿50,000, for purchases Jan 16 – Feb 28 2025) has no announced round for calendar-year-2026 purchases as of this check. No row is counted until one is announced.',
    },
  ]
}
