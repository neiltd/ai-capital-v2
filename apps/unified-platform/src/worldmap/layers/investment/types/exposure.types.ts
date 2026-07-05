import type { ISO3, Direction, Magnitude, Timeline, Attribution } from './shared.types'
import type { GICSSector } from './asset.types'

/**
 * Sector-level geopolitical exposure profile.
 * Answers: "How does this sector connect to the geopolitical layer?"
 */
export interface SectorExposureProfile {
  id: string         // "sector-semiconductors", "sector-energy"
  name: string       // "Semiconductors", "Energy"
  gicsSector: GICSSector
  gicsIndustries: string[]   // more granular sub-industries

  geopoliticalSensitivity: 'extreme' | 'high' | 'medium' | 'low'

  // Country exposures
  countryExposures: {
    countryId: ISO3
    exposureType: 'revenue' | 'supply-chain' | 'manufacturing' | 'regulation' | 'competition'
    direction: Direction
    magnitude: Magnitude
    mechanism: string    // HOW the exposure works
    historicalPrecedent?: string
  }[]

  // Chokepoint exposures
  chokepointExposures: {
    chokepointId: string
    name: string
    exposureType: 'supply-chain' | 'logistics' | 'energy'
    direction: Direction
    magnitude: Magnitude
    annualTradeValueUsdBn?: number
    note: string
  }[]

  // Trade route exposures
  tradeRouteExposures: {
    routeId: string
    name: string
    magnitude: Magnitude
    note: string
  }[]

  // Commodity exposures
  commodityExposures: {
    commodity: string
    role: 'input' | 'output' | 'priceDriver'
    direction: Direction    // positive price = positive or negative for this sector
    magnitude: Magnitude
    note: string
  }[]

  // Key vulnerabilities
  vulnerabilities: {
    id: string
    title: string
    description: string
    triggerEvents: string[]  // what geopolitical events trigger this
    magnitude: Magnitude
    timeline: Timeline
  }[]

  // Key opportunities
  opportunities: {
    id: string
    title: string
    description: string
    triggerEvents: string[]
    magnitude: Magnitude
    timeline: Timeline
  }[]

  // Key flags
  flags: {
    energyIntensity: 'high' | 'medium' | 'low'
    tradeRouteDependent: boolean
    singleCountryConcentrationRisk: boolean  // >50% from one country
    exportControlSensitive: boolean
    sanctionsSensitive: boolean
    cyberInfrastructureVulnerable: boolean
    dualUse: boolean    // civilian + military applications
  }

  attribution: Attribution
}

/**
 * Commodity exposure mapping.
 * Answers: "Which countries, conflicts, and chokepoints affect this commodity's price?"
 */
export interface CommodityExposureMap {
  commodity: string           // "Brent Crude Oil", "DRAM Memory", "Lithium"
  unit: string                // "USD/barrel", "USD/kg", etc.

  // Production geography
  majorProducers: {
    countryId: ISO3
    shareOfGlobalProduction: number  // percent
    geopoliticalRisk: Magnitude
    note: string
  }[]

  // Transit dependency
  transitChokepoints: {
    chokepointId: string
    name: string
    percentOfGlobalFlowThrough: number
    riskLevel: Magnitude
  }[]

  // What moves this commodity's price
  priceDrivers: {
    type: 'supply' | 'demand' | 'geopolitical' | 'currency' | 'speculation'
    description: string
    direction: Direction
    magnitude: Magnitude
  }[]

  // Who benefits / loses from price increase
  beneficiaries: {
    type: 'country' | 'sector' | 'company-type'
    description: string
    direction: Direction
  }[]
  losers: {
    type: 'country' | 'sector' | 'company-type'
    description: string
    direction: Direction
  }[]

  attribution: Attribution
}
