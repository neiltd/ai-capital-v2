/**
 * Antimeridian-safe geometry utilities for MapLibre GL JS.
 *
 * MapLibre renders coordinates outside [-180, 180] correctly — it wraps
 * the tile grid. So the fix is NOT to clamp to ±180, but to make each
 * coordinate *continuous* with the previous one. A coordinate sequence
 * like [170, 190, 210] renders as a line going east across the Pacific;
 * [170, -170, -150] would draw the same geometry as a world-spanning artifact.
 *
 * Affected countries at 110m resolution: Fiji, Russia, USA/Alaska.
 * Affected layer data: trans-Pacific trade routes, submarine cables.
 *
 * No React dependencies. All functions are pure and deterministic.
 *
 * Future: if switching to a higher-resolution topology (e.g. 50m or 10m),
 * re-run fixFeatureCollection on the new file and verify the same countries
 * render cleanly. The algorithm is resolution-independent.
 */

type Coord = [number, number]
type Ring  = Coord[]

/** Adjust `lng` so it is within 180° of `ref`, without clamping to ±180. */
function continuousLng(ref: number, lng: number): number {
  let adjusted = lng
  while (adjusted - ref >  180) adjusted -= 360
  while (adjusted - ref < -180) adjusted += 360
  return adjusted
}

/** Walk a coordinate sequence and make each point continuous with the previous. */
function makeRingContinuous(coords: Ring): Ring {
  if (coords.length === 0) return coords
  const out: Ring = [coords[0]]
  for (let i = 1; i < coords.length; i++) {
    const lng = continuousLng(out[i - 1][0], coords[i][0])
    out.push([lng, coords[i][1]])
  }
  return out
}

/** Normalize a raw [lng, lat] pair into [-180, 180]. */
export function normalizeLng(coord: Coord): Coord {
  let lng = coord[0]
  while (lng >  180) lng -= 360
  while (lng < -180) lng += 360
  return [lng, coord[1]]
}

/** Return true if a coordinate is safe (non-null, non-NaN, non-origin). */
export function isValidCoord(c: Coord | undefined | null): c is Coord {
  if (!c) return false
  const [lng, lat] = c
  if (isNaN(lng) || isNaN(lat)) return false
  if (lng === 0 && lat === 0) return false
  return true
}

// ── Geometry fixers ──────────────────────────────────────────────────────────

function fixLineString(coords: Ring): Ring {
  return makeRingContinuous(coords)
}

function fixPolygon(rings: Ring[]): Ring[] {
  return rings.map(makeRingContinuous)
}

function fixMultiLineString(lines: Ring[]): Ring[] {
  return lines.map(makeRingContinuous)
}

function fixMultiPolygon(polys: Ring[][]): Ring[][] {
  return polys.map(fixPolygon)
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Fix antimeridian crossings in a single GeoJSON geometry object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixGeometry(geometry: any): any {
  if (!geometry) return geometry
  switch (geometry.type) {
    case 'LineString':
      return { ...geometry, coordinates: fixLineString(geometry.coordinates) }
    case 'Polygon':
      return { ...geometry, coordinates: fixPolygon(geometry.coordinates) }
    case 'MultiLineString':
      return { ...geometry, coordinates: fixMultiLineString(geometry.coordinates) }
    case 'MultiPolygon':
      return { ...geometry, coordinates: fixMultiPolygon(geometry.coordinates) }
    default:
      return geometry
  }
}

/** Fix antimeridian crossings for every feature in a GeoJSON FeatureCollection. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixFeatureCollection(fc: any): any {
  return {
    ...fc,
    features: fc.features.map((f: any) => ({ ...f, geometry: fixGeometry(f.geometry) })),
  }
}
