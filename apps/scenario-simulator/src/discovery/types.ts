export type DiscoverySource = 'companies_table' | 'news_mention'

export interface DiscoveryCandidate {
  ticker: string
  company: string
  source: DiscoverySource
  newsSnippet: string | null
}

export interface ScoredCandidate {
  ticker: string
  company: string
  source: DiscoverySource
  score: number
  rationale: string
}

export interface DiscoveryScenario {
  id: string
  ticker: string
  date: string
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  narrative: string
  timeHorizon: string
  probability: number
  regimeTransition: string | null
  triggers: string[]
  createdAt: string
}

export interface DiscoveryAction {
  ticker: string
  recommendation: 'buy' | 'watch'
  conviction: 'high' | 'medium' | 'low'
  rationale: string
}

export interface DiscoveryPosition {
  ticker: string
  company: string
  shares: number
  avgCost: number
  currentPrice: number
  currentValue: number
  unrealizedPnl: number
  score: number
  source: DiscoverySource
  rationale: string
  openedAt: string
  updatedAt: string
}

export interface DiscoveryRun {
  id: string
  date: string
  candidatesFound: number
  passedFilter: number
  positionsOpened: number
  threshold: number
  durationMs: number
  createdAt: string
}

export interface DiscoveryExportCandidate {
  ticker: string
  company: string
  score: number
  rationale: string
  source: DiscoverySource
  discoveredAt: string
  action: 'buy' | 'watch'
  newsSnippet: string | null
}

export interface DiscoveryJSON {
  schemaVersion?: string
  exportedAt: string
  config: {
    threshold: number
    paperBudget: number
    cashReservePct: number
    newsDays: number
  }
  candidates: DiscoveryExportCandidate[]
  discoveryPortfolio: DiscoveryPosition[]
  scenarios: DiscoveryScenario[]
  actions: DiscoveryAction[]
}
