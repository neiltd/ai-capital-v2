// JSON envelopes exchanged between pipeline stages via file or future API.
//
// NOTE: as of Phase 3.1 each app still owns its local copy of these envelopes,
// which diverge in places (e.g. unified-platform uses permissive optional fields
// for tolerant JSON parsing). The canonical shapes below match the *producer*
// app for each envelope. Consumers can migrate over time.

import type { Position } from './portfolio.js'

// Produced by: ai-analysis-engine (Stage 2 export)
export interface AnalysisJSON {
  schemaVersion?:    string
  exportedAt:        string
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

// Produced by: dependency-graph-engine
export interface GraphJSON {
  schemaVersion?: string
  exportedAt:     string
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

// Produced by: scenario-simulator (daily simulation)
export interface SimulationJSON {
  schemaVersion?: string
  exportedAt:     string
  portfolio:      Position[]
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
  /** USD/THB exchange rate (THB per 1 USD). Null when no THB asset is held or fetch failed. */
  usdThb?: number | null
}

// Produced by: scenario-simulator (weekly discovery)
export interface DiscoveryJSON {
  schemaVersion?: string
  exportedAt:     string
  config: {
    threshold:      number
    paperBudget:    number
    cashReservePct: number
    newsDays:       number
  }
  candidates: Array<{
    ticker:           string
    company:          string
    score:            number
    rationale:        string
    currentPrice:     number
    recommendation:   string
    conviction?:      string
    bearScore?:       number
  }>
  discoveryPortfolio: Array<{
    ticker:        string
    company:       string
    shares:        number
    avgCost:       number
    currentPrice:  number
    currentValue:  number
    unrealizedPnl: number
    openedAt:      string
    score:         number
    rationale:     string
  }>
  scenarios: unknown[]
  actions:   unknown[]
}

// Produced by: investment-analyst-agents (daily briefing agent)
//
// The markdown briefing (briefings/YYYY-MM-DD.md) remains the primary
// human-readable artifact. This envelope is extracted FROM the finished
// markdown (a second, tool-forced Claude call reading the already-written
// "Today's Recommended Actions" section) rather than generated in parallel
// with it — guarantees the JSON can never say something different from the
// prose, at the cost of one extra cheap model call. regime/scenarios are
// plain passthroughs of already-structured data (analysis.json/
// simulation.json), not LLM output. harvestableUsd/washSaleNote are
// mechanically joined from tax/harvest.json by ticker, not LLM-extracted —
// financial figures should never depend on the model reading its own prose
// back correctly.
export interface BriefingJSON {
  schemaVersion?: string
  exportedAt:     string
  date:           string
  regime: {
    regime:        string
    confidence:    string
    rationale:     string
    keyIndicators: string[]
  }
  /** One-line self-calibration verdict; null until backtest/calibration.json exists. */
  calibrationNote: string | null
  recommendedActions: Array<{
    id:                   string
    ticker:               string
    action:               'buy' | 'hold' | 'trim' | 'exit'
    conviction:           'high' | 'medium' | 'low'
    allocationChangePct:  number
    rationale:            string
    /** True when the self-calibration rule forced a uniform downgrade (calibrationInverted). */
    convictionDowngraded: boolean
    /** Harvestable USD loss on this ticker today, joined from tax/harvest.json; null if not harvestable. */
    harvestableUsd:       number | null
    /** Active wash-sale window note, joined from tax/harvest.json; null if none active. */
    washSaleNote:         string | null
  }>
  scenarios: Array<{
    id:           string
    scenarioType: 'best' | 'base' | 'disruption'
    title:        string
    probability:  number // 0-100, matches simulation.json's raw scale
    timeHorizon:  string
    narrative:    string
  }>
  /** Extracted from the "## Things to Watch" section, same tool call as recommendedActions. */
  watchItems: Array<{
    kind:    'bull' | 'bear' | 'neutral'
    trigger: string
    tickers: string[]
    why:     string
  }>
}

// Produced by: world-intelligence-data-hub-
export interface IntelligenceJSON {
  schemaVersion?: string
  exportedAt:     string
  project:        string
  events: Array<{
    id:           string
    date:         string
    title:        string
    summary:      string
    tickers:      string[]
    regions:      string[]
    severity:     'high' | 'medium' | 'low'
    sourceUrl:    string | null
  }>
}
