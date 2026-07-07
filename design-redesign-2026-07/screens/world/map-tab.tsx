'use client'

// Map tab for /world — an actual layered map, not just event markers.
//
// All 21 layers from the production registry (see map-layers.ts) are
// individually toggleable, grouped by the registry's 7 categories, with each
// layer's own legend shown while active. Defaults follow the registry's
// defaultEnabled flags (conflicts + conflict-zones + intelligence-events on).
//
// The SVG equirectangular plot stands in for the production basemap (self-
// hosted MapLibre dark style — no-external-CSP rule) with the same mark
// grammar per layer: polygons for zones, polylines for routes/cables/lanes,
// classed circles for facilities, diamonds for chokepoints/signals, sized
// bubbles for MCI, sequential-blue graded marks for score layers (production
// renders those as country fills from countries-110m.json), and the existing
// event grammar on top (size = severity, hollow = country-centroid, thin ring
// = escalation ≥ 0.7). Events stay wired to the shared inspector.
//
// Instrument-panel honesty: every picker row carries a provenance glyph —
// ● green  = live pipeline (hub export / pg API)
// ● gray   = real curated dataset, loaded by the current app
// ◌ amber  = data file exists but nothing reads it today (renderer missing)
// Hover a row for the exact source path. See map-layers.ts header for the
// full verification notes.

import { useMemo, useState } from 'react'
import type { WorldEventVM } from './data'
import { Label } from '../_shared/ui'
import {
  MAP_LAYERS,
  LAYER_GROUPS,
  layersByGroup,
  DEFAULT_VISIBILITY,
  SEQ_RAMP,
  SAMPLE_CONFLICTS,
  SAMPLE_CONFLICT_ZONES,
  SAMPLE_TRADE_ROUTES,
  SAMPLE_CHOKEPOINTS,
  SAMPLE_PORTFOLIO_LANES,
  SAMPLE_AIRPORTS,
  SAMPLE_SEAPORTS,
  SAMPLE_DATACENTERS,
  SAMPLE_CABLES,
  SAMPLE_RAIL_HUBS,
  SAMPLE_HOSPITALS,
  SAMPLE_POWER,
  SAMPLE_REFINERIES,
  SAMPLE_MINES,
  SAMPLE_WATER_INFRA,
  SAMPLE_MCI,
  SAMPLE_ENERGY_MIX,
  SAMPLE_HEATMAP,
  SAMPLE_WATER_STRESS,
  SAMPLE_FOOD_SECURITY,
  SAMPLE_INVESTMENT_SIGNALS,
  type MapLayerMeta,
  type LegendEntry,
  type Pt,
  type Line,
  type Zone,
} from './map-layers'

/* ------------------------------ projection -------------------------------- */

const W = 880
const H = 440
const px = (lng: number) => ((lng + 180) / 360) * W
const py = (lat: number) => ((90 - lat) / 180) * H

/* --------------------------- class → color maps ---------------------------- */
// Colors match each layer's legend in map-layers.ts (data-semantic hues).

const CLASS_COLOR: Record<string, Record<string, string>> = {
  conflicts: { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#84cc16' },
  'conflict-zones': { critical: '#ef4444', high: '#f97316' },
  'trade-routes': { critical: '#06b6d4', high: '#3b82f6', medium: '#6366f1', low: '#8b5cf6' },
  chokepoints: { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' },
  'portfolio-trade': { semis: '#06b6d4', energy: '#ef4444', pharma: '#a855f7', industrial_metals: '#94a3b8' },
  airports: { critical: '#f97316', high: '#3b82f6', medium: '#64748b' },
  seaports: { container: '#06b6d4', oil: '#f59e0b', bulk: '#8b5cf6', naval: '#ef4444', mixed: '#22c55e' },
  datacenters: { hyperscale: '#a78bfa', colocation: '#22d3ee', government: '#ef4444', enterprise: '#64748b' },
  'submarine-cables': { active: '#06b6d4', construction: '#f59e0b', damaged: '#ef4444' },
  'rail-hubs': { freight: '#f59e0b', passenger: '#60a5fa', border_crossing: '#f97316', port_interface: '#34d399', high_speed: '#22d3ee' },
  hospitals: { public: '#3b82f6', private_nonprofit: '#22d3ee', private_forprofit: '#a78bfa' },
  'power-plants': { nuclear: '#a78bfa', coal: '#78716c', gas: '#f59e0b', hydro: '#0ea5e9', solar: '#fbbf24', wind: '#34d399' },
  refineries: { crude_refinery: '#fb923c', condensate: '#facc15', petrochemical: '#a855f7', lng_export: '#22d3ee', lng_import: '#3b82f6' },
  'critical-minerals': { copper: '#f97316', lithium: '#22d3ee', cobalt: '#3b82f6', rare_earths: '#a855f7', uranium: '#10b981', nickel: '#94a3b8' },
  'water-infra': { desalination: '#06b6d4', hydropower_dam: '#3b82f6', supply_dam: '#22c55e', combined: '#a855f7' },
  mci: { leader: '#22d3ee', advanced: '#3b82f6', transitioner: '#a855f7', discoverer: '#f59e0b' },
  'energy-mix': { renewable: '#34d399', nuclear: '#a78bfa', fossil: '#78716c' },
  'investment-signals': { bullish: '#0ca30c', neutral: '#898781', bearish: '#d03b3b' },
}

const color = (layerId: string, k: string) => CLASS_COLOR[layerId]?.[k] ?? '#898781'

/** Sequential single-hue ramp for score-graded layers (t 0..1). */
function seqColor(t: number): string {
  const idx = Math.min(SEQ_RAMP.length - 1, Math.max(0, Math.round(t * (SEQ_RAMP.length - 1))))
  return SEQ_RAMP[idx]
}

const EVENT_COLOR = (s: number) => (s >= 5 ? '#d03b3b' : s >= 4 ? '#ec835a' : s >= 3 ? '#fab219' : '#898781')

/* ------------------------------ mark helpers ------------------------------- */

function Dots({ layerId, pts, r = 3.5 }: { layerId: string; pts: Pt[]; r?: number }) {
  return (
    <g>
      {pts.map((p) => (
        <circle key={p.name} cx={px(p.lng)} cy={py(p.lat)} r={r} fill={color(layerId, p.k)} fillOpacity={0.9}>
          <title>{p.name}</title>
        </circle>
      ))}
    </g>
  )
}

function Diamonds({ layerId, pts, s = 4.5 }: { layerId: string; pts: Pt[]; s?: number }) {
  return (
    <g>
      {pts.map((p) => {
        const cx = px(p.lng)
        const cy = py(p.lat)
        return (
          <rect
            key={p.name}
            x={cx - s}
            y={cy - s}
            width={s * 2}
            height={s * 2}
            transform={`rotate(45 ${cx} ${cy})`}
            fill={color(layerId, p.k)}
            fillOpacity={0.9}
          >
            <title>{p.name}</title>
          </rect>
        )
      })}
    </g>
  )
}

function Lines({ layerId, lines, width = 1.5, dash }: { layerId: string; lines: Line[]; width?: number; dash?: string }) {
  return (
    <g>
      {lines.map((l) => (
        <path
          key={l.name}
          d={l.path.map(([lng, lat], i) => `${i === 0 ? 'M' : 'L'}${px(lng).toFixed(1)},${py(lat).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={color(layerId, l.k)}
          strokeWidth={width}
          strokeOpacity={0.75}
          strokeDasharray={dash}
          strokeLinecap="round"
        >
          <title>{l.name}</title>
        </path>
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
          fill={color(layerId, z.k)}
          fillOpacity={0.14}
          stroke={color(layerId, z.k)}
          strokeWidth={1}
          strokeOpacity={0.55}
        >
          <title>{z.name}</title>
        </path>
      ))}
    </g>
  )
}

/** Score-graded marks — SVG stand-in for the production country-fill choropleth. */
function GradedMarks({ pts, max, r = 8 }: { pts: Pt[]; max: number; r?: number }) {
  return (
    <g>
      {pts.map((p) => (
        <circle
          key={p.name}
          cx={px(p.lng)}
          cy={py(p.lat)}
          r={r}
          fill={seqColor((p.v ?? 0) / max)}
          fillOpacity={0.8}
          stroke="var(--hairline)"
          strokeWidth={1}
        >
          <title>{p.name} (production: country fill)</title>
        </circle>
      ))}
    </g>
  )
}

/* ------------------------------- layer rail -------------------------------- */

const PROVENANCE_GLYPH: Record<string, { color: string; hollow: boolean; label: string }> = {
  pipeline: { color: '#0ca30c', hollow: false, label: 'live pipeline' },
  static: { color: '#898781', hollow: false, label: 'curated dataset, loaded by the app' },
  unwired: { color: '#fab219', hollow: true, label: 'data file exists — no renderer in current app yet' },
}

function ProvenanceDot({ layer }: { layer: MapLayerMeta }) {
  const g = PROVENANCE_GLYPH[layer.provenance.kind]
  return (
    <span
      className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
      style={g.hollow ? { border: `1px solid ${g.color}` } : { backgroundColor: g.color }}
      title={`${g.label}\n${layer.provenance.source}\n${layer.provenance.note}`}
    />
  )
}

function LayerRow({ layer, on, onToggle }: { layer: MapLayerMeta; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      title={`${layer.description}\n\n[${PROVENANCE_GLYPH[layer.provenance.kind].label}] ${layer.provenance.source}`}
      className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-surface-2"
    >
      <span
        className={`mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none ${
          on ? 'border-accent bg-accent text-white' : 'border-hairline text-transparent'
        }`}
        aria-hidden
      >
        ✓
      </span>
      <span className={`flex-1 text-[12px] leading-[18px] ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>
        {layer.label}
      </span>
      <ProvenanceDot layer={layer} />
    </button>
  )
}

function LayerRail({
  vis,
  onToggle,
  onReset,
}: {
  vis: Record<string, boolean>
  onToggle: (id: string) => void
  onReset: () => void
}) {
  const activeCount = MAP_LAYERS.filter((l) => vis[l.id]).length
  return (
    <div className="w-full shrink-0 border-b border-hairline lg:max-h-[520px] lg:w-[218px] lg:overflow-y-auto lg:border-b-0 lg:border-r">
      <div className="flex items-baseline justify-between px-3 pb-1 pt-3">
        <Label>Layers</Label>
        <span className="tnum text-[11px] text-ink-3">
          {activeCount}/{MAP_LAYERS.length}
          {activeCount !== MAP_LAYERS.filter((l) => l.defaultEnabled).length && (
            <button onClick={onReset} className="ml-2 text-accent hover:underline">
              reset
            </button>
          )}
        </span>
      </div>
      {LAYER_GROUPS.map((g) => (
        <div key={g.id} className="px-1 pb-1.5">
          <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
            {g.label}
          </div>
          {layersByGroup(g.id).map((l) => (
            <LayerRow key={l.id} layer={l} on={!!vis[l.id]} onToggle={() => onToggle(l.id)} />
          ))}
        </div>
      ))}
      <p className="border-t border-hairline px-3 py-2 text-[10px] leading-[14px] text-ink-3">
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-status-good align-middle" /> live pipeline ·{' '}
        <span className="mx-1 inline-block h-1.5 w-1.5 rounded-full bg-ink-3 align-middle" /> curated file ·{' '}
        <span className="mx-1 inline-block h-1.5 w-1.5 rounded-full border border-status-warning align-middle" /> data
        exists, renderer missing (hover rows for source paths)
      </p>
    </div>
  )
}

/* --------------------------------- legends --------------------------------- */

function LegendMark({ e }: { e: LegendEntry }) {
  if (e.shape === 'ramp')
    return (
      <span
        className="inline-block h-2 w-14 rounded-sm align-middle"
        style={{ background: `linear-gradient(to right, ${SEQ_RAMP[0]}, ${SEQ_RAMP[SEQ_RAMP.length - 1]})` }}
      />
    )
  if (e.shape === 'line')
    return <span className="inline-block h-[2px] w-3.5 align-middle" style={{ backgroundColor: e.color }} />
  if (e.shape === 'diamond')
    return <span className="inline-block h-2 w-2 rotate-45 align-middle" style={{ backgroundColor: e.color }} />
  if (e.shape === 'square')
    return <span className="inline-block h-2 w-2 rounded-[2px] align-middle" style={{ backgroundColor: e.color }} />
  return <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: e.color }} />
}

function ActiveLegends({ vis }: { vis: Record<string, boolean> }) {
  const active = MAP_LAYERS.filter((l) => vis[l.id] && l.legend?.length)
  if (active.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-hairline px-3 py-2">
      {active.map((l) => (
        <div key={l.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{l.label}</span>
          {l.legend!.map((e) => (
            <span key={e.label} className="inline-flex items-center gap-1 text-[11px] text-ink-2">
              <LegendMark e={e} /> {e.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/* -------------------------------- map canvas ------------------------------- */

function EventMarks({
  events,
  selectedId,
  onSelect,
}: {
  events: WorldEventVM[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const plotted = events.filter((e) => e.lat !== null && e.lng !== null)
  return (
    <g>
      {plotted.map((e) => {
        const cx = px(e.lng!)
        const cy = py(e.lat!)
        const r = 4 + e.severity * 2
        const centroid = e.coordinateQuality === 'country_centroid'
        const sel = e.eventId === selectedId
        return (
          <g key={e.eventId} onClick={() => onSelect(e.eventId)} className="cursor-pointer">
            {e.escalationPotential >= 0.7 && (
              <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke={EVENT_COLOR(e.severity)} strokeWidth={1} opacity={0.5} />
            )}
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={centroid ? 'transparent' : EVENT_COLOR(e.severity)}
              stroke={sel ? 'var(--ink)' : EVENT_COLOR(e.severity)}
              strokeWidth={centroid ? 2 : sel ? 2 : 0}
            >
              <title>{`[sev ${e.severity}] ${e.title}${centroid ? ' (country centroid — approximate)' : ''}`}</title>
            </circle>
            <text x={cx + r + 4} y={cy + 3.5} fontSize={10} fill={sel ? 'var(--ink)' : 'var(--ink-3)'}>
              {e.countries[0]}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* --------------------------------- map tab --------------------------------- */

export function MapTab({
  events,
  selectedId,
  onSelect,
}: {
  events: WorldEventVM[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [vis, setVis] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_VISIBILITY }))
  const toggle = (id: string) => setVis((v) => ({ ...v, [id]: !v[id] }))
  const reset = () => setVis({ ...DEFAULT_VISIBILITY })

  const unwiredActive = useMemo(
    () => MAP_LAYERS.filter((l) => vis[l.id] && l.provenance.kind === 'unwired').map((l) => l.label),
    [vis],
  )

  return (
    <div className="rounded-card border border-hairline bg-surface">
      <div className="flex flex-col lg:flex-row">
        <LayerRail vis={vis} onToggle={toggle} onReset={reset} />

        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto p-2">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="World intelligence map with toggleable layers" className="min-w-[640px] max-w-full">
              {/* graticule */}
              {[-120, -60, 0, 60, 120].map((lng) => (
                <line key={lng} x1={px(lng)} x2={px(lng)} y1={0} y2={H} stroke="var(--grid)" strokeWidth={1} />
              ))}
              {[-60, -30, 0, 30, 60].map((lat) => (
                <line key={lat} x1={0} x2={W} y1={py(lat)} y2={py(lat)} stroke="var(--grid)" strokeWidth={lat === 0 ? 1.5 : 1} />
              ))}

              {/* ── area / graded layers (bottom) ─────────────────────────── */}
              {vis['heatmap'] && <GradedMarks pts={SAMPLE_HEATMAP} max={10} />}
              {vis['water-stress'] && <GradedMarks pts={SAMPLE_WATER_STRESS} max={5} r={7} />}
              {vis['food-security'] && <GradedMarks pts={SAMPLE_FOOD_SECURITY} max={50} r={7} />}
              {vis['conflict-zones'] && <Zones layerId="conflict-zones" zones={SAMPLE_CONFLICT_ZONES} />}

              {/* ── line layers ───────────────────────────────────────────── */}
              {vis['trade-routes'] && <Lines layerId="trade-routes" lines={SAMPLE_TRADE_ROUTES} />}
              {vis['submarine-cables'] && <Lines layerId="submarine-cables" lines={SAMPLE_CABLES} dash="4 3" width={1.25} />}
              {vis['portfolio-trade'] && <Lines layerId="portfolio-trade" lines={SAMPLE_PORTFOLIO_LANES} width={2} />}

              {/* ── point layers ──────────────────────────────────────────── */}
              {vis['mci'] && (
                <g>
                  {SAMPLE_MCI.map((p) => (
                    <circle
                      key={p.name}
                      cx={px(p.lng)}
                      cy={py(p.lat)}
                      r={2 + (p.v ?? 0) / 12}
                      fill={color('mci', p.k)}
                      fillOpacity={0.55}
                      stroke={color('mci', p.k)}
                      strokeWidth={1}
                    >
                      <title>{`MCI ${p.name}`}</title>
                    </circle>
                  ))}
                </g>
              )}
              {vis['energy-mix'] && <Dots layerId="energy-mix" pts={SAMPLE_ENERGY_MIX} r={5} />}
              {vis['airports'] && <Dots layerId="airports" pts={SAMPLE_AIRPORTS} />}
              {vis['seaports'] && <Dots layerId="seaports" pts={SAMPLE_SEAPORTS} />}
              {vis['datacenters'] && <Dots layerId="datacenters" pts={SAMPLE_DATACENTERS} />}
              {vis['rail-hubs'] && <Dots layerId="rail-hubs" pts={SAMPLE_RAIL_HUBS} />}
              {vis['hospitals'] && <Dots layerId="hospitals" pts={SAMPLE_HOSPITALS} />}
              {vis['power-plants'] && <Dots layerId="power-plants" pts={SAMPLE_POWER} />}
              {vis['refineries'] && <Dots layerId="refineries" pts={SAMPLE_REFINERIES} />}
              {vis['critical-minerals'] && <Dots layerId="critical-minerals" pts={SAMPLE_MINES} />}
              {vis['water-infra'] && <Dots layerId="water-infra" pts={SAMPLE_WATER_INFRA} />}
              {vis['conflicts'] && <Dots layerId="conflicts" pts={SAMPLE_CONFLICTS} r={4.5} />}

              {/* ── diamond layers ────────────────────────────────────────── */}
              {vis['chokepoints'] && <Diamonds layerId="chokepoints" pts={SAMPLE_CHOKEPOINTS} />}
              {vis['portfolio-trade'] && (
                <g>
                  {SAMPLE_CHOKEPOINTS.filter((c) => ['Strait of Hormuz', 'Bab el-Mandeb', 'Suez Canal', 'Taiwan Strait', 'Strait of Malacca'].includes(c.name)).map((c) => {
                    const cx = px(c.lng)
                    const cy = py(c.lat)
                    return (
                      <rect
                        key={c.name}
                        x={cx - 4}
                        y={cy - 4}
                        width={8}
                        height={8}
                        transform={`rotate(45 ${cx} ${cy})`}
                        fill="#fbbf24"
                        fillOpacity={0.9}
                      >
                        <title>{`${c.name} — click filters lanes + exposed tickers (production)`}</title>
                      </rect>
                    )
                  })}
                </g>
              )}
              {vis['investment-signals'] && <Diamonds layerId="investment-signals" pts={SAMPLE_INVESTMENT_SIGNALS} />}

              {/* ── intelligence events (top, selectable) ─────────────────── */}
              {vis['intelligence-events'] && <EventMarks events={events} selectedId={selectedId} onSelect={onSelect} />}
            </svg>
          </div>

          <ActiveLegends vis={vis} />

          <p className="px-3 pb-2 pt-1.5 text-[11px] leading-4 text-ink-3">
            Events: size = severity · hollow = country-centroid coordinates (gap #23) · thin ring = escalation ≥ 0.7.
            Sample marks shown are real rows from each layer&apos;s source dataset; production renders the full sets on a
            self-hosted MapLibre dark basemap (score layers as country fills).
            {unwiredActive.length > 0 && (
              <span className="text-status-warning">
                {' '}
                ◌ {unwiredActive.join(', ')}: dataset exists but the current app ships no renderer — see backend-gaps.md.
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
