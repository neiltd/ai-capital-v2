// Sample data for the Thai Tax Planner mockup.
//
// EVERYTHING here is placeholder shaped like what the real agent would emit.
// Holdings tie-in values are the REAL positions from simulation.json
// (2026-07-08 snapshot) so the review reads against the actual book; the
// income figure, YTD contribution amounts, and fund facts (expense ratios,
// returns) are SAMPLES — clearly labeled in the UI.
//
// Production source of truth this mocks:
//   - profile/income: new user-config (does not exist yet — backend gap)
//   - YTD contributions: needs trade history per ticker (backend gap — the
//     snapshot only carries current value, not this-year's buys)
//   - advisor output: a new LLM agent (same pattern as studio/agent.ts) fed
//     the tax engine's numbers + portfolio + a fund-facts table

import type { ContribId, HouseholdProfile } from './tax-engine'

export const TAX_YEAR = 2026
export const USD_THB = 33.45 // simulation.json FX, shown for USD-secondary values

/** SAMPLE household — income is a placeholder the user adjusts live. */
export const SAMPLE_PROFILE: HouseholdProfile = {
  assessableIncome: 1_200_000,
  spouseNoIncome: false,
  children: 0,
  dependentParents: 0,
}

/** Contributions already made in 2026 (committed — the user can't un-buy).
 *  ThaiESG figure = current value of the two THAIESG positions; the real
 *  agent must replace this with actual 2026 purchase cost from trade history. */
export const USED_2026: Partial<Record<ContribId, number>> = {
  thaiesg: 26_857, // K-ESGSI-THAIESG ฿12,345 + K-TNZ-THAIESG ฿14,512 (proxy — see flag)
  social_security: 4_500, // SAMPLE — needs payroll data
  provident_fund: 0, // pending PFM009 classification (see flag)
}

/** Real positions that feed the planner (from simulation.json 2026-07-08). */
export interface TaxHolding {
  ticker: string
  label: string
  category: ContribId | null
  valueTHB: number
  strategy: 'tax_locked' | 'dca' | 'tactical'
  note: string
}

export const TAX_HOLDINGS: TaxHolding[] = [
  {
    ticker: 'K-ESGSI-THAIESG',
    label: 'K ESG Strategic Innovation (ThaiESG)',
    category: 'thaiesg',
    valueTHB: 12_345,
    strategy: 'tax_locked',
    note: 'ThaiESG — 5-year lock for deduction eligibility; never sell early.',
  },
  {
    ticker: 'K-TNZ-THAIESG',
    label: 'K Target Net Zero (ThaiESG)',
    category: 'thaiesg',
    valueTHB: 14_512,
    strategy: 'tax_locked',
    note: 'ThaiESG — 5-year lock; candidate for top-ups (no new product sprawl).',
  },
  {
    ticker: 'PFM009',
    label: 'Social Security Fund (KBank)',
    category: null, // classification unresolved — see agent flag
    valueTHB: 457_141,
    strategy: 'tax_locked',
    note: 'Largest locked position. PVD vs SSO classification decides whether its 2026 inflows consume the ฿500k retirement combo cap.',
  },
]

/** Liquidity available for tax-fund purchases (real cash positions). */
export const DRY_POWDER_THB = 421_813
export const DRY_POWDER_USD = 14_519

/* ------------------------------ advisor output ---------------------------- */

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

/** SAMPLE agent run — in production this is generated per-run by the advisor
 *  agent with live fund facts; every figure below is illustrative. */
export const ADVISOR_RUN = {
  generatedAt: '2026-07-08T07:42:00+07:00',
  inputsNote: 'inputs: portfolio snapshot · 2026 RD rule table (tax-engine) · fund-facts table',
  recs: [
    {
      id: 'rec-rmf-global',
      category: 'rmf',
      categoryLabel: 'RMF',
      fund: 'KGARMF',
      fundLabel: 'K Global Allocation RMF',
      amountTHB: 120_000,
      conviction: 'high',
      taxWhy:
        'RMF room is completely unused (cap 30% of income, shared ฿500k retirement ceiling). This purchase deducts in full.',
      investWhy:
        'Your book is ~66% THB assets and only ~12% US equity — a global-allocation RMF adds the diversification the book lacks, and the hold-to-55 lock matches a retirement horizon rather than fighting it.',
      caveat:
        'Fund facts (expense ratio, track record) are sample values — the production agent pulls a live fund-facts table. Verify ticker/class before buying.',
    },
    {
      id: 'rec-thaiesg-topup',
      category: 'thaiesg',
      categoryLabel: 'ThaiESG',
      fund: 'K-TNZ-THAIESG',
      fundLabel: 'K Target Net Zero (existing holding)',
      amountTHB: 60_000,
      conviction: 'medium',
      taxWhy:
        '฿273k of ThaiESG room remains (cap ฿300k, separate from the retirement combo). Topping an existing holding avoids product sprawl.',
      investWhy:
        'Deliberately sized BELOW the available room: ThaiESG funds are Thai-equity-heavy and the book is already Thailand-concentrated. The tax saving does not justify maxing this category.',
      caveat: '5-year lock per lot. VERIFY the ThaiESG scheme is still open to new 2026 purchases.',
    },
    {
      id: 'rec-health',
      category: 'health_insurance',
      categoryLabel: 'Health insurance',
      fund: '—',
      fundLabel: 'Self health-insurance premium',
      amountTHB: 25_000,
      conviction: 'medium',
      taxWhy: 'Fills the ฿25k health cap (inside the ฿100k life+health combined ceiling).',
      investWhy: 'Not an investment — protection with a deduction attached. Cheapest real risk-reduction per baht in the plan.',
      caveat: 'You are US-based until Dec 2026 — check the policy actually covers you abroad before buying for the deduction.',
    },
  ] satisfies AdvisorRec[],
}

export interface AgentFlag {
  level: 'critical' | 'warning' | 'info'
  title: string
  detail: string
}

/** Things a senior Thai-tax agent would raise before any purchase. */
export const AGENT_FLAGS: AgentFlag[] = [
  {
    level: 'critical',
    title: 'Tax residency 2026 unconfirmed',
    detail:
      'You are in LA through Dec 2026 (UCLA). Under 180 days in Thailand this calendar year makes you NON-resident — allowances/deductions then apply only against Thai-source income. Everything on this page assumes resident status until you confirm.',
  },
  {
    level: 'warning',
    title: 'PFM009 classification decides ฿500k of cap math',
    detail:
      'PFM009 (฿457k, "Social Security Fund (KBank)") — if it is a provident fund, its 2026 employee contributions consume the shared ฿500k retirement ceiling and shrink RMF room. If it is SSO, only the ฿9k social-security line applies. Needs one answer from you.',
  },
  {
    level: 'warning',
    title: 'ThaiESG "used" is a proxy, not a fact',
    detail:
      'The ฿26,857 shown as used ThaiESG room is the CURRENT VALUE of both THAIESG positions, not 2026 purchase cost. Deduction room is consumed by cost of this year\'s buys — the agent needs trade history to compute it (backend gap).',
  },
  {
    level: 'info',
    title: 'SSF is closed — ignore older guides',
    detail:
      'The SSF deduction lapsed after tax year 2024; existing lots still carry their 10-year hold. ThaiESG (and the 2025 ThaiESGX conversion window) replaced it. No SSF row on this page, by design.',
  },
  {
    level: 'info',
    title: 'Remitting US money home is now a tax event',
    detail:
      'Under Por. 161/2566, foreign-source income remitted to Thailand while you are a Thai tax resident is assessable. Plan the timing of moving US brokerage/salary money back — the agent should model this before you repatriate.',
  },
  {
    level: 'info',
    title: 'Easy E-Receipt 2026 unannounced',
    detail:
      'The annual shopping-stimulus deduction (฿50k in 2025) has no confirmed 2026 round in the system yet. The agent watches for the announcement; no row is counted until then.',
  },
]

/** The plan the "Apply advisor plan" button loads. */
export const ADVISOR_PLAN: Partial<Record<ContribId, number>> = {
  rmf: 120_000,
  thaiesg: 60_000,
  health_insurance: 25_000,
}
