import type { Direction, Magnitude, Timeline, Confidence, EvidenceChain, SourceRef, GeneratedBy } from './shared.types'
import type { ISO3 } from './shared.types'

export type ThesisType =
  | 'geopolitical-risk'           // event creates downside risk for asset
  | 'geopolitical-opportunity'    // event creates upside opportunity
  | 'supply-chain-disruption'     // supply chain disrupted → winners & losers
  | 'commodity-price-impact'      // commodity price moves → sector effects
  | 'sector-rotation'             // capital rotates from exposed to unexposed sectors
  | 'infrastructure-exposure'     // infrastructure event (cable cut, port closed)
  | 'regulatory-change'           // sanctions, export controls, tariffs
  | 'currency-impact'             // geopolitical event affects currency

export type ThesisStatus = 'draft' | 'review' | 'active' | 'monitoring' | 'invalidated' | 'resolved'

/**
 * The full investment thesis — the terminal output of the intelligence pipeline.
 *
 * HARD RULE: No thesis may exist without at least one EvidenceChain.
 * No AI-generated analysis is valid without source attribution.
 */
export interface InvestmentThesis {
  id: string
  title: string
  thesisType: ThesisType
  status: ThesisStatus
  createdAt: string       // YYYY-MM-DD
  lastUpdated: string

  // ── The pipeline (required to trace reasoning) ─────────────────────────────

  /** Layer 1: The geopolitical trigger */
  geopoliticalLayer: {
    intelligenceEventId?: string    // links to IntelligenceEvent
    description: string             // what happened
    tier: 1 | 2 | 3
    countriesInvolved: ISO3[]
    conflictsInvolved?: string[]    // conflict IDs
    infrastructureInvolved?: string[] // port/cable/chokepoint IDs
    tradeRoutesInvolved?: string[]
  }

  /** Layer 2: Infrastructure and supply chain effects */
  supplyChainLayer: {
    description: string             // how the supply chain is affected
    affectedChokepoints?: { id: string; name: string; impact: string }[]
    affectedPorts?: { id: string; name: string; impact: string }[]
    affectedRoutes?: { id: string; name: string; impact: string }[]
    propagationPath: string[]       // ordered steps: e.g. ["Suez Canal blocked", "Shipping diverts via Cape", "Freight rates +40%"]
  }

  /** Layer 3: Sector and company exposure */
  exposureLayer: {
    affectedSectors: {
      sectorId: string
      sectorName: string
      direction: Direction
      magnitude: Magnitude
      mechanism: string
    }[]
    keyCompanies: {
      companyId: string
      ticker: string
      name: string
      direction: Direction
      magnitude: Magnitude
      exposureReason: string
      filingRef?: string     // CompanyFiling ID confirming exposure
    }[]
    commoditiesAffected?: {
      commodity: string
      direction: Direction
      mechanism: string
    }[]
  }

  /** Layer 4: Market impact */
  marketImpactLayer: {
    beneficiaries: {
      assetId: string
      ticker?: string
      name: string
      reason: string
      timeline: Timeline
      confidence: Confidence
    }[]
    losers: {
      assetId: string
      ticker?: string
      name: string
      reason: string
      timeline: Timeline
      confidence: Confidence
    }[]
    hedges?: {
      asset: string
      rationale: string
    }[]
  }

  // ── The thesis itself ──────────────────────────────────────────────────────

  thesis: string            // 3–5 sentence investment thesis — the core argument
  timeHorizon: Timeline
  magnitude: Magnitude      // how big a market impact do you expect?

  risks: {
    description: string     // what would make this thesis wrong?
    probability: 'high' | 'medium' | 'low'
  }[]

  catalysts: {
    description: string     // what would confirm or accelerate the thesis?
    timeline: Timeline
  }[]

  invalidationConditions: string[]  // specific events that would invalidate this thesis

  // ── Evidence (REQUIRED — every claim must be backed) ──────────────────────

  evidenceChains: EvidenceChain[]   // minimum 1 — no thesis without evidence
  keyFilings?: string[]              // CompanyFiling IDs that directly support this
  keyEvents?: string[]               // IntelligenceEvent IDs

  // ── Metadata ──────────────────────────────────────────────────────────────

  confidence: Confidence
  generatedBy: GeneratedBy
  analyst?: string
  reviewStatus?: 'unreviewed' | 'reviewed' | 'approved'
  sources: SourceRef[]      // minimum 1 required
  tags: string[]            // e.g. ["semiconductors", "Taiwan", "China", "NVDA"]
}
