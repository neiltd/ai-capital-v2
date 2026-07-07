// Loader contract for /discover.
// Source: scenario-simulator/data/discovery.json (weekly, Sundays).
// Paper portfolio rows below are real 2026-07-05 values; the candidate is
// illustrative (candidates[] was empty in the latest run) — the queue UI is
// designed for the populated case, with an empty state.

import type { DiscoveryCandidate, DiscoveryHolding } from '../_shared/types'

/* ------------------------------ sizing model ------------------------------ */
// Mirrors scenario-simulator/src/cli/cli-discover.ts exactly:
//   CASH_RESERVE_PCT = 0.20; maxDeployable = BUDGET × 0.8
//   band: score ≥ 90 → 12% · ≥ 80 → 8% · else 5% (of maxDeployable, NOT remaining)
//   allocated = min(nominal, remaining) — never exceeds budget.

export interface SizingRationale {
  score: number
  paperBudget: number
  cashReservePct: number
  maxDeployable: number
  bandPct: number
  nominalUsd: number
  deployedUsd: number // deployed at sizing time (open positions' cost basis)
  remainingUsd: number
  allocatedUsd: number
  cappedByRemaining: boolean
  blocked: boolean // allocated ≈ 0 — budget limit reached, agent skips
}

export function computeSizing(
  score: number,
  deployedUsd: number,
  config: { paperBudget: number; cashReservePct: number },
): SizingRationale {
  const maxDeployable = config.paperBudget * (1 - config.cashReservePct)
  const bandPct = score >= 90 ? 0.12 : score >= 80 ? 0.08 : 0.05
  const nominalUsd = maxDeployable * bandPct
  const remainingUsd = Math.max(0, maxDeployable - deployedUsd)
  const allocatedUsd = Math.min(nominalUsd, remainingUsd)
  return {
    score,
    paperBudget: config.paperBudget,
    cashReservePct: config.cashReservePct,
    maxDeployable,
    bandPct,
    nominalUsd,
    deployedUsd,
    remainingUsd,
    allocatedUsd,
    cappedByRemaining: allocatedUsd < nominalUsd - 0.5,
    blocked: allocatedUsd < 1,
  }
}

/* ------------------ agent's OWN book view (self-contained) ----------------- */
// The discovery agent's thinking about ITS OWN paper book: why it holds what
// it holds, how concentrated the book is by sub-theme, what the next Sunday
// screen is hunting for, and what would make it exit a paper position.
// Deliberately self-contained — no reference to the real portfolio, its risk
// metrics, or the briefing's scenarios. (The investment agent's view of the
// REAL portfolio lives on /portfolio, cross-linked with /today.)
// Source: discovery.json + discovery_runs (simulation.db).

export interface BookTheme {
  theme: string
  tickers: string[]
  /** Cost basis committed to the theme (Σ shares × avgCost). */
  costUsd: number
}

export interface ExitTrigger {
  kind: 'thesis' | 'score' | 'drawdown' | 'time'
  rule: string
}

export interface AgentBookView {
  /** The paper book's own positioning logic — one paragraph, book-scoped. */
  positioning: string
  /** Sub-theme concentration WITHIN the paper book (sums to deployed cost). */
  themes: BookTheme[]
  /** What the next Sunday screen is watching for. */
  watching: string[]
  /** What would trigger exiting current paper positions. */
  exitTriggers: ExitTrigger[]
  /** Honesty note: exits are stated intent only until the backend can close. */
  exitNote: string
}

/** Per-candidate fit against the agent's OWN existing paper book — a
 *  candidate is never judged in isolation, but the yardstick is the book's
 *  own concentration, not the briefing's scenarios. */
export interface BookFit {
  theme: string
  overlap: 'stacks' | 'adjacent' | 'new'
  note: string
}

export type CandidateVM = DiscoveryCandidate & {
  sizing: SizingRationale
  bookFit: BookFit[]
}

export type HoldingVM = DiscoveryHolding & { sizing: SizingRationale }

/* --------------------- decision-quality data (Task 3b) --------------------- */
// Everything the "Decision quality" section needs. Two real sources today:
//   · discovery_runs (simulation.db) — the full run history, queried 2026-07-06
//   · discovery.json — the open book (all 16 positions, all still open)
// Plus two honest absences the UI must surface, not paper over:
//   · closed[] is EMPTY and cannot fill: paper-portfolio.ts has openPosition()
//     and updatePrices() but no closePosition() — exits are unimplemented.
//   · benchmark returns are null: no benchmark level was snapshotted at entry
//     (backend gap #2). SPY/SMH closes for 2026-06-02 are backfillable.

export interface DiscoveryRunRow {
  date: string
  candidatesFound: number
  passedFilter: number
  positionsOpened: number
  note?: string
}

/** Schema for the realized-trades ledger — no rows exist yet (see above). */
export interface ClosedPaperPosition {
  ticker: string
  company: string
  openedAt: string
  closedAt: string
  shares: number
  avgCost: number
  exitPrice: number
  realizedPnl: number
  scoreAtOpen: number
  exitReason: string
}

export interface DiscoveryPerformance {
  closed: ClosedPaperPosition[]
  runs: DiscoveryRunRow[]
  /** GAP #2: paper-book return vs benchmark since first open (2026-06-02). */
  benchmark: { spySinceOpen: number | null; smhSinceOpen: number | null }
  /** Tickers whose current price fails sanity checks — excluded from stats
   *  with an explicit annotation, never silently. */
  suspectTickers: string[]
}

export interface DiscoveryViewModel {
  exportedAt: string
  nextRunAt: string // Sundays — GAP: expose schedule from queue jobs
  config: { threshold: number; paperBudget: number; cashReservePct: number; newsDays: number }
  candidates: CandidateVM[]
  holdings: HoldingVM[]
  /** Deployed cost basis of the open paper book (Σ shares × avgCost). */
  deployedUsd: number
  bookView: AgentBookView
  performance: DiscoveryPerformance
  /** GAP #2: paper portfolio daily value series vs SPY for the performance strip. */
  paperSeries30d: number[] | null
}

export async function loadDiscovery(): Promise<DiscoveryViewModel> {
  const config = { threshold: 70, paperBudget: 20184.73, cashReservePct: 0.2, newsDays: 7 }

  const holdings = [
      h('NVDA', 'NVIDIA Corporation', 8.6313, 224.5, 194.83, 95, '2026-06-02', 'Dominant AI accelerator share; central to every layer of the stack.'),
      h('TSM', 'Taiwan Semiconductor', 2.9079, 444.24, 434.16, 88, '2026-06-02', 'Irreplaceable foundry for all leading AI chips; moat outweighs geopolitical risk.'),
      h('AVGO', 'Broadcom', 2.6956, 479.24, 360.45, 85, '2026-06-02', 'Custom AI ASIC (XPU) acceleration + networking silicon dominance.'),
      h('ASML', 'ASML Holding', 0.7678, 1682.56, 1769.32, 82, '2026-06-02', 'EUV monopoly; structurally indispensable under export stress.'),
      h('ANET', 'Arista Networks', 7.417, 174.17, 159.99, 80, '2026-06-02', 'Ethernet winning AI fabric share from InfiniBand.'),
      h('MRVL', 'Marvell Technology', 4.5581, 283.41, 245.29, 80, '2026-06-02', 'Custom silicon + high-speed networking tied to AI buildout.'),
      h('MU', 'Micron Technology', 0.7735, 1043.76, 975.56, 79, '2026-06-02', 'HBM3E pricing power; share gains vs SK Hynix.'),
      h('VRT', 'Vertiv Holdings', 2.4135, 334.53, 300.53, 76, '2026-06-02', 'Power/thermal is the AI density bottleneck; order backlog.'),
      h('ORCL', 'Oracle', 3.312, 243.78, 140.27, 76, '2026-06-02', 'OCI AI buildout with sovereign contracts.'),
      h('CEG', 'Constellation Energy', 1.7768, 272.65, 239.25, 74, '2026-06-03', 'Nuclear power-for-AI angle (Three Mile Island restart).'),
      h('GOOG', 'Alphabet', 2.2188, 363.878, 356.18, 74, '2026-06-02', 'TPU silicon + Gemini leadership at reasonable valuation.'),
      h('AMAT', 'Applied Materials', 1.6819, 480.04, 603.04, 74, '2026-06-02', 'Broad equipment exposure to AI-driven fab investment.'),
      h('KLAC', 'KLA Corporation', 0.4031, 2003.1, 235.55, 73, '2026-06-02', 'Process control niche critical to advanced-node yield.'),
      h('AMZN', 'Amazon', 3.1248, 258.38, 242.67, 72, '2026-06-02', 'Trainium/Inferentia custom silicon + dominant cloud.'),
      h('MPWR', 'Monolithic Power', 0.5045, 1600.28, 1288.16, 72, '2026-06-02', 'Power management ICs for accelerator density.'),
      h('LRCX', 'Lam Research', 2.4468, 329.98, 351.41, 71, '2026-06-02', 'Etch/deposition for HBM and advanced packaging.'),
  ]

  // Deployed = Σ cost basis of the open book. With these real 2026-07-05
  // values the book is EXACTLY at the cap ($16,147.77 of $16,147.78) — CEG
  // was the position that hit it (sized $484 = the remaining budget, below
  // its 5% band of $807). The sizing UI must make that legible.
  const deployedUsd = holdings.reduce((s, x) => s + x.shares * x.avgCost, 0)

  // Per-holding sizing at open time: replay deployment in openedAt order so
  // each position shows the budget state it was actually sized against.
  const holdingsVm: HoldingVM[] = []
  let running = 0
  for (const x of [...holdings].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || b.score - a.score)) {
    holdingsVm.push({ ...x, sizing: computeSizing(x.score, running, config) })
    running += x.shares * x.avgCost
  }

  return {
    exportedAt: '2026-07-05T20:10:21.000Z',
    nextRunAt: '2026-07-12T00:00:00.000Z',
    config,
    deployedUsd,
    candidates: [
      {
        ticker: 'VST',
        company: 'Vistra Corp',
        score: 78,
        bearScore: 41,
        conviction: 'medium',
        currentPrice: 141.2,
        recommendation: 'BUY (paper)',
        rationale:
          'Independent power producer with nuclear + gas fleet directly levered to AI data-center demand; PJM capacity auction pricing provides a named near-term catalyst.',
        bearRationale:
          'Valuation already re-rated 3x since 2024; capacity auction upside is consensus; regulatory intervention risk on power prices if consumer bills spike.',
        sizing: computeSizing(78, deployedUsd, config),
        bookFit: [
          {
            theme: 'Power & thermal',
            overlap: 'stacks',
            note: 'CEG + VRT + MPWR are already 13.0% of book cost; adding merchant power makes power-for-AI the book’s second-largest theme.',
          },
          {
            theme: 'AI demand driver',
            overlap: 'adjacent',
            note: 'Same underlying bet as the whole book (data-center buildout) — VST adds no thesis diversification, only a different regulatory surface than nuclear CEG.',
          },
          {
            theme: 'Sector',
            overlap: 'new',
            note: 'First utility-sector name; the only candidate that dilutes the book’s 15-of-16 tech concentration — but it is budget-blocked until a position closes.',
          },
        ],
      },
    ],
    holdings: holdingsVm,
    bookView: BOOK_VIEW,
    performance: PERFORMANCE,
    paperSeries30d: null,
  }
}

// The discovery agent's own book-level thinking. Everything here is derived
// from the paper book itself (discovery.json + discovery_runs) — theme sums
// are real cost-basis aggregations of the 16 open positions.
const BOOK_VIEW: AgentBookView = {
  positioning:
    'One thesis, sixteen expressions: the AI data-center buildout, held across every layer of its supply chain — accelerators, foundry, semicap equipment, memory, networking, power and the hyperscalers buying it all. The whole book was opened in a single screen (Jun 2–3) and is fully deployed at the 80% cap, so the book is currently a bet that the Jun 2 cohort was picked well, not an evolving selection.',
  themes: [
    { theme: 'Compute & custom silicon', tickers: ['NVDA', 'AVGO', 'MRVL'], costUsd: 4521.38 },
    { theme: 'Semicap equipment', tickers: ['ASML', 'AMAT', 'LRCX', 'KLAC'], costUsd: 3714.1 },
    { theme: 'Hyperscalers & cloud', tickers: ['GOOG', 'AMZN', 'ORCL'], costUsd: 2422.16 },
    { theme: 'Power & thermal', tickers: ['VRT', 'MPWR', 'CEG'], costUsd: 2099.17 },
    { theme: 'Foundry', tickers: ['TSM'], costUsd: 1291.81 },
    { theme: 'Networking', tickers: ['ANET'], costUsd: 1291.82 },
    { theme: 'Memory', tickers: ['MU'], costUsd: 807.35 },
  ],
  watching: [
    'Names outside the AI-infra cluster that still clear the 70 bar — the last four screens found only already-held names (93 candidates, 0 passed the filter).',
    'Budget headroom: every new open is $0-blocked until a position closes; the screen is effectively read-only until exits exist.',
    'Score decay on held names: ORCL (−42.5%) and AVGO (−24.8%) would not clear a re-score today — re-scoring open positions is the first exit signal.',
  ],
  exitTriggers: [
    { kind: 'thesis', rule: 'Rationale invalidated — the specific catalyst named at open (e.g. ORCL’s OCI sovereign contracts) is contradicted by news, not just price.' },
    { kind: 'score', rule: 'Weekly re-score drops a holding below the 70 open-threshold — exit at the next run rather than hold un-openable positions.' },
    { kind: 'drawdown', rule: '−25% vs cost with no thesis-confirming news in the trailing 7-day window (would flag AVGO −24.8% and ORCL −42.5% today).' },
    { kind: 'time', rule: '90 days without the named catalyst materializing — dead-money release back to budget.' },
  ],
  exitNote:
    'Stated intent only: paper-portfolio.ts has no closePosition() — the agent literally cannot exit today. Until that lands, these triggers are what the agent WOULD do, and the book stays frozen at the cap.',
}

// Real values queried from simulation.db::discovery_runs on 2026-07-06.
const PERFORMANCE: DiscoveryPerformance = {
  closed: [], // zero closed positions ever — see interface comment
  runs: [
    { date: '2026-06-02', candidatesFound: 64, passedFilter: 19, positionsOpened: 15, note: 'initial cohort — 15 opens in one run' },
    { date: '2026-06-03', candidatesFound: 49, passedFilter: 6, positionsOpened: 1, note: '+CEG at $484 (capped) — budget cap reached' },
    { date: '2026-06-13', candidatesFound: 92, passedFilter: 0, positionsOpened: 0 },
    { date: '2026-06-14', candidatesFound: 92, passedFilter: 0, positionsOpened: 0 },
    { date: '2026-06-21', candidatesFound: 93, passedFilter: 0, positionsOpened: 0 },
    { date: '2026-06-28', candidatesFound: 93, passedFilter: 0, positionsOpened: 0 },
    { date: '2026-07-05', candidatesFound: 93, passedFilter: 0, positionsOpened: 0, note: 'ran twice (14:05 + 20:10 UTC)' },
    { date: '2026-07-05', candidatesFound: 93, passedFilter: 0, positionsOpened: 0 },
  ],
  benchmark: { spySinceOpen: null, smhSinceOpen: null },
  suspectTickers: ['KLAC'],
}

function h(
  ticker: string,
  company: string,
  shares: number,
  avgCost: number,
  currentPrice: number,
  score: number,
  openedAt: string,
  rationale: string,
): DiscoveryHolding {
  return {
    ticker,
    company,
    shares,
    avgCost,
    currentPrice,
    currentValue: shares * currentPrice,
    unrealizedPnl: shares * (currentPrice - avgCost),
    openedAt,
    score,
    rationale,
  }
}
