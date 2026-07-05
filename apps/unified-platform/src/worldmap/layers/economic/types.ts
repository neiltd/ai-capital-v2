// ── Shared primitives ─────────────────────────────────────────────────────────

export type TradeVolume    = 'critical' | 'very_high' | 'high' | 'medium' | 'low'
export type RiskLevel      = 'low' | 'medium' | 'high'
export type RouteType      = 'shipping' | 'pipeline' | 'rail'

/**
 * Structured cargo taxonomy — enables typed filtering by cargo class.
 * Sits alongside the free-text `keyGoods` array which remains for display.
 * Future: Gemini enriches cargoCategories per route from intelligence modeling.
 */
export type CargoCategory =
  | 'crude-oil'
  | 'lng'
  | 'petroleum-products'
  | 'iron-ore'
  | 'grain'
  | 'coal'
  | 'container-goods'
  | 'chemicals'
  | 'automotive'
  | 'electronics'
  | 'rare-earths'
  | 'military'
  | 'general'

// ── Trade route ───────────────────────────────────────────────────────────────

/** Named endpoint — used for tooltip display and as legacy geometry fallback. */
export interface TradeRouteEndpoint {
  name: string
  coords: [number, number]  // [longitude, latitude]
}

export interface EconomicTradeRoute {
  id: string
  name: string

  /** Endpoint metadata — retained for tooltip display. */
  from: TradeRouteEndpoint
  to:   TradeRouteEndpoint

  /**
   * Multi-segment route geometry — ordered [longitude, latitude] waypoints.
   * When present, replaces the straight from→to line in rendering.
   * When absent, rendering falls back to [from.coords, to.coords].
   *
   * GeoJSON coordinate order: [longitude, latitude].
   * Antimeridian crossings handled by fixGeometry in lib/geo/antimeridian.ts —
   * provide natural negative longitudes; the fix makes them continuous.
   * Minimum 2 points. Frontend renders only — no coordinate inference here.
   */
  waypoints?: [number, number][]

  volume:       TradeVolume
  type:         RouteType
  annualValue:  string
  keyGoods:     string[]              // free-text, for display
  cargoCategories?: CargoCategory[]  // structured — for filtering

  riskLevel:            RiskLevel
  strategicImportance?: 'critical' | 'high' | 'medium' | 'low'

  notes: string

  // ── Lightweight entity linking ────────────────────────────────────────────
  // Enables "which routes are affected by this chokepoint?" queries
  // and "what is the bypass?" lookups — no graph DB needed.

  /** Chokepoint IDs this route passes through. Refs chokepoints[] entries. */
  chokepointIds?: string[]

  /** ID of the alternate route if this one is disrupted. */
  bypassRouteId?: string

  /** Origin geographic regions (ISO3 codes or descriptive region names). */
  sourceRegions?: string[]

  /** Destination geographic regions (ISO3 codes or descriptive region names). */
  destinationRegions?: string[]
}

// ── Strategic chokepoint ──────────────────────────────────────────────────────

export interface StrategicChokepoint {
  id:                 string
  name:               string
  coordinates:        [number, number]
  importance:         'critical' | 'high' | 'medium'
  dailyVessels:       number
  percentGlobalTrade: number
  controlledBy:       string[]   // ISO3 codes
  riskLevel:          RiskLevel
  summary:            string
  currentThreat:      string

  // ── Entity linking back to routes ─────────────────────────────────────────
  /** Trade route IDs that transit this chokepoint. */
  onRoutes?: string[]

  /**
   * Route ID that serves as bypass when this chokepoint is blocked.
   * E.g. CP-SUEZ → "TR-CAPE-OF-GOOD-HOPE"
   */
  alternateRouteId?: string
}
