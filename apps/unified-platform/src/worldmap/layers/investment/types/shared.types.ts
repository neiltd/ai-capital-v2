/**
 * Shared primitives for the Asset Intelligence system.
 * Every claim, thesis, and impact must be traceable to a source.
 */

export type Confidence = 'high' | 'medium' | 'low'
export type Direction  = 'positive' | 'negative' | 'mixed' | 'neutral'
export type Magnitude  = 'critical' | 'high' | 'medium' | 'low'
export type Timeline   = 'immediate' | 'days' | 'weeks' | 'months' | 'quarters' | 'years'
export type GeneratedBy = 'human' | 'ai-assisted'

export interface SourceRef {
  name: string          // human-readable name
  url: string           // direct URL — required
  type: 'filing' | 'news' | 'research' | 'data' | 'official' | 'other'
  accessedAt: string    // YYYY-MM-DD
  verbatimQuote?: string // exact text extracted — never paraphrase
}

export interface Attribution {
  sources: SourceRef[]  // minimum 1 required
  confidence: Confidence
  lastVerified: string  // YYYY-MM-DD
  generatedBy: GeneratedBy
}

/** A single verifiable claim with its supporting evidence */
export interface EvidenceItem {
  type: 'filing' | 'news-article' | 'intelligence-event' | 'data-point' | 'expert-report' | 'earnings-call'
  entityId: string       // links to the source entity (filingId, articleId, etc.)
  description: string    // what this evidence shows
  verbatimQuote?: string // exact text — required for filings and news
  source: SourceRef
}

/** A chain of evidence supporting one specific claim */
export interface EvidenceChain {
  id: string
  claim: string              // the specific claim being supported
  evidence: EvidenceItem[]   // minimum 1 required
  counterEvidence?: EvidenceItem[]
  confidence: Confidence
}

export type ISO3 = string   // ISO 3166-1 alpha-3
export type Ticker = string  // stock ticker symbol
