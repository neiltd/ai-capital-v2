export type ConflictType =
  | 'armed_conflict'
  | 'civil_war'
  | 'territorial_dispute'
  | 'naval_tension'
  | 'frozen_conflict'

export type ConflictIntensity = 'critical' | 'high' | 'medium' | 'low'

export interface ConflictParty {
  countryId: string
  countryName: string
  role: string
}

export interface Conflict {
  id: string
  name: string
  type: ConflictType
  intensity: ConflictIntensity
  status: 'active' | 'ceasefire' | 'escalating' | 'de-escalating'
  startYear: number
  coordinates: [number, number] // [longitude, latitude]
  region: string
  parties: ConflictParty[]
  summary: string
  currentStatus: string
  casualties: string
  internationalInvolvement: string
}
