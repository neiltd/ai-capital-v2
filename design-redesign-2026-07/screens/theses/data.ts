// Loader contract for /portfolio/theses.
//
// Sources:
//   - thesis-memory (SQLite/agentdb): Thesis / Assumption / Narrative /
//     Proposal / ProposalChange rows (see apps/thesis-memory/src/types.ts).
//     GAP #13: no export/API today — needs GET /api/theses and
//     POST /api/theses/proposals/:id/(accept|reject) with audit log.
//   - dependency-graph-engine/data/graph.json: relationship edges
//     (supply_chain / customer / competitive / technology) + theme
//     memberships — powers the "Related names" panel so adjacent tickers
//     surface automatically instead of requiring prior knowledge.
//
// Sample values are grounded in the real 2026-07-06 state: held tickers and
// their briefing thesis-status language, the CRWD/UNH July sales (wash-sale
// windows), the exited NVO/META watchlist theses, and the actual graph.json
// edge set (exported 2026-07-03).

export type ThesisStatus = 'strengthening' | 'stable' | 'mixed' | 'weakening' | 'broken'
export type AssumptionStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'
export type PositionSize = 'core' | 'satellite' | 'watchlist' | 'none'

export interface ThesisAssumption {
  label: string
  status: AssumptionStatus
  lastEvidence: string | null
}

export interface ThesisStatusEvent {
  date: string
  status: ThesisStatus
  note: string
  evidenceQuote?: string
  source?: string
}

export interface ThesisRow {
  ticker: string
  company: string
  kind: 'company' | 'theme'
  positionSize: PositionSize
  held: boolean
  /** Set only for previously-held/closed positions — history is memory. */
  closed?: { exitedAt: string; realizedPnlUsd: number; exitReason: string }
  status: ThesisStatus
  /** One-line core thesis for the board row. */
  core: string
  /** Full narrative (latest version) for the drawer. */
  narrative: string
  assumptions: ThesisAssumption[]
  history: ThesisStatusEvent[]
  lastReviewedAt: string
  /** Held-position context header for the drawer. */
  position?: { valueUsd: number; unrealizedPnlUsd: number }
}

export interface ThesisProposal {
  id: string
  ticker: string
  changeType: 'assumption_status' | 'narrative' | 'portfolio_action'
  oldValue: string
  newValue: string
  reasoning: string
  evidenceQuotes: string[]
  source: string
  createdAt: string
}

/* ------------------------- relationship graph data ------------------------ */

export type EdgeType = 'supply_chain' | 'customer' | 'competitive' | 'technology'
export type EdgeStrength = 'strong' | 'moderate' | 'weak'

export interface GraphEdge {
  from: string
  to: string
  type: EdgeType
  strength: EdgeStrength
  description: string
}

export interface RelatedName {
  ticker: string
  company: string
  relation: EdgeType | 'same_theme'
  strength: EdgeStrength | null
  description: string
  /** Direction of the edge relative to the ticker in view. */
  direction: 'out' | 'in' | null
  held: boolean
  paper: boolean
  hasThesis: boolean
}

export interface ThesesViewModel {
  exportedAt: string
  graphExportedAt: string
  proposals: ThesisProposal[]
  held: ThesisRow[]
  closedAndWatchlist: ThesisRow[]
  /** ticker → related names (deduped, strongest relation wins). */
  related: Record<string, RelatedName[]>
  /** Tickers with no graph coverage (graph is US AI universe only — GAP #17). */
  ungraphed: string[]
}

/* --------------------------------- loader --------------------------------- */

export async function loadTheses(): Promise<ThesesViewModel> {
  const allRows = [...HELD, ...CLOSED_WATCHLIST]
  const thesisTickers = new Set(allRows.map((r) => r.ticker))
  const heldTickers = new Set(HELD.map((r) => r.ticker))

  const related: Record<string, RelatedName[]> = {}
  const ungraphed: string[] = []
  for (const row of allRows) {
    const r = relatedFor(row.ticker, heldTickers, thesisTickers)
    if (r.length === 0 && !GRAPH_NODES.some((n) => n.ticker === row.ticker)) ungraphed.push(row.ticker)
    related[row.ticker] = r
  }

  return {
    exportedAt: '2026-07-06T23:44:56.000Z',
    graphExportedAt: '2026-07-03T06:11:37.317Z',
    proposals: PROPOSALS,
    held: HELD,
    closedAndWatchlist: CLOSED_WATCHLIST,
    related,
    ungraphed,
  }
}

/** Related names for a ticker: direct edges (both directions) + theme peers. */
export function relatedFor(
  ticker: string,
  heldTickers: Set<string>,
  thesisTickers: Set<string>,
): RelatedName[] {
  const out = new Map<string, RelatedName>()
  const company = (t: string) => GRAPH_NODES.find((n) => n.ticker === t)?.company ?? t
  const add = (t: string, rel: RelatedName) => {
    // Direct edges outrank theme co-membership; keep the first (strongest) hit.
    if (!out.has(t)) out.set(t, rel)
  }

  for (const e of GRAPH_EDGES) {
    if (e.from === ticker)
      add(e.to, {
        ticker: e.to, company: company(e.to), relation: e.type, strength: e.strength,
        description: e.description, direction: 'out',
        held: heldTickers.has(e.to), paper: PAPER_TICKERS.has(e.to), hasThesis: thesisTickers.has(e.to),
      })
    if (e.to === ticker)
      add(e.from, {
        ticker: e.from, company: company(e.from), relation: e.type, strength: e.strength,
        description: e.description, direction: 'in',
        held: heldTickers.has(e.from), paper: PAPER_TICKERS.has(e.from), hasThesis: thesisTickers.has(e.from),
      })
  }

  const myThemes = GRAPH_NODES.find((n) => n.ticker === ticker)?.themes ?? []
  for (const n of GRAPH_NODES) {
    if (n.ticker === ticker) continue
    const shared = n.themes.filter((t) => myThemes.includes(t))
    if (shared.length > 0)
      add(n.ticker, {
        ticker: n.ticker, company: n.company, relation: 'same_theme', strength: null,
        description: `Same theme: ${shared.join(', ')}`, direction: null,
        held: heldTickers.has(n.ticker), paper: PAPER_TICKERS.has(n.ticker), hasThesis: thesisTickers.has(n.ticker),
      })
  }

  // Held/paper/thesis names first, then direct edges before theme peers.
  const rank = (r: RelatedName) =>
    (r.held ? 0 : r.paper ? 1 : 2) * 10 + (r.relation === 'same_theme' ? 5 : 0)
  return [...out.values()].sort((a, b) => rank(a) - rank(b))
}

/* ----------------------------- sample theses ------------------------------ */

const HELD: ThesisRow[] = [
  {
    ticker: 'PLTR', company: 'Palantir Technologies', kind: 'company', positionSize: 'satellite', held: true,
    status: 'mixed',
    core: 'Government AI spend is structural; PLTR is the prime-contractor wedge into federal AI budgets.',
    narrative:
      'Palantir converts the defense/civil AI appropriations cycle into multi-year platform contracts (AIP + Gotham). The DHS $101M award validates the >$100M federal-AI contract thesis; NDAA FY2027 is the next structural catalyst. Valuation offers a thin cushion, so the position is sized satellite, not core.',
    assumptions: [
      { label: 'Federal AI budget cycle accelerating', status: 'strengthening', lastEvidence: 'PLTR $101M DHS win; NDAA FY2027 + NatSec appropriations advancing (briefing 07-06)' },
      { label: 'Valuation cushion adequate', status: 'weakening', lastEvidence: 'Trump PLTR sale adds sentiment overhang on a thin cushion (briefing 07-06)' },
      { label: 'Commercial AIP adoption broadening', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'mixed', note: 'TRIM −17% recommended: sentiment overhang vs strengthening federal demand.', evidenceQuote: 'NDAA still in Rules Committee, not on the floor.', source: 'briefing 2026-07-06' },
      { date: '2026-06-28', status: 'strengthening', note: 'DHS $101M award — first >$100M federal AI contract of the window.', evidenceQuote: 'PLTR $101M DHS win', source: 'govflow 30d awards' },
      { date: '2026-05-14', status: 'stable', note: 'Thesis opened at satellite size.' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 1289, unrealizedPnlUsd: -104 },
  },
  {
    ticker: 'NET', company: 'Cloudflare', kind: 'company', positionSize: 'satellite', held: true,
    status: 'strengthening',
    core: 'Zero-trust + edge AI inference winner; NDAA cyber provisions and ARM cost curve are tailwinds.',
    narrative:
      'Cloudflare compounds two theses: zero-trust security spend (NDAA cyber provisions) and edge inference economics (ARM-based fleet keeps unit costs falling). 84.6% vol at 5.6% weight is tolerable; the NDAA floor vote is a material repricing catalyst — do not trim into it.',
    assumptions: [
      { label: 'Zero-trust federal demand', status: 'strengthening', lastEvidence: 'NDAA cyber provisions advancing (briefing 07-06)' },
      { label: 'Edge-AI cost advantage (ARM fleet)', status: 'strengthening', lastEvidence: 'ARM record $737M royalty quarter — cost tailwinds' },
      { label: 'Competition from hyperscalers contained', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'strengthening', note: 'HOLD with missed-upside flag; thesis strengthening on NDAA cyber + ARM.', source: 'briefing 2026-07-06' },
      { date: '2026-06-10', status: 'stable', note: 'Volatility check: 84.6% ann. vol accepted at 5.6% weight.' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 4176, unrealizedPnlUsd: 312 },
  },
  {
    ticker: 'LLY', company: 'Eli Lilly', kind: 'company', positionSize: 'core', held: true,
    status: 'stable',
    core: 'GLP-1 demand is non-cyclical; supply, not demand, is the constraint.',
    narrative:
      'GLP-1 franchise demand is structurally supply-constrained and insensitive to the macro cycle. Strong winner (+$590). HOLD is historically a coin flip at 30d — the calibration data says do not overtrade a winner.',
    assumptions: [
      { label: 'GLP-1 demand > supply through 2027', status: 'stable', lastEvidence: null },
      { label: 'Pricing power vs NVO', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'stable', note: 'HOLD; +$590 unrealized. Calibration: HOLD ≈ coin flip at 30d.', source: 'briefing 2026-07-06' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 3890, unrealizedPnlUsd: 590 },
  },
  {
    ticker: 'AOT.BK', company: 'Airports of Thailand', kind: 'company', positionSize: 'core', held: true,
    status: 'weakening',
    core: 'Thai tourism recovery compounder — but consumer sentiment is suppressing the recovery leg.',
    narrative:
      'Post-COVID passenger volume recovery with monopoly airport economics. The thesis leg that is failing is spend-per-passenger: consumer sentiment 44.8 suppresses tourism. At 37% of the priced portfolio this is a sizing problem before it is a thesis problem — TRIM to ~28-30% is a risk action, not a thesis exit.',
    assumptions: [
      { label: 'Passenger volume recovery to 2019 levels', status: 'stable', lastEvidence: null },
      { label: 'Tourism spend per passenger recovering', status: 'weakening', lastEvidence: 'Consumer sentiment 44.8 suppresses tourism (briefing 07-06)' },
      { label: 'Regulatory concession terms stable', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'weakening', note: 'TRIM −22% (sizing): 37% of priced portfolio, −$1,597 underwater.', source: 'briefing 2026-07-06' },
      { date: '2026-06-15', status: 'mixed', note: 'Sentiment print 44.8 flagged as thesis risk.' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 9651, unrealizedPnlUsd: -1597 },
  },
  {
    ticker: 'SCBCEH', company: 'SCB China Equity (fund)', kind: 'theme', positionSize: 'satellite', held: true,
    status: 'weakening',
    core: 'China/HK re-rating on stimulus — no named catalyst has survived into any current scenario.',
    narrative:
      'The China/HK re-rating thesis depended on a stimulus catalyst that no current scenario names. When no scenario — best, base, or disruption — carries your catalyst, the thesis is unfunded by evidence. Pause contributions, evaluate deep trim; rotate toward KFINDIA-A / US broad / global REITs.',
    assumptions: [
      { label: 'Stimulus-driven re-rating catalyst', status: 'broken', lastEvidence: 'No named catalyst in any scenario (briefing 07-06)' },
      { label: 'Valuation floor at current levels', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'weakening', note: 'TRIM −50% recommended; −$286 harvestable.', source: 'briefing 2026-07-06' },
      { date: '2026-05-20', status: 'mixed', note: 'Catalyst review found no scenario support.' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 1120, unrealizedPnlUsd: -286 },
  },
  {
    ticker: 'GOLD_OZ', company: 'Physical gold', kind: 'theme', positionSize: 'core', held: true,
    status: 'strengthening',
    core: 'Geopolitical risk premium hedge — the disruption-scenario asset.',
    narrative:
      'Gold is the portfolio\'s disruption-scenario hedge: Kyiv mass strike, Lebanon escalation, and the Schnabel energy warning all sustain the risk premium. Revisit ADD if NDAA stalls or Hormuz disrupts.',
    assumptions: [
      { label: 'Geopolitical risk premium persists', status: 'strengthening', lastEvidence: 'Kyiv strike + Lebanon escalation + Schnabel warning (briefing 07-06)' },
      { label: 'Real-rate headwind contained', status: 'stable', lastEvidence: null },
    ],
    history: [
      { date: '2026-07-06', status: 'strengthening', note: 'HOLD; disruption scenario at 30% sustains the hedge case.', source: 'briefing 2026-07-06' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 5230, unrealizedPnlUsd: 410 },
  },
  {
    ticker: 'K-VIETNAM', company: 'K Vietnam Equity (fund)', kind: 'theme', positionSize: 'satellite', held: true,
    status: 'stable',
    core: 'Vietnam FDI / supply-chain relocation story — DCA lane, underwater is the strategy working.',
    narrative:
      'China+1 supply-chain relocation FDI compounding into Vietnamese equities. This is a DCA position: drawdowns are accumulation, not thesis damage, unless FDI inflows break.',
    assumptions: [
      { label: 'FDI inflows sustained', status: 'stable', lastEvidence: 'Vietnam FDI story intact (briefing 07-06)' },
    ],
    history: [
      { date: '2026-07-06', status: 'stable', note: 'DCA continue as scheduled.', source: 'briefing 2026-07-06' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 2140, unrealizedPnlUsd: -180 },
  },
  {
    ticker: 'KFINDIA-A', company: 'Krungsri India Equity (fund)', kind: 'theme', positionSize: 'satellite', held: true,
    status: 'stable',
    core: 'India structural growth — demographics + manufacturing policy; DCA lane.',
    narrative:
      'India structural thesis intact: demographics, PLI manufacturing incentives, and the China+1 rotation. −$222 harvestable if resetting basis; prioritize accumulation over harvest.',
    assumptions: [
      { label: 'Structural growth premium persists', status: 'stable', lastEvidence: 'India structural thesis intact (briefing 07-06)' },
    ],
    history: [
      { date: '2026-07-06', status: 'stable', note: 'DCA continue; harvest optional (−$222).', source: 'briefing 2026-07-06' },
    ],
    lastReviewedAt: '2026-07-06',
    position: { valueUsd: 1980, unrealizedPnlUsd: -222 },
  },
]

const CLOSED_WATCHLIST: ThesisRow[] = [
  {
    ticker: 'CRWD', company: 'CrowdStrike', kind: 'company', positionSize: 'none', held: false,
    closed: { exitedAt: '2026-07-01', realizedPnlUsd: -412, exitReason: 'Tax-loss harvest; thesis intact — re-entry blocked by wash-sale until 2026-07-15.' },
    status: 'stable',
    core: 'Endpoint-security platform consolidation winner — exited for harvest, not for thesis damage.',
    narrative:
      'Sold 2026-07-01 to harvest the loss; the platform-consolidation thesis was NOT broken. Wash-sale window blocks rebuy before 07-15. NDAA cyber provisions would re-arm the bull case — if the floor vote lands inside the window, that is the exact tension the briefing must call out.',
    assumptions: [
      { label: 'Security platform consolidation', status: 'stable', lastEvidence: 'NDAA cyber provisions advancing' },
    ],
    history: [
      { date: '2026-07-01', status: 'stable', note: 'EXIT (harvest). Do not rebuy before 07-15.', source: 'trade log' },
      { date: '2026-06-20', status: 'mixed', note: 'Post-outage churn watch cleared.' },
    ],
    lastReviewedAt: '2026-07-01',
  },
  {
    ticker: 'UNH', company: 'UnitedHealth Group', kind: 'company', positionSize: 'none', held: false,
    closed: { exitedAt: '2026-07-01', realizedPnlUsd: -655, exitReason: 'Thesis broken: MLR deterioration + regulatory scrutiny; loss harvested.' },
    status: 'broken',
    core: 'Managed-care margin compounder — broken by medical-loss-ratio deterioration.',
    narrative:
      'The margin thesis broke: sustained MLR deterioration plus DOJ scrutiny removed both the earnings floor and the multiple argument. Exited 2026-07-01; wash-sale until 07-15 (moot — no re-entry case).',
    assumptions: [
      { label: 'MLR mean-reverts below 85%', status: 'broken', lastEvidence: 'Three consecutive quarters of MLR deterioration' },
    ],
    history: [
      { date: '2026-07-01', status: 'broken', note: 'EXIT. Realized −$655.', source: 'trade log' },
    ],
    lastReviewedAt: '2026-07-01',
  },
  {
    ticker: 'NVO', company: 'Novo Nordisk', kind: 'company', positionSize: 'watchlist', held: false,
    closed: { exitedAt: '2026-03-18', realizedPnlUsd: 231, exitReason: 'Rotated GLP-1 exposure into LLY on pipeline breadth.' },
    status: 'stable',
    core: 'GLP-1 originator — exposure consolidated into LLY; kept on watch for valuation re-entry.',
    narrative:
      'Exited to consolidate GLP-1 exposure into LLY (broader pipeline, US pricing leverage). Watchlist thesis: re-enter if the valuation gap to LLY exceeds the pipeline gap.',
    assumptions: [
      { label: 'CagriSema data competitive with Zepbound', status: 'weakening', lastEvidence: 'Trial readout underwhelmed vs expectations' },
    ],
    history: [
      { date: '2026-03-18', status: 'stable', note: 'EXIT +$231; rotated into LLY.', source: 'trade log' },
    ],
    lastReviewedAt: '2026-05-02',
  },
  {
    ticker: 'META', company: 'Meta Platforms', kind: 'company', positionSize: 'watchlist', held: false,
    closed: { exitedAt: '2026-02-09', realizedPnlUsd: 884, exitReason: 'Took profit after capex-guidance spike; watching for re-entry.' },
    status: 'mixed',
    core: 'AI-driven ad efficiency vs open-ended capex — watching whether Llama monetizes.',
    narrative:
      'Exited on capex-guidance spike (+$884). Watch thesis: Meta is simultaneously the largest NVDA customer (training capex risk) and the clearest AI ad-efficiency winner. Re-entry if capex growth decelerates while ad ARPU keeps compounding.',
    assumptions: [
      { label: 'AI ad-targeting lift > capex drag', status: 'stable', lastEvidence: null },
      { label: 'Capex growth decelerates 2H26', status: 'weakening', lastEvidence: 'Llama training cluster expansion announced' },
    ],
    history: [
      { date: '2026-02-09', status: 'mixed', note: 'EXIT +$884 on capex spike.', source: 'trade log' },
    ],
    lastReviewedAt: '2026-06-12',
  },
]

/** Paper-book tickers (discovery agent) — related names cross-link there. */
const PAPER_TICKERS = new Set([
  'NVDA', 'TSM', 'AVGO', 'ASML', 'ANET', 'MRVL', 'MU', 'VRT', 'ORCL', 'CEG',
  'GOOG', 'AMAT', 'KLAC', 'AMZN', 'MPWR', 'LRCX',
])

/* ------------------ real graph.json excerpt (2026-07-03) ------------------ */
// dependency-graph-engine/data/graph.json — nodes (ticker, themes) + edges.
// GAP #17: theme-exposure aggregation (held USD per theme) + edge asOf.

const GRAPH_NODES: Array<{ ticker: string; company: string; themes: string[] }> = [
  { ticker: 'NVDA', company: 'NVIDIA Corporation', themes: ['ai-infrastructure'] },
  { ticker: 'AMD', company: 'Advanced Micro Devices', themes: ['ai-infrastructure', 'semiconductors'] },
  { ticker: 'AVGO', company: 'Broadcom', themes: ['ai-infrastructure'] },
  { ticker: 'MRVL', company: 'Marvell Technology', themes: ['ai-infrastructure'] },
  { ticker: 'ARM', company: 'Arm Holdings', themes: ['ai-infrastructure', 'semiconductors'] },
  { ticker: 'SMCI', company: 'Super Micro Computer', themes: ['ai-infrastructure'] },
  { ticker: 'PLTR', company: 'Palantir Technologies', themes: ['ai-infrastructure'] },
  { ticker: 'DELL', company: 'Dell Technologies', themes: ['ai-infrastructure'] },
  { ticker: 'CRWV', company: 'CoreWeave', themes: ['ai-infrastructure'] },
  { ticker: 'TSM', company: 'Taiwan Semiconductor', themes: ['semiconductors'] },
  { ticker: 'ASML', company: 'ASML Holding', themes: ['semiconductors'] },
  { ticker: 'AMAT', company: 'Applied Materials', themes: ['semiconductors'] },
  { ticker: 'KLAC', company: 'KLA Corporation', themes: ['semiconductors'] },
  { ticker: 'LRCX', company: 'Lam Research', themes: ['semiconductors'] },
  { ticker: 'INTC', company: 'Intel', themes: ['semiconductors'] },
  { ticker: 'MU', company: 'Micron Technology', themes: ['semiconductors'] },
  { ticker: 'QCOM', company: 'Qualcomm', themes: ['semiconductors'] },
  { ticker: 'WDC', company: 'Western Digital', themes: ['semiconductors'] },
  { ticker: 'MSFT', company: 'Microsoft', themes: ['cloud-hyperscalers'] },
  { ticker: 'AMZN', company: 'Amazon', themes: ['cloud-hyperscalers'] },
  { ticker: 'GOOG', company: 'Alphabet', themes: ['cloud-hyperscalers'] },
  { ticker: 'META', company: 'Meta Platforms', themes: ['cloud-hyperscalers'] },
  { ticker: 'ORCL', company: 'Oracle', themes: ['cloud-hyperscalers'] },
  { ticker: 'IBM', company: 'IBM', themes: ['cloud-hyperscalers'] },
  { ticker: 'NEE', company: 'NextEra Energy', themes: ['energy-infrastructure'] },
  { ticker: 'CEG', company: 'Constellation Energy', themes: ['energy-infrastructure'] },
  { ticker: 'VST', company: 'Vistra Corp', themes: ['energy-infrastructure'] },
  { ticker: 'AEE', company: 'Ameren', themes: ['energy-infrastructure'] },
  { ticker: 'CRWD', company: 'CrowdStrike', themes: ['cybersecurity'] },
  { ticker: 'NET', company: 'Cloudflare', themes: ['cybersecurity'] },
  { ticker: 'APP', company: 'AppLovin', themes: ['adtech'] },
]

const GRAPH_EDGES: GraphEdge[] = [
  { from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'TSMC manufactures NVIDIA GPUs (H100, B200, GB200) at 4nm/3nm nodes' },
  { from: 'AMD', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'TSMC manufactures AMD CPUs (EPYC, Ryzen) and Instinct GPUs' },
  { from: 'ARM', to: 'TSM', type: 'supply_chain', strength: 'moderate', description: 'TSMC fabs chips based on ARM architecture for ARM licensees' },
  { from: 'AVGO', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'TSMC manufactures Broadcom custom AI ASICs and networking chips' },
  { from: 'MRVL', to: 'TSM', type: 'supply_chain', strength: 'strong', description: 'TSMC manufactures Marvell custom silicon and networking chips' },
  { from: 'NVDA', to: 'AMAT', type: 'supply_chain', strength: 'moderate', description: 'Applied Materials provides deposition/etch equipment used in NVIDIA GPU fab' },
  { from: 'TSM', to: 'ASML', type: 'supply_chain', strength: 'strong', description: 'TSMC depends on ASML EUV lithography for advanced node production' },
  { from: 'TSM', to: 'AMAT', type: 'supply_chain', strength: 'strong', description: 'Applied Materials is a major equipment supplier to TSMC fabs' },
  { from: 'TSM', to: 'KLAC', type: 'supply_chain', strength: 'strong', description: 'KLA provides process control equipment critical to TSMC yield management' },
  { from: 'TSM', to: 'LRCX', type: 'supply_chain', strength: 'strong', description: 'Lam Research provides etch and deposition equipment to TSMC' },
  { from: 'NVDA', to: 'MU', type: 'supply_chain', strength: 'strong', description: 'Micron supplies HBM memory stacked on NVIDIA H100/B200 GPUs' },
  { from: 'AMD', to: 'MU', type: 'supply_chain', strength: 'moderate', description: 'Micron supplies HBM for AMD Instinct MI300 GPUs' },
  { from: 'SMCI', to: 'NVDA', type: 'supply_chain', strength: 'strong', description: 'SMCI builds GPU servers using NVIDIA GPUs as primary component' },
  { from: 'DELL', to: 'NVDA', type: 'supply_chain', strength: 'strong', description: 'Dell PowerEdge AI servers use NVIDIA GPUs as core component' },
  { from: 'CRWV', to: 'NVDA', type: 'customer', strength: 'strong', description: 'CoreWeave is among the largest NVIDIA GPU customers for neocloud infrastructure' },
  { from: 'MSFT', to: 'NVDA', type: 'customer', strength: 'strong', description: 'Microsoft Azure is a major NVIDIA GPU customer for cloud AI infrastructure' },
  { from: 'AMZN', to: 'NVDA', type: 'customer', strength: 'strong', description: 'AWS purchases NVIDIA GPUs alongside its own Trainium/Inferentia silicon' },
  { from: 'GOOG', to: 'NVDA', type: 'customer', strength: 'moderate', description: 'Google Cloud purchases NVIDIA GPUs alongside its own TPU infrastructure' },
  { from: 'META', to: 'NVDA', type: 'customer', strength: 'strong', description: 'Meta is one of the largest NVIDIA GPU buyers for Llama AI training' },
  { from: 'ORCL', to: 'NVDA', type: 'customer', strength: 'strong', description: 'Oracle Cloud purchases NVIDIA GPUs for its GPU cloud infrastructure' },
  { from: 'MSFT', to: 'ARM', type: 'customer', strength: 'strong', description: 'Microsoft licenses ARM architecture for Azure Cobalt custom CPUs' },
  { from: 'AMZN', to: 'ARM', type: 'customer', strength: 'strong', description: 'Amazon licenses ARM for Graviton CPU series powering AWS infrastructure' },
  { from: 'GOOG', to: 'ARM', type: 'customer', strength: 'strong', description: 'Google licenses ARM for Axion custom CPU used in Google Cloud' },
  { from: 'PLTR', to: 'MSFT', type: 'customer', strength: 'moderate', description: 'Palantir runs its AIP platform on Azure cloud infrastructure' },
  { from: 'NET', to: 'AMZN', type: 'customer', strength: 'moderate', description: 'Cloudflare uses AWS as infrastructure alongside its own global network' },
  { from: 'MSFT', to: 'ARM', type: 'technology', strength: 'strong', description: 'Microsoft Azure Cobalt CPU is ARM-architecture based' },
  { from: 'AMZN', to: 'ARM', type: 'technology', strength: 'strong', description: 'AWS Graviton CPUs are ARM-based; power significant EC2 capacity' },
  { from: 'GOOG', to: 'ARM', type: 'technology', strength: 'strong', description: 'Google Axion CPU is ARM-based' },
  { from: 'CRWV', to: 'NVDA', type: 'technology', strength: 'strong', description: 'CoreWeave infrastructure is built entirely on NVIDIA GPU technology (CUDA)' },
  { from: 'META', to: 'NVDA', type: 'technology', strength: 'strong', description: 'Meta AI training runs on NVIDIA GPU clusters using CUDA' },
  { from: 'NET', to: 'ARM', type: 'technology', strength: 'moderate', description: 'Cloudflare uses ARM-based servers across its global network edge nodes' },
  { from: 'NVDA', to: 'AMD', type: 'competitive', strength: 'strong', description: 'AMD Instinct GPU line competes with NVIDIA in AI accelerator market' },
  { from: 'NVDA', to: 'INTC', type: 'competitive', strength: 'moderate', description: 'Intel Gaudi AI accelerators compete with NVIDIA in data center AI' },
  { from: 'AMD', to: 'INTC', type: 'competitive', strength: 'strong', description: 'AMD EPYC CPUs compete directly with Intel Xeon in data center market' },
  { from: 'MSFT', to: 'AMZN', type: 'competitive', strength: 'strong', description: 'Azure and AWS are primary competitors in enterprise cloud market' },
  { from: 'MSFT', to: 'GOOG', type: 'competitive', strength: 'strong', description: 'Azure and Google Cloud compete in enterprise cloud and AI services' },
  { from: 'AMZN', to: 'GOOG', type: 'competitive', strength: 'strong', description: 'AWS and Google Cloud are direct competitors in cloud infrastructure' },
  { from: 'TSM', to: 'INTC', type: 'competitive', strength: 'moderate', description: 'Intel Foundry Services competes with TSMC for advanced semiconductor fabrication' },
  { from: 'ARM', to: 'INTC', type: 'competitive', strength: 'moderate', description: 'ARM-based server CPUs (Graviton, Cobalt, Axion) compete with Intel Xeon' },
  { from: 'CRWD', to: 'NET', type: 'competitive', strength: 'weak', description: 'CrowdStrike and Cloudflare overlap in zero-trust and network security markets' },
]

/* ------------------------------- proposals -------------------------------- */
// GAP #13: proposals are generated inside the briefing prompt today and only
// narrated; these rows model the thesis-memory Proposal/ProposalChange shape.

const PROPOSALS: ThesisProposal[] = [
  {
    id: 'p-scbceh-1',
    ticker: 'SCBCEH',
    changeType: 'assumption_status',
    oldValue: 'Stimulus-driven re-rating catalyst — weakening',
    newValue: 'Stimulus-driven re-rating catalyst — broken',
    reasoning:
      'Three consecutive scenario runs (07-04 → 07-06) name no China/HK catalyst in best, base, or disruption. A catalyst absent from every scenario is not weakening — it is gone.',
    evidenceQuotes: ['China/HK thesis has no named catalyst in any scenario; pause contributions, evaluate deep trim.'],
    source: 'briefing 2026-07-06',
    createdAt: '2026-07-06T23:44:56.000Z',
  },
  {
    id: 'p-pltr-1',
    ticker: 'PLTR',
    changeType: 'portfolio_action',
    oldValue: 'hold (satellite)',
    newValue: 'reduce −17% (satellite, thinner)',
    reasoning:
      'Federal demand assumption is strengthening but the valuation-cushion assumption is weakening faster; the sentiment overhang (Trump PLTR sale) has no offsetting catalyst until the NDAA floor vote.',
    evidenceQuotes: [
      'Trump PLTR sale adds sentiment overhang on a thin cushion.',
      'NDAA still in Rules Committee, not on the floor.',
    ],
    source: 'briefing 2026-07-06',
    createdAt: '2026-07-06T23:44:56.000Z',
  },
]
