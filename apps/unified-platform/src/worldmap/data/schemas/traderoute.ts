/**
 * Zod validation schema for trade-routes.json.
 *
 * Run via the existing validation pipeline:
 *   npx tsx scripts/validate-data.ts (extend SCHEMA_MAP to include 'traderoute')
 *
 * Or validate standalone:
 *   node -e "require('./scripts/validate-traderoutes.ts')"
 */

import { z } from 'zod'

const Coord = z.tuple([z.number().min(-180).max(360), z.number().min(-90).max(90)])
  // Note: longitude max is 360 to allow continuous antimeridian coordinates
  // (e.g. 191 = -169 expressed as continuous from 170). fixGeometry handles rendering.

const TradeVolume = z.enum(['critical', 'very_high', 'high', 'medium', 'low'])
const RiskLevel   = z.enum(['low', 'medium', 'high'])
const RouteType   = z.enum(['shipping', 'pipeline', 'rail'])

const CargoCategory = z.enum([
  'crude-oil', 'lng', 'petroleum-products',
  'iron-ore', 'grain', 'coal',
  'container-goods', 'chemicals', 'automotive',
  'electronics', 'rare-earths', 'military', 'general',
])

const TradeRouteEndpointSchema = z.object({
  name:   z.string().min(1),
  coords: Coord,
})

export const TradeRouteSchema = z.object({
  id:   z.string().min(1).regex(/^TR-/, 'Route IDs must start with TR-'),
  name: z.string().min(1),
  from: TradeRouteEndpointSchema,
  to:   TradeRouteEndpointSchema,

  waypoints: z.array(Coord).min(2).optional(),

  volume:      TradeVolume,
  type:        RouteType,
  annualValue: z.string().min(1),
  keyGoods:    z.array(z.string()).min(1),
  cargoCategories: z.array(CargoCategory).optional(),

  riskLevel:           RiskLevel,
  strategicImportance: z.enum(['critical', 'high', 'medium', 'low']).optional(),

  notes: z.string().min(1),

  chokepointIds:     z.array(z.string().regex(/^CP-/)).optional(),
  bypassRouteId:     z.string().regex(/^TR-/).optional(),
  sourceRegions:     z.array(z.string()).optional(),
  destinationRegions:z.array(z.string()).optional(),
})

export const ChokepointSchema = z.object({
  id:   z.string().min(1).regex(/^CP-/, 'Chokepoint IDs must start with CP-'),
  name: z.string().min(1),
  coordinates:        Coord,
  importance:         z.enum(['critical', 'high', 'medium']),
  dailyVessels:       z.number().int().min(0),
  percentGlobalTrade: z.number().min(0).max(100),
  controlledBy:       z.array(z.string().length(3)),
  riskLevel:          RiskLevel,
  summary:            z.string().min(1),
  currentThreat:      z.string(),

  onRoutes:         z.array(z.string().regex(/^TR-/)).optional(),
  alternateRouteId: z.string().regex(/^TR-/).optional(),
})

export const TradeRoutesFileSchema = z.object({
  routes:      z.array(TradeRouteSchema),
  chokepoints: z.array(ChokepointSchema),
})

export type TradeRouteData    = z.infer<typeof TradeRouteSchema>
export type ChokepointData    = z.infer<typeof ChokepointSchema>
export type TradeRoutesFile   = z.infer<typeof TradeRoutesFileSchema>
