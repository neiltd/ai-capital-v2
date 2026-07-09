'use client'

// Map canvas for world-map-v2 — the full-bleed hero of the Map tab.
//
// SVG equirectangular stand-in for the production basemap (self-hosted
// MapLibre dark style; no-external-CSP rule). Round 3: the basemap is now
// REAL country polygons (countries-geo.ts, generated from the repo's
// production countries-110m.json) — every country has a visible border, is
// hover-namable and click-selectable, and country-level shading (heatmap
// indicators, water/food layers, ally-rival relationship tints) fills the
// country's actual shape instead of a soft circle near it.
//
// Same mark grammar per layer as production: polygons for zones, polylines
// for routes/cables/lanes, classed circles for facilities, diamonds for
// chokepoints/signals, sized bubbles for MCI, and the event grammar on top
// (size = severity, hollow = country-centroid, thin ring = escalation ≥ 0.7).
// Facility layers respect the round-3 density control: tier-2 marks are
// hidden in "Key", and render small at world view in "All" until zoom ≥ 2.
//
// Interaction: every mark is clickable → selection-synced inspector rail
// (no floating cards over the map). Wheel-free zoom via +/- controls and
// drag-to-pan, so the page scroll is never hijacked.

import { useMemo, useRef, useState } from 'react'
import type { Density, Selection } from './map-view'
import {
  LAYERS, classColor, seqColor, EVENT_COLOR,
  SAMPLE_CONFLICTS, SAMPLE_CONFLICT_ZONES, SAMPLE_TRADE_ROUTES, SAMPLE_CHOKEPOINTS,
  SAMPLE_PORTFOLIO_LANES, SAMPLE_AIRPORTS, SAMPLE_SEAPORTS, SAMPLE_DATACENTERS,
  SAMPLE_CABLES, SAMPLE_RAIL_HUBS, SAMPLE_HOSPITALS, SAMPLE_POWER, SAMPLE_REFINERIES,
  SAMPLE_MINES, SAMPLE_WATER_INFRA, SAMPLE_MCI, SAMPLE_ENERGY_MIX, SAMPLE_HEATMAP,
  SAMPLE_WATER_STRESS, SAMPLE_FOOD_SECURITY, SAMPLE_INVESTMENT_SIGNALS, SAMPLE_EVENTS,
  COUNTRY_INDEX, COUNTRY_RELATIONS, INDICATOR_LABELS, INVERTED_INDICATORS, SEQ_RAMP, MAP_LABELS,
  type IndicatorKey, type Pt, type Line, type Zone,
} from './data'
import { COUNTRY_SHAPES } from './countries-geo'

const W = 960
const H = 480
const px = (lng: number) => ((lng + 180) / 360) * W
const py = (lat: number) => ((90 - lat) / 180) * H

/**
 * Split a lng/lat path at the antimeridian (±180°). A segment whose |Δlng|
 * exceeds 180° is actually the short way across the Pacific, not the long way
 * around — drawn naively it becomes a backwards slash across the whole map
 * (the zigzag bug). We interpolate the latitude where the segment crosses
 * ±180° and break the path there, so Pacific-crossing routes render as two
 * clean segments hugging the left/right map edges.
 */
function splitAtAntimeridian(path: Array<[number, number]>): Array<Array<[number, number]>> {
  const segs: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const [lng0, lat0] = path[i - 1]
    const [lng1, lat1] = path[i]
    const d = lng1 - lng0
    if (Math.abs(d) > 180) {
      // d < 0 → travelling eastward across +180; d > 0 → westward across −180.
      const exitEdge = d < 0 ? 180 : -180
      const unwrapped = d < 0 ? lng1 + 360 : lng1 - 360
      const f = (exitEdge - lng0) / (unwrapped - lng0)
      const latX = lat0 + f * (lat1 - lat0)
      if (lng0 !== exitEdge) cur.push([exitEdge, latX])
      segs.push(cur)
      cur = [[-exitEdge, latX], [lng1, lat1]]
    } else {
      cur.push([lng1, lat1])
    }
  }
  segs.push(cur)
  return segs.filter((s) => s.length > 1)
}

/* ------------------------------- mark helpers ------------------------------ */

function Dots({ layerId, pts, r = 3.5, zoom = 1, onPick }: {
  layerId: string; pts: Pt[]; r?: number; zoom?: number; onPick: (p: Pt) => void
}) {
  return (
    <g>
      {pts.map((p) => {
        // Tier-2 (extended registry) marks declutter at world view: small and
        // quiet until you zoom into a region (zoom ≥ 2 → full size).
        const quiet = (p.tier ?? 1) === 2 && zoom < 2
        return (
          <circle
            key={p.name} cx={px(p.lng)} cy={py(p.lat)} r={quiet ? r * 0.6 : r}
            fill={classColor(layerId, p.k)} fillOpacity={quiet ? 0.55 : 0.9}
            stroke="var(--page)" strokeWidth={quiet ? 0.4 : 0.75}
            className="cursor-pointer transition-[r] hover:opacity-100"
            onClick={() => onPick(p)}
          >
            <title>{p.name}</title>
          </circle>
        )
      })}
    </g>
  )
}

function Diamonds({ layerId, pts, s = 4.5, onPick }: {
  layerId: string; pts: Pt[]; s?: number; onPick: (p: Pt) => void
}) {
  return (
    <g>
      {pts.map((p) => {
        const cx = px(p.lng); const cy = py(p.lat)
        return (
          <rect
            key={p.name} x={cx - s} y={cy - s} width={s * 2} height={s * 2}
            transform={`rotate(45 ${cx} ${cy})`}
            fill={classColor(layerId, p.k)} fillOpacity={0.9}
            stroke="var(--page)" strokeWidth={0.75}
            className="cursor-pointer" onClick={() => onPick(p)}
          >
            <title>{p.name}</title>
          </rect>
        )
      })}
    </g>
  )
}

function Lines({ layerId, lines, width = 1.5, dash }: {
  layerId: string; lines: Line[]; width?: number; dash?: string
}) {
  return (
    <g>
      {lines.map((l) => (
        <g key={l.name}>
          {splitAtAntimeridian(l.path).map((seg, si) => (
            <path
              key={si}
              d={seg.map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${px(lng).toFixed(1)},${py(lat).toFixed(1)}`).join(' ')}
              fill="none" stroke={classColor(layerId, l.k)} strokeWidth={width}
              strokeOpacity={0.7} strokeDasharray={dash} strokeLinecap="round"
            >
              <title>{l.name}</title>
            </path>
          ))}
        </g>
      ))}
    </g>
  )
}

function Zones({ layerId, zones }: { layerId: string; zones: Zone[] }) {
  return (
    <g>
      {zones.map((z) => (
        <path
          key={z.name}
          d={z.ring.map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${px(lng).toFixed(1)},${py(lat).toFixed(1)}`).join(' ') + ' Z'}
          fill={classColor(layerId, z.k)} fillOpacity={0.16}
          stroke={classColor(layerId, z.k)} strokeWidth={1} strokeOpacity={0.5}
        >
          <title>{z.name}</title>
        </path>
      ))}
    </g>
  )
}

/* ------------------------------ country fills ------------------------------ */
// Round 3: country-level shading fills the country's REAL polygon (was: a
// soft circle near the centroid, which made it ambiguous which country was
// meant). Build one fill per ISO3, choropleth-style.

interface CountryFill { color: string; opacity: number; label: string }

// Dark-basemap luminance rule: the design-system ramp runs light→dark for
// low→high on light surfaces, but on the graphite map that makes LOW values
// glow brightest (light blue on dark = maximum salience — live testing showed
// Sudan 1/10 outshining USA 9/10). On the dark canvas brightness tracks the
// RAW value ("big number glows"): 9/10 attractiveness glows, and so does 4.8
// extreme water stress — the "(high = worse)" label carries interpretation.
// Legend gradients render dark→bright for low→high to match.
function choroplethFills(pts: Pt[], max: number, into: Map<string, CountryFill>) {
  for (const p of pts) {
    if (!p.iso || into.has(p.iso)) continue // first writer wins (heat > env layers)
    const t = (p.v ?? 0) / max
    into.set(p.iso, { color: seqColor(1 - t), opacity: 0.55, label: p.name })
  }
}

const ringPath = (ring: Array<[number, number]>) =>
  ring.map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${px(lng).toFixed(1)},${py(lat).toFixed(1)}`).join(' ') + ' Z'

/* --------------------------------- canvas ---------------------------------- */

export function MapCanvas({
  vis, heat, density, sel, onSelect,
}: {
  vis: Record<string, boolean>
  heat: IndicatorKey
  density: Density
  sel: Selection | null
  onSelect: (s: Selection) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const dragEnded = useRef(false)

  const vw = W / zoom
  const vh = H / zoom
  const vx = Math.max(0, Math.min(W - vw, (W - vw) / 2 + panX))
  const vy = Math.max(0, Math.min(H - vh, (H - vh) / 2 + panY))

  const pickFacility = (layerId: string) => (p: Pt) => onSelect({ kind: 'facility', layerId, name: p.name, k: p.k })
  const selCountry = sel?.kind === 'country' ? COUNTRY_INDEX.find((c) => c.id === sel.id) : null
  const selIso = sel?.kind === 'country' ? sel.id : null
  const relations = selIso ? COUNTRY_RELATIONS[selIso] : undefined

  // Facility density: 'key' hides tier-2 (extended registry) marks entirely.
  const fac = (pts: Pt[]) => (density === 'key' ? pts.filter((p) => (p.tier ?? 1) === 1) : pts)

  // Heatmap sample set: reuse the composite sample for geopolitical keys, the
  // dedicated environment samples for water/food keys (matches production
  // source routing in lib/geo/indicators.ts).
  const heatPts =
    heat === 'waterStressScore' ? SAMPLE_WATER_STRESS
    : heat === 'foodSecurityScore' ? SAMPLE_FOOD_SECURITY
    : SAMPLE_HEATMAP
  const heatMax = heat === 'waterStressScore' ? 5 : heat === 'foodSecurityScore' ? 50 : 10

  // One fill per country. Priority: relationship tints (an explicit selection
  // act) > heatmap indicator > environment layers. Fills paint the country's
  // real polygon from countries-geo.ts.
  const countryFills = useMemo(() => {
    const fills = new Map<string, CountryFill>()
    if (relations && selIso) {
      fills.set(selIso, { color: 'var(--accent)', opacity: 0.4, label: 'Selected' })
      for (const a of relations.allies) fills.set(a, { color: 'var(--gain)', opacity: 0.24, label: 'Ally' })
      for (const r of relations.rivals) fills.set(r, { color: 'var(--loss)', opacity: 0.24, label: 'Rival' })
    }
    if (heat !== 'none') choroplethFills(heatPts, heatMax, fills)
    if (vis['water-stress'] && heat !== 'waterStressScore') choroplethFills(SAMPLE_WATER_STRESS, 5, fills)
    if (vis['food-security'] && heat !== 'foodSecurityScore') choroplethFills(SAMPLE_FOOD_SECURITY, 50, fills)
    return fills
  }, [relations, selIso, heat, heatPts, heatMax, vis])

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-page">
      <svg
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        role="img"
        aria-label="World intelligence map"
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, px: panX, py: panY, moved: false }
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          if (Math.abs(e.clientX - drag.current.x) + Math.abs(e.clientY - drag.current.y) > 3) drag.current.moved = true
          const scale = vw / (e.currentTarget.clientWidth || W)
          setPanX(drag.current.px - (e.clientX - drag.current.x) * scale)
          setPanY(drag.current.py - (e.clientY - drag.current.y) * scale)
        }}
        onPointerUp={(e) => {
          // Keep the moved flag through the click event so a drag-release over
          // a country doesn't count as a country click; clear on next tick.
          const d = drag.current
          drag.current = null
          if (d?.moved) {
            dragEnded.current = true
            setTimeout(() => { dragEnded.current = false }, 0)
          }
          void e
        }}
      >
        {/* graticule */}
        {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lng) => (
          <line key={`g${lng}`} x1={px(lng)} x2={px(lng)} y1={0} y2={H} stroke="var(--grid)" strokeWidth={0.5} opacity={0.5} />
        ))}
        {[-60, -30, 0, 30, 60].map((lat) => (
          <line key={`l${lat}`} x1={0} x2={W} y1={py(lat)} y2={py(lat)} stroke="var(--grid)" strokeWidth={lat === 0 ? 0.8 : 0.5} opacity={0.5} />
        ))}

        {/* ── countries: real simplified polygons (countries-geo.ts, from the
            production countries-110m.json). Visible border strokes on every
            country; hover shows the name; click selects → country panel.
            Country-level shading (heatmap / env / ally-rival) fills the
            actual shape via countryFills. ── */}
        {COUNTRY_SHAPES.map((c) => {
          const f = c.iso ? countryFills.get(c.iso) : undefined
          return (
            <g
              key={c.name}
              className="cursor-pointer"
              onClick={() => { if (!dragEnded.current) onSelect({ kind: 'country', id: c.iso ?? c.name }) }}
            >
              {c.rings.map((ring, i) => (
                <path
                  key={i}
                  d={ringPath(ring)}
                  fill="var(--surface-2)"
                  stroke="var(--grid)"
                  strokeWidth={0.5}
                  strokeLinejoin="round"
                />
              ))}
              {f && c.rings.map((ring, i) => (
                <path
                  key={`f${i}`}
                  d={ringPath(ring)}
                  fill={f.color}
                  fillOpacity={f.opacity}
                  stroke="none"
                  style={{ pointerEvents: 'none' }}
                />
              ))}
              <title>{f ? `${c.name} — ${f.label}` : c.name}</title>
            </g>
          )
        })}

        {/* place-name labels — muted, non-interactive, below every mark layer
            (production: the basemap's own label layer) */}
        {MAP_LABELS.map((m) => (
          <text
            key={m.text}
            x={px(m.lng)} y={py(m.lat)}
            textAnchor={m.anchor ?? 'middle'}
            fill="var(--ink-3)"
            fontSize={m.size}
            fontStyle={m.kind === 'water' ? 'italic' : undefined}
            letterSpacing={m.kind === 'water' ? m.size * 0.18 : m.size * 0.08}
            opacity={m.kind === 'water' ? 0.65 : 0.8}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {m.text}
          </text>
        ))}

        {/* country shading (heatmap indicator, environment layers, ally-rival
            tints) is painted INTO the country polygons above via countryFills */}
        {vis['conflict-zones'] && <Zones layerId="conflict-zones" zones={SAMPLE_CONFLICT_ZONES} />}

        {/* ── lines ── */}
        {vis['trade-routes'] && <Lines layerId="trade-routes" lines={SAMPLE_TRADE_ROUTES} />}
        {vis['submarine-cables'] && <Lines layerId="submarine-cables" lines={SAMPLE_CABLES} dash="4 3" width={1.25} />}
        {vis['portfolio-trade'] && <Lines layerId="portfolio-trade" lines={SAMPLE_PORTFOLIO_LANES} width={2} />}

        {/* ── facility points ── */}
        {vis['mci'] && (
          <g>
            {SAMPLE_MCI.map((p) => (
              <circle
                key={p.name} cx={px(p.lng)} cy={py(p.lat)} r={2 + (p.v ?? 0) / 12}
                fill={classColor('mci', p.k)} fillOpacity={0.4}
                stroke={classColor('mci', p.k)} strokeWidth={1}
                className="cursor-pointer" onClick={() => pickFacility('mci')(p)}
              >
                <title>{`MCI ${p.name}`}</title>
              </circle>
            ))}
          </g>
        )}
        {vis['energy-mix'] && <Dots layerId="energy-mix" pts={SAMPLE_ENERGY_MIX} r={5} onPick={pickFacility('energy-mix')} />}
        {vis['airports'] && <Dots layerId="airports" pts={fac(SAMPLE_AIRPORTS)} zoom={zoom} onPick={pickFacility('airports')} />}
        {vis['seaports'] && <Dots layerId="seaports" pts={fac(SAMPLE_SEAPORTS)} zoom={zoom} onPick={pickFacility('seaports')} />}
        {vis['datacenters'] && <Dots layerId="datacenters" pts={fac(SAMPLE_DATACENTERS)} zoom={zoom} onPick={pickFacility('datacenters')} />}
        {vis['rail-hubs'] && <Dots layerId="rail-hubs" pts={fac(SAMPLE_RAIL_HUBS)} zoom={zoom} onPick={pickFacility('rail-hubs')} />}
        {vis['hospitals'] && <Dots layerId="hospitals" pts={fac(SAMPLE_HOSPITALS)} zoom={zoom} onPick={pickFacility('hospitals')} />}
        {vis['power-plants'] && <Dots layerId="power-plants" pts={fac(SAMPLE_POWER)} zoom={zoom} onPick={pickFacility('power-plants')} />}
        {vis['refineries'] && <Dots layerId="refineries" pts={fac(SAMPLE_REFINERIES)} zoom={zoom} onPick={pickFacility('refineries')} />}
        {vis['critical-minerals'] && <Dots layerId="critical-minerals" pts={fac(SAMPLE_MINES)} zoom={zoom} onPick={pickFacility('critical-minerals')} />}
        {vis['water-infra'] && <Dots layerId="water-infra" pts={fac(SAMPLE_WATER_INFRA)} zoom={zoom} onPick={pickFacility('water-infra')} />}

        {/* ── conflicts (clickable → conflict detail) ── */}
        {vis['conflicts'] && (
          <g>
            {SAMPLE_CONFLICTS.map((p) => {
              const selHere = sel?.kind === 'conflict' && sel.id === p.name
              return (
                <circle
                  key={p.name} cx={px(p.lng)} cy={py(p.lat)} r={selHere ? 6 : 4.5}
                  fill={classColor('conflicts', p.k)} fillOpacity={0.95}
                  stroke={selHere ? 'var(--ink)' : 'var(--page)'} strokeWidth={selHere ? 1.5 : 0.75}
                  className="cursor-pointer" onClick={() => onSelect({ kind: 'conflict', id: p.name })}
                >
                  <title>{p.name}</title>
                </circle>
              )
            })}
          </g>
        )}

        {/* ── diamonds ── */}
        {vis['chokepoints'] && (
          <Diamonds layerId="chokepoints" pts={SAMPLE_CHOKEPOINTS} onPick={(p) => onSelect({ kind: 'chokepoint', id: p.name })} />
        )}
        {vis['portfolio-trade'] && !vis['chokepoints'] && (
          <Diamonds
            layerId="chokepoints"
            pts={SAMPLE_CHOKEPOINTS.filter((c) => ['Strait of Hormuz', 'Bab el-Mandeb', 'Suez Canal', 'Taiwan Strait', 'Strait of Malacca'].includes(c.name))}
            onPick={(p) => onSelect({ kind: 'chokepoint', id: p.name })}
          />
        )}
        {vis['investment-signals'] && (
          <Diamonds layerId="investment-signals" pts={SAMPLE_INVESTMENT_SIGNALS} onPick={pickFacility('investment-signals')} />
        )}

        {/* ── intelligence events (top) ── */}
        {vis['intelligence-events'] && (
          <g>
            {SAMPLE_EVENTS.map((e) => {
              const cx = px(e.lng); const cy = py(e.lat)
              const r = 3 + e.severity * 1.5
              const centroid = e.coordinateQuality === 'country_centroid'
              const selHere = sel?.kind === 'event' && sel.id === e.eventId
              return (
                <g key={e.eventId} className="cursor-pointer" onClick={() => onSelect({ kind: 'event', id: e.eventId })}>
                  {e.escalationPotential >= 0.7 && (
                    <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={EVENT_COLOR(e.severity)} strokeWidth={1} opacity={0.5} />
                  )}
                  <circle
                    cx={cx} cy={cy} r={r}
                    fill={centroid ? 'transparent' : EVENT_COLOR(e.severity)}
                    stroke={selHere ? 'var(--ink)' : EVENT_COLOR(e.severity)}
                    strokeWidth={centroid || selHere ? 2 : 1}
                  >
                    <title>{`[sev ${e.severity}] ${e.title}${centroid ? ' (country centroid — approximate)' : ''}`}</title>
                  </circle>
                </g>
              )
            })}
          </g>
        )}

        {/* ── selected country: accent border on its real shape, drawn above
            all neighbors so the outline never gets overpainted. Pin fallback
            for countries with no 110m polygon (e.g. Singapore). ── */}
        {selIso && (() => {
          const shape = COUNTRY_SHAPES.find((c) => c.iso === selIso)
          if (shape) {
            return (
              <g style={{ pointerEvents: 'none' }}>
                {shape.rings.map((ring, i) => (
                  <path key={i} d={ringPath(ring)} fill="none" stroke="var(--accent)" strokeWidth={1.25} strokeLinejoin="round" />
                ))}
              </g>
            )
          }
          if (!selCountry) return null
          return (
            <g>
              <circle cx={px(selCountry.lng)} cy={py(selCountry.lat)} r={10} fill="var(--accent)" fillOpacity={0.15} />
              <circle cx={px(selCountry.lng)} cy={py(selCountry.lat)} r={4} fill="var(--accent)" stroke="var(--ink)" strokeWidth={1.25} />
            </g>
          )
        })()}
      </svg>

      {/* ── zoom controls ── */}
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-chip border border-hairline bg-surface shadow-card">
        {(['+', '−'] as const).map((g) => (
          <button
            key={g}
            onClick={() => setZoom((z) => (g === '+' ? Math.min(4, z * 1.5) : Math.max(1, z / 1.5)))}
            className="h-7 w-7 text-[14px] leading-none text-ink-2 transition-colors first:border-b first:border-hairline hover:bg-surface-2 hover:text-ink"
            aria-label={g === '+' ? 'Zoom in' : 'Zoom out'}
          >
            {g}
          </button>
        ))}
      </div>

      {/* ── relationship legend chip (top-left) — explains the ally/rival
          country tints while a country with relationship data is selected ── */}
      {relations && (
        <div className="absolute left-3 top-3 flex items-center gap-2.5 rounded-chip border border-hairline bg-surface px-2.5 py-1.5 shadow-card">
          <span className="text-[11px] font-medium text-ink-2">
            Relations · {COUNTRY_INDEX.find((c) => c.id === selIso)?.name ?? COUNTRY_SHAPES.find((c) => c.iso === selIso)?.name ?? selIso}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-3">
            <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: 'var(--gain)', opacity: 0.7 }} /> ally
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-3">
            <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: 'var(--loss)', opacity: 0.7 }} /> rival
          </span>
          <span className="text-[10px] text-ink-3">unshaded = neutral</span>
        </div>
      )}

      {/* ── active heatmap chip (top-right of canvas) ── */}
      {heat !== 'none' && (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded-chip border border-hairline bg-surface px-2.5 py-1.5 shadow-card">
          <span className="text-[11px] font-medium text-ink-2">{INDICATOR_LABELS[heat]}</span>
          {/* gradient matches the dark-basemap fills: low = dark, high = bright */}
          <span
            className="inline-block h-1.5 w-12 rounded-full"
            style={{ background: `linear-gradient(to right, ${SEQ_RAMP[SEQ_RAMP.length - 1]}, ${SEQ_RAMP[0]})` }}
          />
          <span className="text-[10px] text-ink-3">{INVERTED_INDICATORS.has(heat) ? 'high = worse' : 'low → high'}</span>
        </div>
      )}

      {/* ── legend strip (bottom, active layers only) ── */}
      <LegendStrip vis={vis} />
    </div>
  )
}

/* --------------------------------- legend ---------------------------------- */

function LegendStrip({ vis }: { vis: Record<string, boolean> }) {
  const active = LAYERS.filter((l) => l.id !== 'heatmap' && vis[l.id] && l.legend?.length)
  if (active.length === 0) return null
  return (
    <div className="absolute inset-x-0 bottom-0 overflow-x-auto border-t border-hairline bg-surface/90 px-3 py-1.5 backdrop-blur-sm">
      <div className="flex w-max items-center gap-x-5">
        {active.map((l) => (
          <div key={l.id} className="flex items-center gap-x-2">
            <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{l.label}</span>
            {l.legend!.map((e) => (
              <span key={e.label} className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-2">
                {e.shape === 'line' ? (
                  <span className="inline-block h-[2px] w-3.5" style={{ backgroundColor: e.color }} />
                ) : e.shape === 'diamond' ? (
                  <span className="inline-block h-2 w-2 rotate-45" style={{ backgroundColor: e.color }} />
                ) : e.shape === 'square' ? (
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ backgroundColor: e.color }} />
                ) : (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: e.color }} />
                )}
                {e.label}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
