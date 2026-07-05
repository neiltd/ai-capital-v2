export type AssetClass = 'us_equity' | 'th_equity' | 'th_fund' | 'gold' | 'cash'
export type Currency   = 'USD' | 'THB'
export type Strategy   = 'tactical' | 'dca' | 'tax_locked'

export interface Position {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  updatedAt:     string
  assetClass:    AssetClass
  currency:      Currency
  priceSymbol:   string   // Yahoo Finance symbol for price fetch; '' if none (cash, manual NAV)
  strategy:      Strategy // tactical | dca | tax_locked — drives briefing exit logic
}

export interface Scenario {
  id:               string
  runId:            string
  date:             string
  scenarioType:     'best' | 'base' | 'disruption' | 'whatif'
  title:            string
  narrative:        string
  timeHorizon:      string
  probability:      number   // integer 0–100; validated in scenario-generator
  regimeTransition: string | null
  triggers:         string[]
  createdAt:        string
}

export interface PortfolioAction {
  id:                  string
  runId:               string
  scenarioId:          string
  ticker:              string
  action:              'buy' | 'hold' | 'trim' | 'exit'
  conviction:          'high' | 'medium' | 'low'
  allocationChangePct: number  // integer; buy→>0, hold→0, trim→<0, exit→-100
  rationale:           string
  createdAt:           string
}

export interface SimulationRun {
  id:            string
  date:          string
  type:          'daily' | 'whatif'
  trigger:       string | null
  scenarioCount: number
  actionCount:   number
  durationMs:    number
  createdAt:     string
}

export interface AnalysisJSON {
  exportedAt: string
  latestRegime: {
    id:              string
    date:            string
    regime:          string
    confidence:      string
    rationale:       string
    keyIndicators:   string[]
    affectedTickers: string[]
    createdAt:       string
  }
  latestSignals: Array<{
    id:            string
    date:          string
    sourceTicker:  string
    targetTicker:  string
    signalType:    string
    direction:     string
    magnitude:     string
    sentiment:     string
    description:   string
    evidenceQuote: string | null
    createdAt:     string
  }>
  companySummaries: Array<{
    ticker:        string
    company:       string
    healthScore:   string
    thesisSummary: string
  }>
}

export interface GraphJSON {
  schemaVersion?: string
  exportedAt: string
  nodes: Array<{ ticker: string; company: string; themes: string[] }>
  edges: Array<{
    from:          string
    to:            string
    type:          string
    strength:      string
    description:   string
    evidenceQuote: string | null
  }>
}

export interface SimulationJSON {
  schemaVersion?: string
  exportedAt: string
  portfolio:  Position[]
  scenarios:  Scenario[]
  actions:    PortfolioAction[]
  /** USD/THB exchange rate (THB per 1 USD). Null when no THB asset is held or fetch failed. */
  usdThb?:    number | null
}
