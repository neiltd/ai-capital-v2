export type EnergySource =
  | 'coal' | 'gas' | 'oil' | 'nuclear'
  | 'hydro' | 'solar' | 'wind' | 'otherRenewables'

export interface EnergyMix {
  coal?: number
  gas?: number
  oil?: number
  nuclear?: number
  hydro?: number
  solar?: number
  wind?: number
  otherRenewables?: number
}

export interface CountryUtilityProfile {
  countryId: string
  electricityConsumptionTWh?: number
  electricityMix: EnergyMix
  waterStressScore?: number       // 0–5 (0 = no stress, 5 = extreme)
  foodSecurityScore?: number      // 0–100 (higher = more secure)
  aiAdoptionPercent?: number      // % of GDP attributed to AI sector
  gdpBySector: {
    sector: string
    percentOfGDP: number
  }[]
  lastUpdated?: string
}

export type PowerPlantType =
  | 'coal' | 'gas' | 'oil' | 'nuclear' | 'hydro'
  | 'solar' | 'wind' | 'geothermal' | 'biomass' | 'other'

export interface PowerPlant {
  id: string
  name: string
  countryId: string
  coordinates: [number, number]
  type: PowerPlantType
  capacityMW?: number
  status: 'operating' | 'construction' | 'planned' | 'decommissioned'
  notes?: string
}
