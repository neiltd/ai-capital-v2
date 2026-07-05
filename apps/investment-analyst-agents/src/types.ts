// Upstream data shapes — mirrors sibling project types without cross-project imports

export interface AnalysisJSON {
  exportedAt:    string
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

export interface SimulationJSON {
  exportedAt: string
  usdThb?:    number
  portfolio:  Array<{
    ticker:        string
    company:       string
    shares:        number
    avgCost:       number
    currentPrice:  number
    currentValue:  number
    unrealizedPnl: number
    currency?:     string
    assetClass?:   string
    updatedAt:     string
  }>
  scenarios: Array<{
    id:               string
    runId:            string
    date:             string
    scenarioType:     'best' | 'base' | 'disruption' | 'whatif'
    title:            string
    narrative:        string
    timeHorizon:      string
    probability:      number
    regimeTransition: string | null
    triggers:         string[]
    createdAt:        string
  }>
  actions: Array<{
    id:                  string
    runId:               string
    scenarioId:          string
    ticker:              string
    action:              'buy' | 'hold' | 'trim' | 'exit'
    conviction:          'high' | 'medium' | 'low'
    allocationChangePct: number
    rationale:           string
    createdAt:           string
  }>
}

export interface GraphJSON {
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

export interface StockIntelJSON {
  date:             string
  marketEvents:     Array<{
    title:           string
    summary:         string
    eventType:       string
    severity:        string
    marketDirection: string
  }>
  macroRiskSignals: Array<{
    riskType:          string
    intensity:         string
    primaryCountries:  string[]
  }>
  sectorExposure:   Array<{
    sector:      string
    exposure:    string
    maxSeverity: string
  }>
}

export interface WorldIntelJSON {
  date:   string
  events: Array<{
    title:                 string
    summary:               string
    eventType:             string
    severity:              string
    countries:             string[]
    geopoliticalRelevance: string
    marketRelevance:       string
    escalationPotential:   string
  }>
  countrySignals: Array<{
    country:           string
    maxSeverity:       string
    dominantEventType: string
  }>
}

export type PeopleEventType =
  | 'role_change'
  | 'key_hire'
  | 'public_statement'
  | 'insider_trade'
  | 'other'

export interface PeopleEvent {
  id:            string
  ticker:        string
  company:       string
  personName:    string
  personRole:    string
  eventType:     PeopleEventType
  headline:      string
  detail:        string
  publishedDate: string
  source:        string
  url:           string | null
  evidenceQuote: string | null
  impact:        'high' | 'medium' | 'low'
  createdAt:     string
}

export interface PeopleEventsJSON {
  exportedAt:   string
  windowDays:   number
  tickers:      string[]
  events:       PeopleEvent[]
}

export interface CalibrationContext {
  generatedAt:           string
  predictionsAnalyzed:   number
  scoredCalls:           number
  windows:               number[]
  byAction:              Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:          Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:   boolean
  highConvictionPenalty: number
  bestEdge:              { signal: string; accuracy: number } | null
  worstSignal:           { signal: string; accuracy: number } | null
}

export interface TaxHarvestContext {
  schemaVersion:    string
  generatedAt:      string
  realizedYTD:      { gainsUSD: number; lossesUSD: number; netTaxableUSD: number; trades: number }
  harvestOpportunities: Array<{
    ticker: string; strategy: string; taxJurisdiction: string;
    unrealizedLossUSD: number; harvestable: boolean; washSaleRisk: boolean; notes: string
  }>
  washSaleAlerts: Array<{
    ticker: string; soldAt: string; doNotRebuyBefore: string; daysRemaining: number
  }>
  summary: string
}

export interface RiskContext {
  schemaVersion:       string
  generatedAt:         string
  windowDays:          number
  benchmark:           string
  portfolioValueUSD:   number
  portfolioVolatility: number
  portfolioReturn:     number
  sharpeRatio:         number
  maxDrawdown:         number
  oneDayVAR95:         number
  portfolioBeta:       number
  perTicker:           Array<{ ticker: string; weight: number; volatility: number; totalReturn: number; beta: number; correlation: number }>
  summary:             string
}

export interface ContextBundle {
  date:           string
  analysis:       AnalysisJSON
  simulation:     SimulationJSON
  graph:          GraphJSON
  stockIntel:     StockIntelJSON
  worldIntel:     WorldIntelJSON
  profile:        string    // raw Markdown from knowledge/profile.md; '' if missing
  profileMissing: boolean   // true when profile.md was not found
  thesisSummary:  string    // formatted thesis snapshot; '' if no thesis DB found
  peopleEvents?:  PeopleEvent[] // key-people events from last 7 days for portfolio tickers; optional for older fixtures
  calibration?:      CalibrationContext | null  // accuracy stats from prior briefings; null until backtest has run
  taxHarvest?:       TaxHarvestContext | null   // YTD realized + harvest opportunities + wash sale alerts
  risk?:             RiskContext | null         // VAR, Sharpe, beta, max drawdown, per-ticker risk
  correlationReport?: string | null            // weekly pairwise correlation + concentration clusters
}

export interface PredictionEntry {
  date:       string
  regime:     string
  confidence: string
  scenarios:  Array<{
    scenarioType:     string
    title:            string
    probability:      number
    timeHorizon:      string
    regimeTransition: string | null
    triggers:         string[]
  }>
  actions: Array<{
    ticker:              string
    scenarioType:        string
    action:              string
    conviction:          string
    allocationChangePct: number
  }>
}

export interface QAEntry {
  date:      string
  timestamp: string
  mode:      'loop' | 'single'
  exchanges: Array<{ question: string; answer: string }>
}
