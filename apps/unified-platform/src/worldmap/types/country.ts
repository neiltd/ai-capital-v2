export type Trend = 'rising' | 'stable' | 'declining' | 'improving'
export type Confidence = 'high' | 'medium' | 'low'
export type RelationshipType =
  | 'ally'
  | 'strategic_partner'
  | 'treaty_ally'
  | 'rival'
  | 'enemy'
  | 'neutral'
  | 'trade_partner'
  | 'contested'

export interface Indicator {
  score: number // 1–10
  trend: Trend
  confidence: Confidence
  note?: string
}

export interface Indicators {
  politicalStability: Indicator
  economicDirection: Indicator
  investmentAttractiveness: Indicator
  geopoliticalRisk: Indicator
  educationQuality: Indicator
  healthcareQuality: Indicator
  technologyInvestment: Indicator
}

export interface Religion {
  name: string
  percent: number
}

export interface Demographics {
  population: number
  medianAge: number
  urbanizationRate: number
  majorEthnicGroups: string[]
  religions: Religion[]
}

export interface Relationship {
  countryId: string
  countryName: string
  type: RelationshipType
  sentiment: 'positive' | 'mixed' | 'negative' | 'neutral'
  summary: string
}

export interface Perspective {
  source: string
  bias: string
  view: string
}

export interface HistoricalEvent {
  year: number
  event: string
}

export interface HistoricalContext {
  summary: string
  keyEvents: HistoricalEvent[]
}

export interface InvestmentNotes {
  strengths: string[]
  risks: string[]
  sectors: string[]
}

export interface Source {
  name: string
  url: string
  type: 'economic' | 'political' | 'military' | 'general' | 'demographic'
}

export interface Country {
  id: string          // ISO 3166-1 alpha-3
  iso2: string        // ISO 3166-1 alpha-2 (for flag emoji)
  name: string
  region: string
  subregion: string
  capital: string
  lastUpdated: string
  summary: string
  indicators: Indicators
  demographics: Demographics
  alliances: string[]
  relationships: Relationship[]
  perspectives: Perspective[]
  historicalContext: HistoricalContext
  investmentNotes: InvestmentNotes
  sources: Source[]
}
