import type { Direction, Magnitude, Timeline, Confidence, EvidenceItem, Attribution } from './shared.types'

/** A single asset affected by an event */
export interface AssetImpact {
  assetId: string      // links to Asset
  ticker?: string
  assetName: string
  direction: Direction
  magnitude: Magnitude
  timeline: Timeline
  mechanism: string    // the exact causal chain — how the event affects this asset
  priceImpactEstimatePct?: number   // rough estimate, always set confidence to low
  confidence: Confidence
  evidenceRefs: string[]   // EvidenceItem IDs
}

/**
 * Supply chain impact path.
 * Traces HOW a geopolitical event propagates through the supply chain.
 */
export interface SupplyChainImpactPath {
  step: number
  layer: 'geopolitical' | 'infrastructure' | 'logistics' | 'production' | 'distribution' | 'market'
  description: string
  affectedEntities: {
    type: 'country' | 'chokepoint' | 'trade-route' | 'port' | 'airport' | 'company' | 'sector'
    id?: string
    name: string
  }[]
  timeDelay?: string   // e.g. "immediate", "2-4 weeks"
}

/**
 * Full event-to-asset impact analysis.
 * The core analytical product of the intelligence engine.
 */
export interface NewsToAssetImpact {
  id: string
  intelligenceEventId: string    // links to IntelligenceEvent from intelligence layer
  eventTitle: string
  analysisDate: string           // YYYY-MM-DD

  // What happened
  eventSummary: string
  eventTier: 1 | 2 | 3          // from IntelligenceEvent

  // Supply chain propagation path
  propagationPath: SupplyChainImpactPath[]

  // Sector-level impacts
  sectorImpacts: {
    sectorId: string
    sectorName: string
    direction: Direction
    magnitude: Magnitude
    timeline: Timeline
    keyMechanism: string
    evidence: EvidenceItem[]
  }[]

  // Specific asset impacts
  beneficiaries: AssetImpact[]
  losers: AssetImpact[]
  neutral: AssetImpact[]        // affected but direction unclear

  // Geographic impacts
  countryImpacts: {
    countryId: string
    direction: Direction
    aspect: string    // "exports", "currency", "FDI", "growth"
    note: string
  }[]

  // Commodity impacts
  commodityImpacts: {
    commodity: string
    direction: Direction
    magnitude: Magnitude
    mechanism: string
  }[]

  // Metadata
  confidence: Confidence
  generatedBy: 'human' | 'ai-assisted'
  analyst?: string
  reviewedBy?: string
  sources: Attribution['sources']
  lastUpdated: string
}
