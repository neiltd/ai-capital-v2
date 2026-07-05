export type ConflictIntensity = 'critical' | 'high' | 'medium' | 'low'
export type ConflictStatus = 'active' | 'escalating' | 'de-escalating' | 'ceasefire'
export type ConflictType =
  | 'armed_conflict'
  | 'civil_war'
  | 'territorial_dispute'
  | 'naval_tension'
  | 'frozen_conflict'

export interface ConflictParty {
  countryName: string
  role: string
}

export interface GeopoliticalConflict {
  id: string
  name: string
  type: ConflictType
  intensity: ConflictIntensity
  status: ConflictStatus
  startYear: number
  coordinates: [number, number]
  region: string
  parties: ConflictParty[]
  summary: string
  currentStatus: string
  casualties: string
  internationalInvolvement: string
}

export interface ConflictZoneProperties {
  id: string
  name: string
  intensity: ConflictIntensity
  type: string
  description: string
}
