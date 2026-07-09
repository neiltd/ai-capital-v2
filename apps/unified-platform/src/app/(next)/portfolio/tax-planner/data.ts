// Loader for /portfolio/tax-planner. Real disk reads via loadPortfolio()
// (server component, no client fetch) — same convention as /portfolio and
// /portfolio/risk. Wires the real Position[] book into the tax engine and
// advisor-engine rather than fabricating sample holdings.
//
// Real vs. illustrative, spelled out (see also advisor-engine.ts and the
// per-field comments below):
//   - positions, cash, allocation %s, FX      → real (scenario-simulator's
//                                                 simulation.json)
//   - PFM009 classification (PVD)             → real, human-confirmed
//   - ThaiESG "used" amount                    → real position VALUE used as
//                                                 a documented proxy for 2026
//                                                 purchase cost (backend gap
//                                                 — no trade history yet)
//   - PVD "used" amount                        → not trackable yet, starts
//                                                 at ฿0 (flagged)
//   - income / household profile               → user enters live; no
//                                                 payroll feed for v1
//   - fund facts (expense ratio, track record) → SAMPLE/illustrative, v1

import { loadPortfolio } from '../data'
import { CLASS_META, CLASS_ORDER } from '../class-meta'
import type { ContribId, HouseholdProfile } from './tax-engine'
import {
  computeAllocation,
  buildAgentFlags,
  FUND_FACTS,
  type AllocationSummary,
  type FundFact,
  type AgentFlag,
} from './advisor-engine'
import type { Position } from '@/lib/next/types'

export const TAX_YEAR = 2026

export interface TaxHolding {
  ticker: string
  label: string
  category: ContribId
  valueTHB: number
  strategy: Position['strategy']
  note: string
}

const HOLDING_META: Record<string, { category: ContribId; label: string; note: string }> = {
  'K-ESGSI-THAIESG': {
    category: 'thaiesg',
    label: 'K ESG Strategic Innovation (ThaiESG)',
    note: 'ThaiESG — 5-year lock for deduction eligibility; never sell early.',
  },
  'K-TNZ-THAIESG': {
    category: 'thaiesg',
    label: 'K Target Net Zero (ThaiESG)',
    note: 'ThaiESG — 5-year lock; candidate for top-ups (no new product sprawl).',
  },
  PFM009: {
    category: 'provident_fund',
    label: 'Social Security Fund (KBank)',
    note: 'Confirmed provident fund (PVD) — 2026 employee contributions consume the shared ฿500,000 retirement combo cap. 2026 YTD contribution amount is not tracked (only cumulative balance); enter it in the Provident fund row below if known.',
  },
}

export interface TaxPlannerViewModel {
  asOf: string
  usdThb: number
  defaultProfile: HouseholdProfile
  taxHoldings: TaxHolding[]
  dryPowderThb: number
  dryPowderUsd: number
  used2026: Partial<Record<ContribId, number>>
  allocation: AllocationSummary
  fundFacts: FundFact[]
  agentFlags: AgentFlag[]
}

export function loadTaxPlanner(): TaxPlannerViewModel {
  const portfolio = loadPortfolio()
  const { positions, usdThb, exportedAt } = portfolio

  const taxHoldings: TaxHolding[] = positions
    .filter((p): p is Position & { ticker: keyof typeof HOLDING_META } => p.ticker in HOLDING_META)
    .map((p) => ({
      ticker: p.ticker,
      label: HOLDING_META[p.ticker].label,
      category: HOLDING_META[p.ticker].category,
      valueTHB: p.currentValue,
      strategy: p.strategy,
      note: HOLDING_META[p.ticker].note,
    }))

  const thaiEsgProxyThb = taxHoldings
    .filter((h) => h.category === 'thaiesg')
    .reduce((s, h) => s + h.valueTHB, 0)
  const pfm009 = taxHoldings.find((h) => h.category === 'provident_fund')

  const cashThb = positions.find((p) => p.ticker === 'CASH_THB')
  const cashUsd = positions.find((p) => p.ticker === 'CASH_USD')

  const used2026: Partial<Record<ContribId, number>> = {
    thaiesg: Math.round(thaiEsgProxyThb),
    provident_fund: 0, // real 2026 contribution not tracked — see agent flag
  }

  const allocation = computeAllocation(positions, usdThb, CLASS_META, CLASS_ORDER, portfolio.targets)

  const agentFlags = buildAgentFlags({
    pfm009ValueThb: pfm009?.valueTHB ?? 0,
    thaiEsgProxyThb,
  })

  return {
    asOf: exportedAt,
    usdThb,
    defaultProfile: {
      assessableIncome: 0, // manual entry, v1 — no payroll feed
      spouseNoIncome: false,
      children: 0,
      dependentParents: 0,
    },
    taxHoldings,
    dryPowderThb: cashThb?.currentValue ?? 0,
    dryPowderUsd: cashUsd?.currentValue ?? 0,
    used2026,
    allocation,
    fundFacts: FUND_FACTS,
    agentFlags,
  }
}
