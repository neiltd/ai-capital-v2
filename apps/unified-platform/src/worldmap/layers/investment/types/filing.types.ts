import type { ISO3, Confidence, Attribution } from './shared.types'

export type FilingType =
  | 'SEC-10K'          // US annual report (most important)
  | 'SEC-10Q'          // US quarterly report
  | 'SEC-8K'           // US material event disclosure
  | 'SEC-DEF14A'       // US proxy statement
  | 'SET-56-1'         // Thai annual report (Form 56-1)
  | 'SET-annual-report'
  | 'earnings-call'    // earnings call transcript
  | 'investor-day'
  | 'annual-report'    // generic annual report (non-US/Thai)

export type RiskCategory =
  | 'geopolitical'
  | 'supply-chain'
  | 'commodity'
  | 'regulatory'
  | 'trade-sanctions'
  | 'export-controls'
  | 'currency'
  | 'cybersecurity'
  | 'climate'
  | 'competition'
  | 'operational'
  | 'other'

export type RiskSeverity = 'material' | 'notable' | 'mentioned'

/**
 * A single risk factor extracted from a company filing.
 * verbatimText is required — never paraphrase.
 */
export interface FilingRiskFactor {
  id: string
  category: RiskCategory
  subcategory?: string            // e.g. "Taiwan conflict", "China revenue"
  title: string
  verbatimText: string            // EXACT quote from the filing — never summarize
  sectionRef: string              // e.g. "Item 1A. Risk Factors, p.24"

  // Structured extraction from the verbatim text
  countriesMentioned: ISO3[]
  regionsmentioned: string[]
  commoditiesMentioned: string[]
  chokepointsMentioned: string[]  // named chokepoints/waterways
  tradeRoutesMentioned: string[]
  companiesMentioned: string[]
  regulationsMentioned: string[]

  // Assessment
  severity: RiskSeverity
  isNewRisk: boolean              // not in prior year's filing
  isQuantified: boolean           // does filing give numbers/percentages?
  quantifiedNote?: string         // "accounts for 25% of revenue"

  // Cross-references
  relatedEventTypes: string[]     // what geopolitical events would trigger this risk
  relatedSectors: string[]        // other sectors affected the same way
}

/**
 * Full company filing with extracted intelligence.
 */
export interface CompanyFiling {
  id: string                      // "FILING-NVDA-10K-2024"
  companyId: string               // links to CompanyProfile
  ticker: string
  companyName: string
  filingType: FilingType
  fiscalYear: number
  filingDate: string              // YYYY-MM-DD
  reportingPeriodEnd: string      // YYYY-MM-DD

  // Direct source
  secAccessionNumber?: string     // e.g. "0001045810-24-000029"
  setFilingId?: string
  sourceUrl: string               // REQUIRED — direct URL to the filing document
  secEdgarUrl?: string            // specific SEC EDGAR page

  // Revenue data (from filing)
  reportedRevenueUsdBn?: number
  reportedNetIncomeUsdBn?: number
  revenueBySegment?: {
    segment: string
    revenueUsdBn: number
    percentOfTotal: number
  }[]
  revenueByGeography?: {
    region: string
    revenueUsdBn: number
    percentOfTotal: number
  }[]

  // Extracted risk factors (from Item 1A for 10-K)
  riskFactors: FilingRiskFactor[]

  // Aggregated summaries (AI-assisted — always cite riskFactors for evidence)
  geopoliticalRiskSummary: string    // must reference verbatim riskFactors
  supplyChainRiskSummary: string
  commodityRiskSummary: string
  regulatoryRiskSummary: string

  // Year-over-year changes
  newRisks: string[]               // risks appearing for first time
  escalatedRisks: string[]         // risks with stronger language than prior year
  resolvedRisks: string[]          // risks that disappeared

  // Key management quotes on geopolitics
  managementCommentary?: {
    quote: string                  // verbatim
    speaker: string                // "CEO", "CFO"
    context: string                // earnings call, letter to shareholders, etc.
    date: string                   // YYYY-MM-DD
  }[]

  confidence: Confidence
  extractedBy: 'human' | 'ai-assisted'
  extractedAt: string              // YYYY-MM-DD — when extraction was done
  attribution: Attribution
}
