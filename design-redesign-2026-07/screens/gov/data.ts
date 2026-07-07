// Loader contract for /markets/gov — Government contract flow.
// (Supersedes screens/specs/gov-contracts.md.)
//
// Sources:
//   - government-flow-monitor/data/govflow.json (USASpending.gov awards to
//     watchlist vendors; real 2026-07-06 30d totals below)
//   - budget-cache.json (agency budget context)
//   - Legislation stages: narrated in briefing prose only today — GAP #22
//     needs a congress.gov/ProPublica bill-status fetcher for the stepper.
//   - GAP #22 also: vendor→ticker mapping table + monthly aggregation
//     endpoint (GET /api/govflow/monthly?months=12) — the 12mo bar series
//     below is illustrative until it exists.

export interface AwardRow {
  date: string
  agency: string
  vendor: string
  ticker: string
  program: string
  amountUsd: number
  awardType: 'contract' | 'task order' | 'IDIQ' | 'grant'
  held: boolean // in the REAL portfolio
  paper: boolean // in the discovery paper book
}

export interface MonthlyFlow {
  month: string // YYYY-MM
  totalUsd: number
  heldUsd: number // "of which: held tickers"
  topAwards: string[]
}

export interface BillStage {
  id: string
  label: string
}

export interface BillWatch {
  bill: string
  title: string
  stages: BillStage[]
  currentStage: string
  note: string
  /** Links to the /today watch-item this bill powers. */
  watchTrigger?: string
}

export interface GovViewModel {
  exportedAt: string
  asOf: string
  awards30d: { totalUsd: number; count: number; topAgency: string; heldUsd: number }
  /** Briefing watch-trigger progress ("PLTR wins 2nd $100M+ contract"). */
  triggerProgress: { label: string; achieved: number; needed: number; windowEnds: string; detail: string }
  monthly: MonthlyFlow[]
  awards: AwardRow[]
  bills: BillWatch[]
}

export async function loadGov(): Promise<GovViewModel> {
  const awards = AWARDS
  return {
    exportedAt: '2026-07-06T17:06:01.599Z',
    asOf: '2026-07-06',
    awards30d: {
      totalUsd: 219984387.11, // Σ watchlist vendors, real govflow.json 30d
      count: 18,
      topAgency: 'Dept. of Homeland Security',
      heldUsd: 101069377.14, // PLTR is the only held vendor
    },
    triggerProgress: {
      label: 'PLTR wins 2nd federal AI contract > $100M',
      achieved: 1,
      needed: 2,
      windowEnds: '2026-08-27',
      detail: 'DHS $101.1M (2026-06-28) validated the first leg; a second award inside the 60d window is the briefing’s clearest bull trigger for reversing the PLTR trim.',
    },
    monthly: MONTHLY,
    awards,
    bills: BILLS,
  }
}

/* -------------------------------- 12mo flow -------------------------------- */
// Illustrative shape (gap #22 aggregation endpoint); July is month-to-date.

const MONTHLY: MonthlyFlow[] = [
  { month: '2025-08', totalUsd: 84e6, heldUsd: 12e6, topAwards: ['AWS GSA cloud', 'MSFT DOJ support'] },
  { month: '2025-09', totalUsd: 312e6, heldUsd: 48e6, topAwards: ['FY-end obligation surge', 'PLTR Army TITAN mod'] },
  { month: '2025-10', totalUsd: 61e6, heldUsd: 6e6, topAwards: ['MSFT unified support'] },
  { month: '2025-11', totalUsd: 92e6, heldUsd: 15e6, topAwards: ['AWS data lake', 'PLTR CDC ext'] },
  { month: '2025-12', totalUsd: 118e6, heldUsd: 22e6, topAwards: ['PLTR DoD Maven ext'] },
  { month: '2026-01', totalUsd: 74e6, heldUsd: 9e6, topAwards: ['MSFT additive support'] },
  { month: '2026-02', totalUsd: 96e6, heldUsd: 18e6, topAwards: ['AWS VAR support'] },
  { month: '2026-03', totalUsd: 143e6, heldUsd: 31e6, topAwards: ['PLTR USSOCOM order'] },
  { month: '2026-04', totalUsd: 88e6, heldUsd: 11e6, topAwards: ['MSFT unified support'] },
  { month: '2026-05', totalUsd: 105e6, heldUsd: 14e6, topAwards: ['AWS cloud services'] },
  { month: '2026-06', totalUsd: 220e6, heldUsd: 101.1e6, topAwards: ['PLTR DHS $101.1M', 'AWS GSA $99.3M'] },
  { month: '2026-07', totalUsd: 31e6, heldUsd: 0, topAwards: ['month to date'] },
]

/* ------------------------------- award rows -------------------------------- */
// Real 30d watchlist rows from govflow.json, split to award granularity.

const AWARDS: AwardRow[] = [
  { date: '2026-06-28', agency: 'Department of Homeland Security', vendor: 'PALANTIR', ticker: 'PLTR', program: 'Immigration lifecycle operating system — data integration & analytics platform', amountUsd: 101069377.14, awardType: 'contract', held: true, paper: false },
  { date: '2026-06-24', agency: 'General Services Administration', vendor: 'AMAZON', ticker: 'AMZN', program: 'AWS cloud service and VAR support services', amountUsd: 61220400.07, awardType: 'IDIQ', held: false, paper: true },
  { date: '2026-06-19', agency: 'General Services Administration', vendor: 'AMAZON', ticker: 'AMZN', program: 'Multi LID ITL/SW AWS cloud services', amountUsd: 24815500.0, awardType: 'task order', held: false, paper: true },
  { date: '2026-06-12', agency: 'General Services Administration', vendor: 'AMAZON', ticker: 'AMZN', program: 'AWS cloud services data lake', amountUsd: 13300000.0, awardType: 'task order', held: false, paper: true },
  { date: '2026-06-26', agency: 'Department of Justice', vendor: 'MICROSOFT', ticker: 'MSFT', program: 'MS unified support services', amountUsd: 9412000.0, awardType: 'contract', held: false, paper: false },
  { date: '2026-06-17', agency: 'Department of Justice', vendor: 'MICROSOFT', ticker: 'MSFT', program: 'Microsoft additive support services', amountUsd: 5876234.62, awardType: 'task order', held: false, paper: false },
  { date: '2026-06-09', agency: 'Department of Justice', vendor: 'MICROSOFT', ticker: 'MSFT', program: 'Microsoft unified support', amountUsd: 3800000.0, awardType: 'contract', held: false, paper: false },
  { date: '2026-06-21', agency: 'General Services Administration', vendor: 'APPLE', ticker: 'AAPL', program: 'FY25 utility regulatory program service devices', amountUsd: 290875.28, awardType: 'task order', held: false, paper: false },
  { date: '2026-06-14', agency: 'US Coast Guard', vendor: 'APPLE', ticker: 'AAPL', program: '15" panel view displays for 225\' WLB cranes', amountUsd: 200000.0, awardType: 'contract', held: false, paper: false },
]

/* ----------------------------- legislation watch ---------------------------- */

const STAGES: BillStage[] = [
  { id: 'committee', label: 'Committee' },
  { id: 'rules', label: 'Rules' },
  { id: 'floor', label: 'Floor vote' },
  { id: 'senate', label: 'Senate' },
  { id: 'passed', label: 'Passed' },
]

const BILLS: BillWatch[] = [
  {
    bill: 'H.R. 8800',
    title: 'NDAA FY2027',
    stages: STAGES,
    currentStage: 'rules',
    note: 'Cyber provisions arm the NET/CRWD bull case; floor vote = material repricing for PLTR/CRWD/NET.',
    watchTrigger: 'NDAA FY2027 advances to House floor vote',
  },
  {
    bill: 'H.R. 8721',
    title: 'NatSec appropriations FY2027',
    stages: STAGES,
    currentStage: 'committee',
    note: 'Carries the federal AI budget line the discovery agent’s gov-adjacent names price on.',
  },
]
