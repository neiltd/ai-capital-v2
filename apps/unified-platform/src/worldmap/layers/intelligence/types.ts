/**
 * Intelligence layer types.
 * These define the schema for the future news ingestion and event analysis pipeline.
 *
 * Principle: Every intelligence insight must be source-attributed.
 * No AI-generated analysis should appear without the sources used.
 */

export type EventType =
  | 'war' | 'trade' | 'energy' | 'technology' | 'election'
  | 'sanctions' | 'supply_chain' | 'natural_disaster' | 'financial' | 'other'

export type EventStatus = 'emerging' | 'active' | 'developing' | 'resolved'

/**
 * Impact tiers:
 * - Tier 1: Global systemic impact (affects multiple regions, financial markets, supply chains)
 * - Tier 2: Regional or multi-country impact (affects a region or cluster of countries)
 * - Tier 3: Local or early signal (single country or early-stage development)
 */
export type ImpactTier = 1 | 2 | 3

export interface SourceRef {
  name: string
  url: string
  publishedAt?: string
}

export interface NewsArticle {
  id: string
  title: string
  source: string
  sourceUrl: string
  publishedAt: string
  summary: string              // 2-3 sentence summary
  countriesMentioned: string[] // ISO3 codes
  entitiesMentioned: string[]  // organizations, leaders, places
  topics: string[]
}

export interface IntelligenceEvent {
  id: string
  title: string
  eventType: EventType
  tier: ImpactTier
  status: EventStatus

  // Geographic scope
  directCountries: string[]     // ISO3 — directly involved
  indirectCountries: string[]   // ISO3 — affected but not party
  hiddenInfluencers?: string[]  // ISO3 — influencing without public role

  // Impact scoring (0–10)
  economicImpactScore: number
  populationImpactScore: number
  geopoliticalRiskScore: number
  opportunityScore: number

  // Analysis — must be backed by sources
  riskSummary: string
  opportunitySummary: string
  beneficiaries: string[]    // country IDs or entity names
  losers: string[]           // country IDs or entity names

  // Attribution — required
  relatedArticles: string[]  // NewsArticle IDs
  sources: SourceRef[]

  lastUpdated: string
}
