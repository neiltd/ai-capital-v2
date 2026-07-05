'use client'

// Portfolio trade exposure layer. Lines drawn between country centroids weighted
// by the latest bilateral flow USD value, colored by commodity. Chokepoints are
// clickable — selecting one highlights every lane that passes through it AND
// lists portfolio tickers exposed to those lanes.
//
// Data source: GET /api/trade-graph?portfolioOnly=true (default — readability).
// All hover/click state is local to this component; no zustand for V1.

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Source, Layer, Marker } from 'react-map-gl/maplibre'
import type { LayerProps } from '../_core/types'
import CausalTreePanel from './CausalTreePanel'

// ── Wire types — keep in sync with src/app/api/trade-graph/route.ts ─────────
interface CountryDto    { iso3: string; name: string; centroidLat: number | null; centroidLon: number | null }
interface FlowDto       { originIso3: string; destIso3: string; commodity: string; valueUsd: string; periodYear: number; periodQuarter: number | null }
interface ChokepointDto { id: string; name: string; lat: number; lon: number; description: string | null }
interface ChokepointRouteDto { chokepointId: string; originIso3: string; destIso3: string }
interface TickerDepDto  { ticker: string; countryIso3: string; commodity: string; chokepointId: string | null; criticality: number; rationale: string | null }
interface TradeGraphResponse {
  countries:        CountryDto[]
  flows:            FlowDto[]
  chokepoints:      ChokepointDto[]
  chokepointRoutes: ChokepointRouteDto[]
  tickerDeps:       TickerDepDto[]
  laneExposure:     Record<string, string[]>
}

interface TaggedEventDto {
  eventId:             string
  title:               string
  summary:             string
  eventType:           string
  severity:            number
  status:              string
  occurredAt:          string
  expiresAt:           string
  affectedCountries:   string[]
  affectedChokepoints: string[]
  affectedFacilities:  AffectedFacilityDto[]
}
interface AffectedFacilityDto {
  type:      'hospital' | 'refinery' | 'mine' | 'water' | 'datacenter'
  id:        string
  name:      string
  country:   string
  lat:       number
  lng:       number
  matchedOn: string
}

// Match the public event_id format from /api/trade-graph/events. Used to look
// up the canonical event in the causal-tree panel — we pass it through verbatim.
interface EventsResponse {
  events:               TaggedEventDto[]
  windowHours:          number
  countSourcesScanned:  number
}

// Commodity colors — match the 10-bucket enum from apps/trade-graph types.ts.
const COMMODITY_COLOR: Record<string, string> = {
  energy:            '#ef4444', // red
  semis:             '#06b6d4', // cyan
  pharma:            '#a855f7', // purple
  food:              '#f59e0b', // amber
  industrial_metals: '#94a3b8', // slate
  vehicles:          '#10b981', // emerald
  agriculture:       '#84cc16', // lime
  chemicals:         '#ec4899', // pink
  textiles:          '#fb923c', // orange
  other:             '#6b7280', // gray
}

interface Props extends LayerProps {
  /** Optional — narrow the view to a single ticker's exposure. */
  ticker?: string | null
}

interface ChokepointHover {
  cp: ChokepointDto
  exposedTickers: string[]
  x: number
  y: number
}

export default function PortfolioTradeLayer({ visible, labelLayerId, ticker }: Props) {
  const [data, setData] = useState<TradeGraphResponse | null>(null)
  const [events, setEvents] = useState<TaggedEventDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedChokepoint, setSelectedChokepoint] = useState<string | null>(null)
  const [cpHover, setCpHover] = useState<ChokepointHover | null>(null)
  // Pulse phase oscillates 0..1; affected lanes' opacity = lerp(0.35, 1.0, phase).
  const [pulsePhase, setPulsePhase] = useState(0)
  // Which event the user has expanded into a causal tree (null = panel closed).
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    const url = ticker
      ? `/api/trade-graph?ticker=${encodeURIComponent(ticker)}`
      : `/api/trade-graph`
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: TradeGraphResponse) => setData(d))
      .catch(e => {
        const message = e instanceof Error ? e.message : String(e)
        console.error('[PortfolioTradeLayer] failed to load /api/trade-graph:', message)
        setError(message)
      })
  }, [visible, ticker])

  // Pull trade-disrupting events on mount + refresh every 5 min.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const fetchEvents = () => fetch('/api/trade-graph/events')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: EventsResponse) => { if (!cancelled) setEvents(d.events) })
      .catch(() => { /* events optional — silently skip */ })
    fetchEvents()
    const id = setInterval(fetchEvents, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [visible])

  // Pulse animation — single rAF loop driving every affected lane.
  useEffect(() => {
    if (!visible || events.length === 0) return
    let raf = 0
    const t0 = performance.now()
    const loop = () => {
      const elapsed = (performance.now() - t0) / 1000
      // 1.4-sec period, smooth sine 0..1
      setPulsePhase((Math.sin(elapsed * (Math.PI * 2 / 1.4)) + 1) / 2)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [visible, events.length])

  // For each (origin, dest), the set of chokepoints they pass through.
  const chokepointsByLane = useMemo(() => {
    const m = new Map<string, Set<string>>()
    data?.chokepointRoutes.forEach(r => {
      const k = `${r.originIso3}>${r.destIso3}`
      const set = m.get(k) ?? new Set<string>()
      set.add(r.chokepointId)
      m.set(k, set)
    })
    return m
  }, [data])

  // Build the set of lanes affected by any live event:
  //   - both endpoints touch an event's affectedCountries set (bilateral lane)
  //   - OR the lane passes through an affected chokepoint
  const affectedLaneKeys = useMemo(() => {
    if (!data || events.length === 0) return new Set<string>()
    const affectedCountries = new Set<string>()
    const affectedChokepoints = new Set<string>()
    for (const e of events) {
      e.affectedCountries.forEach(c => affectedCountries.add(c))
      e.affectedChokepoints.forEach(c => affectedChokepoints.add(c))
    }
    const out = new Set<string>()
    for (const flow of data.flows) {
      const key = `${flow.originIso3}>${flow.destIso3}`
      // Country match: either endpoint in any affected-country set.
      if (affectedCountries.has(flow.originIso3) || affectedCountries.has(flow.destIso3)) {
        out.add(key); continue
      }
      // Chokepoint match: the (origin,dest) pair routes through an affected chokepoint.
      const laneChokepoints = chokepointsByLane.get(key)
      if (laneChokepoints) {
        let hit = false
        affectedChokepoints.forEach(cp => { if (laneChokepoints.has(cp)) hit = true })
        if (hit) out.add(key)
      }
    }
    return out
  }, [data, events, chokepointsByLane])

  // Per-chokepoint exposed-ticker lookup, built once per `data` change instead
  // of being recomputed on every hover mouse-move. Reuses the same
  // routes-filter + laneExposure-union logic the summary memo below needs for
  // its ticker counts, so it's computed exactly once for both consumers.
  const exposedTickersByChokepoint = useMemo(() => {
    const m = new Map<string, string[]>()
    if (!data) return m
    for (const cp of data.chokepoints) {
      const routes = data.chokepointRoutes.filter(r => r.chokepointId === cp.id)
      const ts = new Set<string>()
      for (const r of routes) {
        const k = `${r.originIso3}>${r.destIso3}`
        ;(data.laneExposure[k] ?? []).forEach(t => ts.add(t))
      }
      m.set(cp.id, Array.from(ts).sort())
    }
    return m
  }, [data])

  // Aggregate stats for the always-on summary panel:
  // total exposed lanes, top chokepoints by exposed-ticker count.
  const summary = useMemo(() => {
    if (!data) return null
    const lanesExposed = Object.keys(data.laneExposure).length
    const uniqueTickers = new Set<string>()
    Object.values(data.laneExposure).forEach(arr => arr.forEach(t => uniqueTickers.add(t)))
    const chokepointStats = data.chokepoints
      .map(cp => ({ cp, tickerCount: (exposedTickersByChokepoint.get(cp.id) ?? []).length }))
      .sort((a, b) => b.tickerCount - a.tickerCount)
    return { lanesExposed, tickerCount: uniqueTickers.size, chokepointStats }
  }, [data, exposedTickersByChokepoint])

  if (!visible) return null
  if (error)  return null  // surfaced via dev console; map stays usable
  if (!data)  return null

  return (
    <>
      {/* Bilateral flow lines REMOVED — they were unreadable spaghetti.
          Replaced with the always-on summary panel + chokepoint markers below.
          The data still drives ticker-exposure indices for the click panel. */}

      {data.chokepoints.map(cp => {
        const isSelected = selectedChokepoint === cp.id
        const exposedTickers = exposedTickersByChokepoint.get(cp.id) ?? []
        return (
          <Marker key={cp.id} longitude={cp.lon} latitude={cp.lat} anchor="center">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setSelectedChokepoint(prev => prev === cp.id ? null : cp.id)
              }}
              onMouseEnter={(e) => setCpHover({ cp, exposedTickers, x: e.clientX, y: e.clientY })}
              onMouseMove={(e)  => setCpHover(h => h ? { ...h, x: e.clientX, y: e.clientY } : null)}
              onMouseLeave={() => setCpHover(null)}
              style={{
                width: isSelected ? 16 : 12,
                height: isSelected ? 16 : 12,
                background: isSelected ? '#fef3c7' : '#fbbf24',
                transform: 'rotate(45deg)',
                border: '1.5px solid #070B14',
                cursor: 'pointer',
                padding: 0,
              }}
              title={cp.name}
              aria-label={cp.name}
            />
          </Marker>
        )
      })}

      {/* Chokepoint tooltip */}
      {cpHover && createPortal(
        <div className="fixed z-[9999] pointer-events-none"
          style={{ left: cpHover.x + 14, top: cpHover.y - 10 }}>
          <div className="rounded-xl shadow-2xl overflow-hidden"
            style={{ background: '#0A0F1E', border: '1px solid #1E2D4A', minWidth: 240, maxWidth: 320 }}>
            <div className="px-3.5 pt-3 pb-2 border-b" style={{ borderColor: '#1E2D4A' }}>
              <p className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-1">Chokepoint</p>
              <p className="text-[13px] font-bold text-white leading-snug">{cpHover.cp.name}</p>
            </div>
            <div className="px-3.5 py-2.5 flex flex-col gap-1.5">
              {cpHover.cp.description && (
                <p className="text-[11px] text-text-muted leading-snug">{cpHover.cp.description}</p>
              )}
              <div className="flex justify-between items-center pt-1 border-t" style={{ borderColor: '#1E2D4A' }}>
                <span className="text-[11px] text-text-muted">Exposed tickers</span>
                <span className="text-[12px] font-semibold text-text-primary tabular-nums">{cpHover.exposedTickers.length}</span>
              </div>
              {cpHover.exposedTickers.length > 0 && (
                <p className="text-[11px] text-text-secondary leading-snug">
                  {cpHover.exposedTickers.slice(0, 8).join(', ')}
                  {cpHover.exposedTickers.length > 8 ? `, +${cpHover.exposedTickers.length - 8} more` : ''}
                </p>
              )}
              <p className="text-[10px] text-text-muted italic pt-1">Click to filter map</p>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Always-on summary panel — replaces the unreadable line spaghetti.
          Shows portfolio exposure ranked by chokepoint, clickable to drill in. */}
      {summary && createPortal(
        <div className="fixed z-[9970] bottom-4 right-4 w-72 rounded-xl shadow-2xl overflow-hidden"
          style={{ background: '#0A0F1E', border: '1px solid #1E2D4A' }}>
          <div className="px-4 pt-3 pb-2 border-b" style={{ borderColor: '#1E2D4A' }}>
            <p className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-1">
              Portfolio trade exposure
            </p>
            <div className="flex justify-between items-baseline">
              <div>
                <p className="text-[12px] text-text-muted">{summary.lanesExposed} lanes</p>
                <p className="text-[20px] font-bold text-white tabular-nums">{summary.tickerCount}</p>
                <p className="text-[10px] text-text-muted -mt-0.5">unique tickers exposed</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-3 max-h-72 overflow-y-auto">
            <p className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Top chokepoints by exposure</p>
            <div className="flex flex-col gap-1.5">
              {summary.chokepointStats.slice(0, 8).map(({ cp, tickerCount }) => (
                <button key={cp.id}
                  onClick={() => setSelectedChokepoint(prev => prev === cp.id ? null : cp.id)}
                  className={`text-left rounded-lg px-3 py-2 transition flex justify-between items-center ${
                    selectedChokepoint === cp.id ? 'bg-amber-950/40' : 'hover:bg-bg-card-hover'
                  }`}
                  style={{ border: selectedChokepoint === cp.id ? '1px solid #f59e0b' : '1px solid #1E2D4A' }}>
                  <span className="text-[12px] text-text-primary">{cp.name}</span>
                  <span className="text-[12px] font-bold tabular-nums"
                    style={{ color: tickerCount > 50 ? '#fbbf24' : '#94a3b8' }}>
                    {tickerCount}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-text-muted italic pt-2">Click a chokepoint to highlight + see exposed tickers</p>
          </div>
        </div>,
        document.body,
      )}

      {/* Affected-facilities overlay — bright red markers wherever an event's
          title/summary names a known hospital, refinery, mine, etc. Pulses with
          the same phase as affected lanes. Visible regardless of whether the
          underlying facility layer (hospitals/refineries/…) is toggled on. */}
      {events.flatMap(e => e.affectedFacilities).length > 0 && (
        <Source id="affected-facilities" type="geojson" data={{
          type: 'FeatureCollection',
          features: events.flatMap(ev => ev.affectedFacilities.map(f => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [f.lng, f.lat] as [number, number] },
            properties: {
              eventId:   ev.eventId,
              eventTitle: ev.title,
              facilityId: f.id,
              facilityType: f.type,
              facilityName: f.name,
              matchedOn:  f.matchedOn,
            },
          })))
        }}>
          <Layer
            id="affected-facility-halo"
            type="circle"
            beforeId={labelLayerId}
            paint={{
              'circle-radius':  16,
              'circle-color':   '#dc2626',
              'circle-opacity': 0.15 + pulsePhase * 0.25,
              'circle-stroke-width': 0,
            }}
          />
          <Layer
            id="affected-facility-marker"
            type="circle"
            beforeId={labelLayerId}
            paint={{
              'circle-radius':         7,
              'circle-color':          '#dc2626',
              'circle-opacity':        0.7 + pulsePhase * 0.3,
              'circle-stroke-width':   2,
              'circle-stroke-color':   '#fef3c7',
              'circle-stroke-opacity': 0.9,
            }}
          />
        </Source>
      )}

      {/* Live events banner — fixed top of map, shows trade-disrupting events */}
      {events.length > 0 && createPortal(
        <div className="fixed z-[9980] top-4 left-1/2 -translate-x-1/2 max-w-2xl w-[90%]">
          <div className="rounded-xl shadow-2xl overflow-hidden"
            style={{ background: '#1A0F0F', border: '1px solid #7c2d12' }}>
            <div className="px-4 py-2 border-b flex items-center gap-2"
              style={{ borderColor: '#7c2d12' }}>
              <span className="inline-block w-2 h-2 rounded-full"
                style={{ background: '#dc2626', boxShadow: '0 0 8px #dc2626' }} />
              <span className="text-[11px] uppercase tracking-widest font-semibold text-red-300">
                {events.length} trade-disrupting event{events.length === 1 ? '' : 's'} (24h)
              </span>
              <span className="text-[11px] text-text-muted ml-auto">affected lanes pulse</span>
            </div>
            <div className="px-4 py-2 flex flex-col gap-1.5 max-h-32 overflow-y-auto">
              {events.slice(0, 4).map(e => (
                <button key={e.eventId}
                  onClick={() => setExpandedEventId(e.eventId)}
                  className="text-left text-[12px] hover:bg-red-950/40 rounded px-1 py-0.5 transition">
                  <span className="text-text-muted mr-2">[{e.eventType}/sev{e.severity}]</span>
                  <span className="text-text-primary underline decoration-dotted underline-offset-2">{e.title}</span>
                  {e.affectedChokepoints.length > 0 && (
                    <span className="ml-2 text-amber-300">
                      → {e.affectedChokepoints.join(', ')}
                    </span>
                  )}
                  {e.affectedFacilities.length > 0 && (
                    <span className="ml-2 text-red-300">
                      📍 {e.affectedFacilities.length} {e.affectedFacilities.length === 1 ? 'facility' : 'facilities'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Causal tree panel (opens when user clicks an event title in the banner) */}
      {expandedEventId && (
        <CausalTreePanel
          eventId={expandedEventId}
          onClose={() => setExpandedEventId(null)}
          onSelectEvent={(id) => setExpandedEventId(id)}
        />
      )}

      {/* Selected-chokepoint side panel */}
      {selectedChokepoint && data && (() => {
        const cp = data.chokepoints.find(c => c.id === selectedChokepoint)
        if (!cp) return null
        const tickers = exposedTickersByChokepoint.get(cp.id) ?? []
        return createPortal(
          <div className="fixed z-[9990] top-20 right-4 w-80 rounded-xl shadow-2xl overflow-hidden"
            style={{ background: '#0A0F1E', border: '1px solid #1E2D4A' }}>
            <div className="px-4 pt-3 pb-2 border-b flex justify-between items-start"
              style={{ borderColor: '#1E2D4A' }}>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-400 mb-1">
                  Filtered by chokepoint
                </p>
                <p className="text-[14px] font-bold text-white">{cp.name}</p>
              </div>
              <button onClick={() => setSelectedChokepoint(null)}
                className="text-text-muted hover:text-text-secondary text-lg leading-none">×</button>
            </div>
            <div className="px-4 py-3 flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
              {cp.description && (
                <p className="text-[12px] text-text-muted leading-snug">{cp.description}</p>
              )}
              <p className="text-[11px] uppercase tracking-wider text-text-muted mt-2">
                {tickers.length} portfolio tickers exposed
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {tickers.map(t => (
                  <span key={t}
                    className="text-[11px] font-medium text-text-secondary px-2 py-1 rounded text-center tabular-nums"
                    style={{ background: '#0F1729', border: '1px solid #1E2D4A' }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )
      })()}
    </>
  )
}
