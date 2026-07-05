import type { ISO3, Direction, Magnitude, Timeline, EvidenceItem, Attribution } from './shared.types'

/**
 * A single step in the event-to-market impact pipeline.
 * Each step must be traceable to evidence.
 */
export interface PipelineStep {
  step: number
  layer: 'geopolitical' | 'infrastructure' | 'supply-chain' | 'sector' | 'company' | 'market'
  title: string
  description: string
  entities: {
    type: 'country' | 'chokepoint' | 'trade-route' | 'port' | 'airport' | 'cable' | 'company' | 'sector' | 'commodity'
    id?: string
    name: string
    direction?: Direction
  }[]
  evidence: EvidenceItem[]      // what supports this step
  timeDelay?: string            // how long for this step to manifest
}

/**
 * The full geopolitical-to-market impact pipeline.
 * This is the reasoning backbone — everything connects through this.
 *
 * Geopolitical Event
 *   → Infrastructure/Supply Chain Exposure
 *   → Company/Sector Exposure
 *   → Market Impact
 *   → Investment Thesis
 *   → Evidence Chain
 */
export interface ImpactPipeline {
  id: string
  intelligenceEventId: string    // the triggering geopolitical event
  eventTitle: string
  pipelineDate: string           // YYYY-MM-DD

  // Ordered steps tracing the full causal chain
  steps: PipelineStep[]

  // Output: theses generated from this pipeline
  generatedThesisIds: string[]   // InvestmentThesis IDs

  confidence: 'high' | 'medium' | 'low'
  generatedBy: 'human' | 'ai-assisted'
  lastUpdated: string
}

/**
 * Sector-level geopolitical reasoning.
 * Pre-computed reasoning for each priority sector — the "always-on" intelligence.
 *
 * This answers: "For Semiconductors, what do we always need to watch geopolitically?"
 */
export interface SectorGeopoliticalReasoning {
  sectorId: string
  sectorName: string
  lastUpdated: string

  // Structural vulnerabilities — always present regardless of current events
  structuralVulnerabilities: {
    id: string
    title: string
    description: string
    geographicRoots: ISO3[]        // which countries this depends on
    infrastructureRoots?: string[] // which chokepoints/routes
    magnitude: Magnitude
    mitigationStatus: 'none' | 'partial' | 'well-hedged'
    examples: string[]             // real examples of this vulnerability manifesting
  }[]

  // Watch signals — what to monitor for early warning
  watchSignals: {
    signal: string              // what to watch
    source: string              // where to monitor (e.g. "Taiwan Strait activity", "TSMC guidance")
    threshold: string           // when it becomes significant
    potentialImpact: string
  }[]

  // Historical precedents — past events and what happened
  historicalPrecedents: {
    event: string
    year: number
    impact: string
    magnitude: Magnitude
    duration: string
    keyLessons: string[]
  }[]

  // Current risk landscape (updated manually)
  currentRiskLevel: Magnitude
  currentRiskNarrative: string   // 2-3 sentences on current state

  // Key companies most exposed (pre-identified)
  mostExposedCompanies: {
    ticker: string
    name: string
    primaryExposure: string
    magnitude: Magnitude
    direction: Direction
  }[]

  attribution: Attribution
}

/**
 * Investment signal — a specific actionable signal for an asset.
 * Always backed by evidence. Always has a source.
 */
export interface InvestmentSignal {
  id: string
  ticker: string
  assetName: string
  signalType: 'risk' | 'opportunity' | 'watch' | 'hedge'
  direction: Direction
  magnitude: Magnitude
  timeline: Timeline
  confidence: 'high' | 'medium' | 'low'

  thesis: string          // 2-3 sentences — the signal thesis
  trigger: string         // what geopolitical event/condition drives this signal
  mechanism: string       // the exact causal mechanism

  // Evidence (required)
  supportingThesisIds: string[]      // InvestmentThesis IDs
  supportingFilingIds: string[]      // CompanyFiling IDs with relevant disclosures
  supportingEventIds: string[]       // IntelligenceEvent IDs

  invalidationConditions: string[]

  createdAt: string
  lastUpdated: string
  attribution: Attribution
}
