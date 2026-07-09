/**
 * Facility-detail density helpers (world-map-v2 round 3).
 *
 * One global rail control — "Facility detail: Key / All" — replaces any
 * per-layer decluttering switch. Each point-facility layer bakes a boolean
 * `isKey` property into its GeoJSON (its own judgment call on which field
 * defines "key", documented per layer) and calls these two helpers to build
 * its filter + paint expressions:
 *
 *   filter: combineFilter(existingFilter, density)
 *   'circle-radius':  densityScale(RADIUS_EXPR)
 *   'circle-opacity': densityScale(OPACITY_EXPR)
 *
 * Mechanism:
 *   - density === 'key' → filter hides every feature with isKey !== true.
 *     Radius/opacity expressions are used as-is (only key features render).
 *   - density === 'all' → filter shows everything. Non-key features render
 *     at ~55-60% of their normal radius/opacity at world zoom and grow to
 *     100% by zoom 5 (MapLibre ['interpolate','linear',['zoom'], …]) so the
 *     morning picture stays readable while every facility is individually
 *     visible and clickable (no clustering — the reviewer explicitly wants
 *     to see every point).
 *
 * Layers whose source data has no usable tier/importance field (documented
 * per-layer) skip the isKey property entirely and are always shown — see
 * MciLayer / EnergyMixLayer.
 */

export type Density = 'key' | 'all'

// MapLibre expression type is intentionally loose here — every call site
// already casts through `unknown as number` / `unknown as string`, matching
// the convention used throughout the existing layer files.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any

const IS_KEY: Expr = ['==', ['get', 'isKey'], true]

/**
 * Combine a layer's own filter (or `true` for "no extra filter") with the
 * density gate. In 'all' mode, no isKey filtering is applied.
 */
export function densityFilter(density: Density, ownFilter: Expr = true): Expr {
  if (density === 'key') {
    return ownFilter === true ? IS_KEY : ['all', ownFilter, IS_KEY]
  }
  return ownFilter
}

/**
 * Scale a radius/opacity expression down for non-key points at world zoom,
 * growing to full size by zoom 5. Key points (or every point in 'key' mode,
 * where non-key points are already filtered out) always render at 100%.
 *
 * MapLibre requires a `["zoom"]` read to be the direct input of a top-level
 * `interpolate`/`step` expression — it can't be nested inside `case`/`*`.
 * So the interpolate-on-zoom has to be the outermost expression here, with
 * the per-feature `case`/multiplication living inside its stops instead of
 * wrapping it.
 */
export function densityScale(density: Density, expr: Expr): Expr {
  if (density === 'key') return expr
  return [
    'interpolate', ['linear'], ['zoom'],
    1, ['*', expr, ['case', IS_KEY, 1, 0.58]],
    5, expr,
  ]
}
