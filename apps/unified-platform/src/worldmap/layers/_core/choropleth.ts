/**
 * Shared helper for country-fill choropleth layers (Water Stress, Food
 * Security). These are independent, layer-toggle-gated fills — distinct
 * from the main Country Heatmap (heatmapIndicator dropdown, exclusive mode,
 * red→amber→green ramp in lib/geo/indicators.ts, left untouched per spec).
 *
 * Each choropleth here gets its own small sequential ramp (dark→bright,
 * matching the "big number glows on the dark basemap" logic the design
 * doc's round-3 section describes for the main heatmap) so Water Stress and
 * Food Security are visually distinguishable from each other and from the
 * main heatmap when toggled on at the same time.
 */

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Interpolate a color ramp (array of [r,g,b]) at t ∈ [0,1]. */
export function rampColor(stops: Array<[number, number, number]>, t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  const seg = clamped * (stops.length - 1)
  const i = Math.min(Math.floor(seg), stops.length - 2)
  const localT = seg - i
  const [r0, g0, b0] = stops[i]
  const [r1, g1, b1] = stops[i + 1]
  const r = Math.round(lerp(r0, r1, localT))
  const g = Math.round(lerp(g0, g1, localT))
  const b = Math.round(lerp(b0, b1, localT))
  return `rgb(${r},${g},${b})`
}

// Dark → bright cyan-blue, used for Water Stress (low stress = dark/calm,
// extreme stress = bright).
export const WATER_STRESS_RAMP: Array<[number, number, number]> = [
  [12, 26, 38],
  [10, 60, 82],
  [8, 110, 140],
  [30, 170, 200],
  [110, 220, 235],
]

// Dark → bright amber-red, used for Food Security (secure = dark/calm,
// alarming = bright hot).
export const FOOD_SECURITY_RAMP: Array<[number, number, number]> = [
  [20, 16, 12],
  [90, 50, 20],
  [160, 80, 20],
  [214, 130, 30],
  [245, 180, 60],
]

export const NO_DATA_FILL = 'rgba(20,24,34,0.35)'
