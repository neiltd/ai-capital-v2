export type StrategicImportance = 'low' | 'medium' | 'high'
export type PortType = 'container' | 'oil' | 'lng' | 'bulk' | 'mixed'
export type CableStatus = 'active' | 'planned' | 'damaged' | 'unknown'

export interface Airport {
  id: string
  name: string
  countryId: string
  city: string
  iata?: string
  icao?: string
  coordinates: [number, number]
  passengerVolume?: number  // annual passengers
  cargoVolume?: number      // annual cargo tonnes
  strategicImportance: StrategicImportance
  notes?: string
}

export interface Seaport {
  id: string
  name: string
  countryId: string
  city: string
  coordinates: [number, number]
  type: PortType
  annualThroughput?: number  // TEU for container, tonnes for bulk
  strategicImportance: StrategicImportance
  notes?: string
}

export interface CableLandingPoint {
  name: string
  countryId: string
  coordinates: [number, number]
}

export interface SubmarineCable {
  id: string
  name: string
  route: [number, number][]
  landingPoints: CableLandingPoint[]
  status: CableStatus
  lengthKm?: number
  capacityTbps?: number
  owners?: string[]
  yearLaid?: number
  notes?: string
}
