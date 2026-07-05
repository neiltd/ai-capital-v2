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
