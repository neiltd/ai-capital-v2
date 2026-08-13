export interface WatchlistAward {
  ticker:     string
  company:    string
  total30d:   number
  awardCount: number
  topAgency:  string
  contracts:  string[]
}

export interface AgencyFlow {
  agency:   string
  agencyId: string
  total30d: number
  trend:    'rising' | 'stable' | 'falling'
}

export interface BudgetSignal {
  billNumber:      string
  title:           string
  congress:        number
  status:          string
  date:            string
  summary:         string
  relevantTickers: string[]
  totalFunding:    number | null
  keyProvisions:   string[]
}

export interface GovFlowJSON {
  exportedAt:      string
  asOf:            string
  watchlistAwards: WatchlistAward[]
  agencyFlows:     AgencyFlow[]
  budgetSignals:   BudgetSignal[]
}

// --- Thailand government procurement (e-GP data via ACT Ai) ---
// The Thai analogue of the US watchlist awards above: which SET-listed
// contractors receive Thai state PROCUREMENT money. (Power/concession names
// like GULF/AOT/BEM get state money via PPAs/concessions, not procurement, so
// they're intentionally absent here — see thai/watchlist.ts.)
export interface ThaiContractorFlow {
  ticker:            string
  companyId:         string   // juristic registration number (ACT Ai companyId)
  companyName:       string
  totalProjects:     number
  totalContractTHB:  number   // all-time contract value won, THB
  hasCorruptionRisk: boolean  // ACT Ai's corruption-risk flag on the entity
}

export interface ThaiGovFlowJSON {
  exportedAt:  string
  asOf:        string
  source:      string
  contractors: ThaiContractorFlow[]
}
