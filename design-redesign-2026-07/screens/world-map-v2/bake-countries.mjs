// bake-countries.mjs — one-off generator for countries-geo.ts
//
// Reads the repo's real production geodata (apps/unified-platform/public/
// countries-110m.json, the same file the future MapLibre basemap uses),
// converts TopoJSON → GeoJSON, simplifies each ring (Douglas–Peucker,
// tolerance in degrees), and emits countries-geo.ts with per-country
// polygon rings so the SVG mockup can draw real country borders and fill
// real country shapes for choropleth / ally-rival shading.
//
// Run:  node bake-countries.mjs   (from this directory)

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire('/Users/thanapold/Desktop/Projects.nosync/apps/unified-platform/package.json')
const topojson = require('topojson-client')

const TOPO = '/Users/thanapold/Desktop/Projects.nosync/apps/unified-platform/public/countries-110m.json'
const OUT = new URL('./countries-geo.ts', import.meta.url).pathname

// ISO 3166-1 numeric → alpha-3 for every country the mockup's sample data,
// COUNTRY_INDEX, or relationship demos reference. Others render with name only.
const NUM_TO_ISO3 = {
  '004': 'AFG', '036': 'AUS', '076': 'BRA', '104': 'MMR', '124': 'CAN',
  '156': 'CHN', '158': 'TWN', '180': 'COD', '250': 'FRA', '276': 'DEU',
  '356': 'IND', '364': 'IRN', '368': 'IRQ', '392': 'JPN', '408': 'PRK',
  '410': 'KOR', '418': 'LAO', '484': 'MEX', '524': 'NPL', '578': 'NOR',
  '586': 'PAK', '604': 'PER', '616': 'POL', '643': 'RUS', '682': 'SAU',
  '699': 'IND', '702': 'SGP', '704': 'VNM', '710': 'ZAF', '724': 'ESP',
  '729': 'SDN', '764': 'THA', '784': 'ARE', '804': 'UKR', '818': 'EGY',
  '826': 'GBR', '840': 'USA', '887': 'YEM', '116': 'KHM', '458': 'MYS',
  '360': 'IDN', '608': 'PHL', '376': 'ISR', '792': 'TUR', '380': 'ITA',
}

// Douglas–Peucker on [lng, lat] rings.
function dp(points, tol) {
  if (points.length <= 3) return points
  const keep = new Array(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let maxD = 0, idx = -1
    const [ax, ay] = points[a], [bx, by] = points[b]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      let d
      if (len2 === 0) d = Math.hypot(px - ax, py - ay)
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      }
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = true
      stack.push([a, idx], [idx, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

// Antimeridian handling: rings that cross ±180° (Russia, Fiji, US Aleutians)
// would otherwise draw a horizontal band across the whole equirectangular
// canvas (same failure mode as the round-2 route zigzag, but for polygons).
// Unwrap the ring to a continuous longitude space, then Sutherland–Hodgman
// clip it against the [-180, 180] window, shifting the overflow piece back.
function unwrapRing(ring) {
  const out = [ring[0].slice()]
  for (let i = 1; i < ring.length; i++) {
    const prev = out[i - 1][0]
    let lng = ring[i][0]
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    out.push([lng, ring[i][1]])
  }
  return out
}

/** Clip ring to half-plane keep: lng <= edge (side=1) or lng >= edge (side=-1). */
function clipHalf(ring, edge, side) {
  const inside = ([lng]) => side * (edge - lng) >= 0
  const out = []
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i]
    const prev = ring[(i + ring.length - 1) % ring.length]
    const curIn = inside(cur)
    const prevIn = inside(prev)
    if (curIn !== prevIn) {
      const f = (edge - prev[0]) / (cur[0] - prev[0])
      out.push([edge, prev[1] + f * (cur[1] - prev[1])])
    }
    if (curIn) out.push(cur)
  }
  return out
}

/** Split a lng/lat ring into rings fully inside [-180, 180]. */
function splitRing(ring) {
  const un = unwrapRing(ring)
  const lngs = un.map(([lng]) => lng)
  if (Math.max(...lngs) <= 180 && Math.min(...lngs) >= -180) return [un]
  const pieces = []
  const main = clipHalf(clipHalf(un, 180, 1), -180, -1)
  if (main.length >= 4) pieces.push(main)
  const east = clipHalf(un, 180, -1).map(([lng, lat]) => [lng - 360, lat])
  if (east.length >= 4) pieces.push(east)
  const west = clipHalf(un, -180, 1).map(([lng, lat]) => [lng + 360, lat])
  if (west.length >= 4) pieces.push(west)
  return pieces
}

const topo = JSON.parse(readFileSync(TOPO, 'utf8'))
const geo = topojson.feature(topo, topo.objects.countries)

const TOL = 0.35 // degrees — coarse but recognizable at 960×480
const countries = []
let totalPts = 0

for (const f of geo.features) {
  const name = f.properties?.name ?? 'Unknown'
  if (name === 'Antarctica') continue // matches the round-1 basemap crop
  const iso = NUM_TO_ISO3[String(f.id).padStart(3, '0')]
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  const rings = []
  for (const poly of polys) {
    // outer ring only — holes are invisible at this scale
    for (const piece of splitRing(poly[0])) {
      const simplified = dp(piece, TOL).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100])
      if (simplified.length >= 4) rings.push(simplified)
    }
  }
  if (rings.length === 0) continue
  totalPts += rings.reduce((n, r) => n + r.length, 0)
  countries.push({ iso, name, rings })
}

const lines = countries.map((c) => {
  const ringsStr = c.rings.map((r) => `[${r.map(([x, y]) => `[${x},${y}]`).join(',')}]`).join(',')
  return `  { ${c.iso ? `iso: '${c.iso}', ` : ''}name: ${JSON.stringify(c.name)}, rings: [${ringsStr}] },`
})

writeFileSync(OUT, `// countries-geo.ts — GENERATED by bake-countries.mjs. Do not hand-edit.
//
// Real country polygons, simplified for the SVG mockup: extracted from the
// repo's production geodata (apps/unified-platform/public/countries-110m.json,
// Natural Earth 110m via world-atlas — the same file the production MapLibre
// basemap will render), Douglas–Peucker simplified at ${TOL}° tolerance,
// Antarctica dropped, holes dropped. ${countries.length} countries, ${totalPts} points.
//
// This file exists so the review mockup can show REAL country border lines and
// fill REAL country shapes for choropleth / ally-rival shading (round-3 review
// feedback). Production does not import this — it renders the full-resolution
// countries-110m.json in MapLibre directly.

export interface CountryShape {
  /** ISO 3166-1 alpha-3 where the mockup's data references the country. */
  iso?: string
  name: string
  /** Outer rings (a country can be multiple islands/landmasses), [lng, lat]. */
  rings: Array<Array<[number, number]>>
}

export const COUNTRY_SHAPES: CountryShape[] = [
${lines.join('\n')}
]
`)

console.log(`wrote ${OUT}: ${countries.length} countries, ${totalPts} points`)
