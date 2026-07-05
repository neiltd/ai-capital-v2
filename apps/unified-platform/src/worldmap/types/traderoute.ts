export type TradeVolume = 'critical' | 'very_high' | 'high' | 'medium' | 'low'

export interface TradeRoute {
  id: string
  name: string
  from: { name: string; coords: [number, number] }
  to: { name: string; coords: [number, number] }
  volume: TradeVolume
  type: 'shipping' | 'pipeline' | 'rail'
  annualValue: string
  keyGoods: string[]
  riskLevel: 'low' | 'medium' | 'high'
  notes: string
}

export interface Chokepoint {
  id: string
  name: string
  coordinates: [number, number]
  importance: 'critical' | 'high' | 'medium'
  dailyVessels: number
  percentGlobalTrade: number
  controlledBy: string[]
  riskLevel: 'low' | 'medium' | 'high'
  summary: string
  currentThreat: string
}
