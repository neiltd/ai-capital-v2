// Loader contract for /portfolio.
// Source: scenario-simulator/data/simulation.json (portfolio + usdThb).
// Sample below is the real 2026-07-06 portfolio (16 positions incl. cash).

import type { Position } from '../_shared/types'

/* ------------------- agent view of the REAL portfolio --------------------- */
// The investment agent's live thinking about Neil's ACTUAL holdings —
// positioning belief, next planned action, and what it would do under each
// briefing scenario. The SAME scenario set + probabilities the Briefing
// renders (see ../briefing/data.ts) — cross-linked, not duplicated, so
// /portfolio and /today can never tell two different stories about the same
// day. In the real app both screens read the same simulation.json + briefing
// envelope; never fork it. (The discovery agent's paper book has its own,
// separate self-view on /discover.)

export interface AgentScenarioView {
  id: string
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  probability: number
  timeHorizon: string
  /** What the agent plans to DO to the real book if this scenario plays out. */
  plannedResponse: string
}

export interface AgentPortfolioView {
  briefingDate: string
  /** Current belief about positioning — regime + book state in one line. */
  positioning: string
  /** The next action the agent intends to take, portfolio-wide. */
  nextPlannedAction: string
  scenarios: AgentScenarioView[]
  /** The briefing's calibration self-note — shown wherever the agent opines. */
  calibrationNote: string
}

export interface PortfolioViewModel {
  exportedAt: string
  usdThb: number
  positions: Position[]
  /** GAP #2/#3: previous-close per symbol + 30d portfolio series (sparklines, day change). */
  dayChangeUsd: number | null
  netWorthSeries30d: number[] | null
  /** GAP #6: target allocation config from the financial plan (drift bars). */
  targets: Partial<Record<'us_equity' | 'th_equity' | 'th_fund' | 'gold' | 'cash', number>> | null
  agentView: AgentPortfolioView
}

export async function loadPortfolio(): Promise<PortfolioViewModel> {
  return {
    exportedAt: '2026-07-06T23:34:28.000Z',
    usdThb: 33.25,
    positions: SAMPLE_POSITIONS,
    dayChangeUsd: null, // render "—" with a tooltip until backend gap #3 lands
    netWorthSeries30d: null,
    targets: { us_equity: 0.45, th_equity: 0.11, th_fund: 0.2, gold: 0.05, cash: 0.125 },
    agentView: AGENT_VIEW,
  }
}

// Real 2026-07-06 briefing content, restated as "what the agent believes /
// plans / would do" about the REAL book.
const AGENT_VIEW: AgentPortfolioView = {
  briefingDate: '2026-07-06',
  positioning:
    'Regime: AI Acceleration + Defense Tech Bid (medium confidence). The real book is overweight AOT.BK (37% of priced portfolio, −$1,597 underwater against a 44.8 consumer-sentiment tourism headwind), with gold and cash sized for the 30% disruption scenario. Three trims are pending — new exposure competes with those trim proceeds, not with idle cash.',
  nextPlannedAction:
    'Execute the pending trims first (AOT.BK −22%, SCBCEH −50%, PLTR −17%) before opening any new real position; respect the CRWD/UNH wash-sale windows (07-08 / 07-15) on any rebuy.',
  scenarios: [
    {
      id: 's1',
      scenarioType: 'best',
      title: 'AI Capex Supercycle Breaks Escape Velocity',
      probability: 0.22,
      timeHorizon: '3-6mo',
      plannedResponse:
        'Reverse the PLTR trim, extend NET/CRWD exposure once wash-sale windows clear, and promote the discovery agent’s strongest paper names to real positions.',
    },
    {
      id: 's2',
      scenarioType: 'base',
      title: 'AI Grind Higher — Geopolitical Friction Persists',
      probability: 0.48,
      timeHorizon: '3-6mo',
      plannedResponse:
        'Complete the AOT.BK / SCBCEH / PLTR trims; keep DCA schedules (K-VIETNAM, KFINDIA-A) unchanged; hold the winners (LLY, GULF.BK, SCB.BK).',
    },
    {
      id: 's3',
      scenarioType: 'disruption',
      title: 'Geopolitical Shock Fractures AI Trade',
      probability: 0.3,
      timeHorizon: '1-4mo',
      plannedResponse:
        'Add to GOLD_OZ, accelerate the AOT.BK trim, and halt all new equity buys and discovery promotions until the shock resolves.',
    },
  ],
  calibrationNote:
    'HIGH-conviction calls running at 37% accuracy (18.5pp below medium) — all HIGH labels downgraded one level today. TRIM remains the strongest edge at 76.5% (7d).',
}

const P = (
  ticker: string,
  company: string,
  shares: number,
  avgCost: number,
  currentPrice: number,
  assetClass: Position['assetClass'],
  currency: Position['currency'],
  strategy: Position['strategy'],
): Position => ({
  ticker,
  company,
  shares,
  avgCost,
  currentPrice,
  currentValue: shares * currentPrice,
  unrealizedPnl: shares * (currentPrice - avgCost),
  updatedAt: '2026-07-06T23:34:28.000Z',
  assetClass,
  currency,
  priceSymbol: ticker,
  strategy,
})

export const SAMPLE_POSITIONS: Position[] = [
  P('AOT.BK', 'Airports of Thailand', 5000, 74.88, 64.25, 'th_equity', 'THB', 'tactical'),
  P('SCB.BK', 'SCB X', 500, 112.0, 148.5, 'th_equity', 'THB', 'tactical'),
  P('GULF.BK', 'Gulf Energy Development', 1400, 45.3, 47.9, 'th_equity', 'THB', 'tactical'),
  P('LLY', 'Eli Lilly', 4.6, 640.2, 795.8, 'us_equity', 'USD', 'tactical'),
  P('CRWD', 'CrowdStrike', 3.1, 1046.0, 642.2, 'us_equity', 'USD', 'tactical'),
  P('PLTR', 'Palantir', 11.2, 178.3, 173.75, 'us_equity', 'USD', 'tactical'),
  P('NET', 'Cloudflare', 7.4, 202.9, 203.05, 'us_equity', 'USD', 'tactical'),
  P('PFM009', 'Social Security Fund', 1, 13731, 13731, 'th_fund', 'THB', 'tax_locked'),
  P('K-ESGSI-THAIESG', 'K ESG SI ThaiESG', 3200, 9.8, 10.1, 'th_fund', 'THB', 'tax_locked'),
  P('K-TNZ-THAIESG', 'K Target Net Zero ThaiESG', 2800, 9.6, 9.9, 'th_fund', 'THB', 'tax_locked'),
  P('SCBCEH', 'SCB China Equity', 16932.44, 9.41, 8.16, 'th_fund', 'THB', 'dca'),
  P('KFINDIA-A', 'Krungsri India Equity', 2883.75, 13.9, 11.34, 'th_fund', 'THB', 'dca'),
  P('K-VIETNAM', 'K Vietnam Equity', 5100, 10.2, 9.7, 'th_fund', 'THB', 'dca'),
  P('GOLD_OZ', 'Physical gold (MTS)', 0.4, 3100, 3288, 'gold', 'USD', 'tactical'),
  P('CASH_USD', 'USD cash', 14519.13, 1, 1, 'cash', 'USD', 'tactical'),
  P('CASH_THB', 'THB cash', 421813, 1, 1, 'cash', 'THB', 'tactical'),
]
