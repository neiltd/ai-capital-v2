export type HealthScore         = 'positive' | 'neutral' | 'negative' | 'insufficient_data'
export type RegimeConfidence    = 'high' | 'medium' | 'low'
export type SignalType          = 'supply_chain' | 'customer' | 'technology' | 'competitive'
export type SignalDirection     = 'upstream' | 'downstream'
export type SignalMagnitude     = 'strong' | 'moderate' | 'weak'
export type SignalSentiment     = 'positive' | 'negative' | 'neutral'
export type ThesisAssumptionStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'

export interface ThesisAssumption {
  text:   string
  status: ThesisAssumptionStatus
}

export interface RecentChunk {
  chunkId:      string
  title:        string
  source:       string
  publishedDate: string
  content:      string
}

export interface CompanyHealth {
  ticker:        string
  company:       string
  thesisSummary: string
  assumptions:   ThesisAssumption[]
  recentChunks:  RecentChunk[]
  healthScore:   HealthScore
}

export interface MacroRegime {
  id:              string
  date:            string
  regime:          string
  confidence:      RegimeConfidence
  rationale:       string
  keyIndicators:   string[]
  affectedTickers: string[]
  createdAt:       string
}

export interface PropagationSignal {
  id:            string
  date:          string
  sourceTicker:  string
  targetTicker:  string
  signalType:    SignalType
  direction:     SignalDirection
  magnitude:     SignalMagnitude
  sentiment:     SignalSentiment
  description:   string
  evidenceQuote: string | null
  createdAt:     string
}

export interface AnalysisRun {
  id:                     string
  date:                   string
  companiesAnalyzed:      number
  regimeId:               string
  propagationSignalCount: number
  durationMs:             number
  createdAt:              string
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

export interface AnalysisJSON {
  schemaVersion?:   string  // semantic version; '1.0' as of 2026-06-06
  exportedAt:       string
  latestRegime:     MacroRegime
  latestSignals:    PropagationSignal[]
  companySummaries: Array<{
    ticker:        string
    company:       string
    healthScore:   HealthScore
    thesisSummary: string
  }>
}
