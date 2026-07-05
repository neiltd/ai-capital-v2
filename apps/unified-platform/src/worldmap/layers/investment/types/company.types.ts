import type { ISO3, Ticker, Magnitude, Attribution } from './shared.types'
import type { ExchangeId, GICSSector } from './asset.types'

/** Revenue breakdown by geography */
export interface GeographicRevenue {
  region: string           // "United States", "China", "Europe", etc.
  countryIds?: ISO3[]      // specific countries if known
  percentOfRevenue: number
  revenueUsdBn?: number
  year: number
  note?: string
}

/** A node in the company's supply chain */
export interface SupplyChainNode {
  role: 'supplier' | 'customer' | 'manufacturer' | 'distributor' | 'logistics' | 'partner'
  name: string             // company or entity name
  countryId: ISO3
  city?: string
  percentOfSupply?: number
  percentOfRevenue?: number
  isConcentrationRisk: boolean   // single point of failure
  strategicNote: string
}

/** Commodity the company depends on (as input) or produces (as output) */
export interface CommodityDependency {
  commodity: string        // "Crude Oil", "DRAM", "Rare Earth Elements"
  role: 'input' | 'output' | 'byproduct'
  percentOfCOGS?: number   // for inputs
  percentOfRevenue?: number // for outputs
  primarySupplyCountries: ISO3[]
  isHedged: boolean
  hedgingNote?: string
  geopoliticalRisk: Magnitude
  note: string
}

/** Geopolitical risk exposure by region */
export interface RegionalExposure {
  region: string
  countryIds: ISO3[]
  exposureType: 'revenue' | 'supply-chain' | 'manufacturing' | 'regulatory' | 'debt'
  magnitude: Magnitude
  note: string
  // Filed risk factor references
  filingRefs?: string[]   // FilingRiskFactor IDs where this is documented
}

/** Infrastructure the company depends on */
export interface InfrastructureDependency {
  type: 'port' | 'airport' | 'cable' | 'trade-route' | 'chokepoint' | 'pipeline' | 'rail'
  entityId: string     // ID from infrastructure layer
  name: string
  importance: Magnitude
  note: string
}

export interface CompanyProfile {
  id: string            // "COMPANY-NVDA"
  ticker: Ticker
  name: string
  exchange: ExchangeId
  gicsSector: GICSSector
  gicsIndustryGroup: string
  gicsIndustry: string
  countryOfIncorporation: ISO3
  countryOfHQ: ISO3
  marketCapUsdBn?: number
  revenueUsdBn?: number
  fiscalYear: number

  // Business description
  description: string
  businessModel: string   // how the company makes money
  geopoliticalSummary: string  // 2-3 sentences on overall geo exposure

  // Geographic revenue breakdown
  revenueByGeography: GeographicRevenue[]

  // Supply chain
  keySuppliers: SupplyChainNode[]
  keyCustomers: SupplyChainNode[]
  manufacturingLocations: {
    countryId: ISO3
    city?: string
    percentOfCapacity?: number
    note: string
  }[]

  // Commodity dependencies
  commodityDependencies: CommodityDependency[]

  // Regional geopolitical exposure
  regionalExposures: RegionalExposure[]

  // Infrastructure dependencies
  infrastructureDependencies: InfrastructureDependency[]

  // Priority flag exposures (structured for fast querying)
  flags: {
    chinaRevenuePct?: number           // % of revenue from China
    chinaManufacturingDependent: boolean
    russiaExposed: boolean
    middleEastEnergyDependent: boolean
    taiwanSemiconductorDependent: boolean  // critical for tech companies
    redSeaTradeRouteDependent: boolean
    straitOfHormuzDependent: boolean
    sanctionsSensitive: boolean
    exportControlSensitive: boolean    // ITAR, EAR, etc.
  }

  // 10-K filing references
  latestFilingId?: string    // links to CompanyFiling
  secCik?: string            // SEC Central Index Key
  secEdgarUrl?: string

  attribution: Attribution
}
