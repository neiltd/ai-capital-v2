export interface AnalysisJSON {
  exportedAt: string
  latestRegime: {
    id?: string
    date?: string
    regime: string
    confidence: string
    rationale?: string
  }
  latestSignals?: unknown[]
  companySummaries?: unknown[]
}

export interface SimulationScenario {
  id: string
  runId?: string
  date?: string
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  probability: number
  timeHorizon: string
  narrative: string
  regimeTransition?: string
  triggers?: string[]
  createdAt?: string
}

export interface ScenarioAction {
  id?: string
  runId?: string
  scenarioId: string
  ticker: string
  action: string
  conviction?: string
  allocationChangePct?: number
  rationale: string
  createdAt?: string
}

export type AssetClass = 'us_equity' | 'th_equity' | 'th_fund' | 'gold' | 'cash'
export type Currency   = 'USD' | 'THB'

export interface PortfolioPosition {
  ticker: string
  company?: string
  shares: number
  avgCost: number
  currentPrice: number
  currentValue?: number
  unrealizedPnl?: number
  updatedAt?: string
  /** Asset bucket; undefined on legacy rows (treated as us_equity). */
  assetClass?: AssetClass
  /** Currency the avg cost / current price are quoted in. */
  currency?: Currency
  /** Yahoo Finance symbol used to fetch the price. */
  priceSymbol?: string
}

export interface SimulationJSON {
  exportedAt?: string
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
  portfolio: PortfolioPosition[]
  /** USD/THB exchange rate (THB per 1 USD). Present when any THB asset is held. */
  usdThb?: number | null
}

export interface GraphNode {
  ticker: string
  company: string
  themes: string[]
}

export interface GraphEdge {
  from: string
  to: string
  type: string
  strength: 'strong' | 'moderate' | 'medium' | 'weak'
  description?: string
  evidenceQuote?: string | null
}

export interface GraphJSON {
  exportedAt?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface StockEvent {
  eventId: string
  title: string
  summary: string
  severity: number        // 1-5, higher = more severe
  eventType: string
  marketDirection?: string
  countries?: string[]
  date?: string
  firstSeenAt?: string
}

export interface StockSectorExposure {
  sector: string
  eventCount: number
  maxSeverity: number      // 1-5, highest severity among this sector's events
  exposure: string         // e.g. 'high' | 'medium' | 'low'
  eventIds?: string[]
  maxMarketRelevance?: number
}

export interface StockIntelJSON {
  date?: string
  generatedAt?: string
  marketEvents: StockEvent[]
  sectorExposure?: StockSectorExposure[]
}

export interface WorldEvent {
  eventId: string
  title: string
  summary: string
  severity: number        // 1-5, higher = more severe
  countries: string[]
  escalationPotential: number   // 0.0 to 1.0
  date?: string
  firstSeenAt?: string
  eventType?: string
  storylineId?: string | null
  eventState?: string
  confidence?: number       // 0.0 to 1.0; < 0.6 renders as single-source
  lat?: number | null
  lng?: number | null
  coordinateQuality?: 'exact' | 'country_centroid'
  marketRelevance?: number  // 0.0 to 1.0
  latestSeenAt?: string
  sourceCount?: number
}

export interface WorldCountrySignal {
  country: string           // ISO3 code, e.g. 'USA'
  eventCount: number
  maxSeverity: number       // 1-5, highest severity among this country's events
  dominantEventType?: string
  avgConfidence?: number
  avgEscalation?: number    // 0.0 to 1.0
  activeStorylines?: string[]
}

export interface WorldStoryline {
  storylineId: string
  title: string
  storylineState: 'active' | 'escalating' | 'stable' | 'dormant' | string
  countries: string[]
  eventTypes: string[]
  totalEvents: number
  totalSources: number
  avgConfidence: number
  avgEscalation: number
  maxSeverity: number
  firstSeenAt: string
  latestSeenAt: string
  daysActive: number
  eventIds: string[]
}

export interface WorldIntelJSON {
  date: string
  generatedAt?: string
  eventCount?: number
  uniqueSourceCount?: number
  reviewExcludedCount?: number
  events: WorldEvent[]
  countrySignals: WorldCountrySignal[]
  storylines?: WorldStoryline[]
}

export interface BriefingResponse {
  date: string
  markdown: string
  regime: string
  confidence: string
  scenarios: Array<{ scenarioType: string; title: string; probability: number; timeHorizon: string }>
  missing: boolean
}

export interface ContextResponse {
  analysis: AnalysisJSON
  simulation: SimulationJSON
  graph: GraphJSON
  stockIntel: StockIntelJSON
  worldIntel: WorldIntelJSON
}

// --- Discovery types ---

export type DiscoverySource = 'companies_table' | 'news_mention'

export interface DiscoveryExportCandidate {
  ticker: string
  company: string
  score: number
  rationale: string
  source: DiscoverySource
  discoveredAt: string
  action: 'buy' | 'watch'
  newsSnippet?: string | null
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
  /** SPY price at open — null for positions opened before benchmark tracking existed. */
  benchmarkPriceAtOpen?: number | null
  /** Volatility-derived stop/target — null for positions opened before risk-based sizing existed. */
  stopPrice?: number | null
  targetPrice?: number | null
  /** Conviction after the adversarial bear review — distinct from `score` (pre-analysis light-filter score). */
  adjustedConviction?: 'high' | 'medium' | 'low' | null
}

export interface DiscoveryClosedPosition {
  ticker: string
  company: string
  shares: number
  avgCost: number
  exitPrice: number
  realizedPnl: number
  score: number
  source: DiscoverySource
  rationale: string
  exitReason: string
  openedAt: string
  closedAt: string
  benchmarkPriceAtOpen?: number | null
  benchmarkPriceAtClose?: number | null
  stopPrice?: number | null
  targetPrice?: number | null
  adjustedConviction?: 'high' | 'medium' | 'low' | null
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

export interface DiscoveryJSON {
  exportedAt: string
  config: {
    threshold: number
    paperBudget: number
    cashReservePct: number
    newsDays: number
  }
  candidates: DiscoveryExportCandidate[]
  discoveryPortfolio: DiscoveryPosition[]
  closedPositions?: DiscoveryClosedPosition[]
  scenarios: DiscoveryScenario[]
  actions: DiscoveryAction[]
}

export interface DiscoveryResponse {
  discovery: DiscoveryJSON | null
  missing: boolean
}

export type Trend = 'rising' | 'falling' | 'stable'

export interface MarketAsset {
  ticker:       string
  label:        string
  category:     string
  close:        number
  change1d:     number
  changePct1d:  number
  changePct5d:  number
  changePct30d: number
  trend:        Trend
}

export interface EconomicIndicator {
  seriesId:    string
  label:       string
  category:    string
  value:       number
  releaseDate: string
  unit:        string
  trend:       Trend
  changeQoQ:   number | null
  changeYoY:   number | null
}

export type LiquiditySignal = 'draining' | 'neutral' | 'injecting'

export interface LiquidityIndicator {
  seriesId:    string
  label:       string
  value:       number
  releaseDate: string
  unit:        string
  change4w:    number | null
  changeYoY:   number | null
  signal:      LiquiditySignal
}

export interface MacroJSON {
  exportedAt:          string
  asOf:                string
  marketAssets:        MarketAsset[]
  economicIndicators:  EconomicIndicator[]
  liquidityIndicators: LiquidityIndicator[]
}

// --- Government Flow Monitor types ---

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

// --- Wave Analyzer types ---

export type WaveSource = 'macro' | 'watchlist' | 'screener'

export interface Candle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Pivot {
  date: string
  price: number
  type: 'high' | 'low'
}

export interface WavePivot {
  date: string
  price: number
  label: string
}

export interface FibCheck {
  description: string
  actual: number
  expectedRange: string
  pass: boolean
}

export interface WaveAsset {
  ticker: string
  label: string
  source: WaveSource
  candles: Candle[]
  pivots: Pivot[]
  wavePivots: WavePivot[]
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number
  fibChecks: FibCheck[]
}

export interface WavesJSON {
  exportedAt: string
  asOf: string
  assets: WaveAsset[]
}

export type TradeSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface TradeAction {
  ticker:        string
  label:         string
  currentWave:   string | null
  waveDirection: 'up' | 'down' | null
  confidence:    number
  signal:        TradeSignal
  entryZone:     { low: number; high: number } | null
  stopLoss:      number | null
  target:        number | null
  riskReward:    number | null
  narrative:     string
  narrativeKey:  string
  generatedAt:   string
}

export interface WaveActionsJSON {
  exportedAt: string
  asOf:       string
  actions:    TradeAction[]
}

export interface TradePosition {
  id:          string
  ticker:      string
  signal:      'buy' | 'sell'
  entryPrice:  number
  stopLoss:    number
  target:      number
  shares:      number
  openedAt:    string
  closedAt:    string | null
  closePrice:  number | null
  pnl:         number | null
  status:      'open' | 'closed' | 'stopped'
}

export interface WavePortfolioJSON {
  exportedAt:      string
  openPositions:   TradePosition[]
  closedPositions: TradePosition[]
  totalPnl:        number
}
