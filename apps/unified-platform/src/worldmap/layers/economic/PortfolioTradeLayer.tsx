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
import { useMapStore } from '../../store/useMapStore'
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
  /**
   * DOM node to portal the panels into instead of document.body — WorldMap
   * passes a ref scoped to the map canvas so nothing floats over the rest of
   * the dashboard (world-map-v2: "nothing floats over the map [tab]"; the
   * summary panel, hover tooltip, and events banner all live inside the
   * canvas bounds via this container instead of viewport-fixed positioning).
   */
  portalContainer?: Element | null
}

interface ChokepointHover {
  cp: ChokepointDto
  exposedTickers: string[]
  x: number
  y: number
}

export default function PortfolioTradeLayer({ visible, labelLayerId, ticker, portalContainer }: Props) {
  const [data, setData] = useState<TradeGraphResponse | null>(null)
  const [events, setEvents] = useState<TaggedEventDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const { selectedChokepoint: storeSelection, selectChokepoint, clearChokepoint } = useMapStore()
  const [cpHover, setCpHover] = useState<ChokepointHover | null>(null)
  const portalTarget = portalContainer ?? (typeof document !== 'undefined' ? document.body : null)
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

  // Human-readable lane list per chokepoint — feeds the Inspector's
  // "Lanes through" row (ChokepointSelection.lanesThrough).
  const lanesThroughByChokepoint = useMemo(() => {
    const m = new Map<string, string[]>()
    if (!data) return m
    for (const cp of data.chokepoints) {
      const lanes = data.chokepointRoutes
        .filter(r => r.chokepointId === cp.id)
        .map(r => `${r.originIso3} → ${r.destIso3}`)
      m.set(cp.id, Array.from(new Set(lanes)).sort())
    }
    return m
  }, [data])

  function toggleChokepointSelection(cp: ChokepointDto) {
    if (storeSelection?.id === cp.id) {
      clearChokepoint()
      return
    }
    selectChokepoint({
      id: cp.id,
      name: cp.name,
      description: cp.description,
      lanesThrough: lanesThroughByChokepoint.get(cp.id) ?? [],
      exposedTickers: exposedTickersByChokepoint.get(cp.id) ?? [],
    })
  }

  if (!visible) return null
  if (error)  return null  // surfaced via dev console; map stays usable
  if (!data)  return null

  return (
    <>
      {/* Bilateral flow lines REMOVED — they were unreadable spaghetti.
          Replaced with the always-on summary panel + chokepoint markers below.
          The data still drives ticker-exposure indices for the click panel. */}

      {data.chokepoints.map(cp => {
        const isSelected = storeSelection?.id === cp.id
        const exposedTickers = exposedTickersByChokepoint.get(cp.id) ?? []
        return (
          <Marker key={cp.id} longitude={cp.lon} latitude={cp.lat} anchor="center">
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleChokepointSelection(cp)
              }}
              onMouseEnter={(e) => setCpHover({ cp, exposedTickers, x: e.clientX, y: e.clientY })}
              onMouseMove={(e)  => setCpHover(h => h ? { ...h, x: e.clientX, y: e.clientY } : null)}
              onMouseLeave={() => setCpHover(null)}
              style={{
                width: isSelected ? 16 : 12,
                height: isSelected ? 16 : 12,
                background: isSelected ? '#fef3c7' : '#fbbf24',
                transform: 'rotate(45deg)',
                border: '1.5px solid var(--surface)',
                cursor: 'pointer',
                padding: 0,
              }}
              title={cp.name}
              aria-label={cp.name}
            />
          </Marker>
        )
      })}

      {/* Chokepoint hover tooltip — supplements the click-to-inspect contract;
          full detail (lanes + exposed tickers) lives in the Inspector once clicked. */}
      {cpHover && portalTarget && createPortal(
        <div className="pointer-events-none absolute z-50"
          style={{ left: cpHover.x + 14, top: cpHover.y - 10 }}>
          <div className="overflow-hidden rounded-card border shadow-card-hover"
            style={{ background: 'var(--surface)', borderColor: 'var(--hairline)', minWidth: 240, maxWidth: 320 }}>
            <div className="px-3.5 pt-3 pb-2 border-b" style={{ borderColor: 'var(--hairline)' }}>
              <p className="text-[10px] uppercase tracking-widest font-semibold text-ink-3 mb-1">Chokepoint</p>
              <p className="text-[13px] font-bold text-ink leading-snug">{cpHover.cp.name}</p>
            </div>
            <div className="px-3.5 py-2.5 flex flex-col gap-1.5">
              {cpHover.cp.description && (
                <p className="text-[11px] text-ink-3 leading-snug">{cpHover.cp.description}</p>
              )}
              <div className="flex justify-between items-center pt-1 border-t" style={{ borderColor: 'var(--hairline)' }}>
                <span className="text-[11px] text-ink-3">Exposed tickers</span>
                <span className="tnum text-[12px] font-semibold text-ink">{cpHover.exposedTickers.length}</span>
              </div>
              <p className="text-[10px] text-ink-3 italic pt-1">Click for full detail</p>
            </div>
          </div>
        </div>,
        portalTarget,
      )}

      {/* Always-on summary panel — replaces the unreadable line spaghetti.
          Shows portfolio exposure ranked by chokepoint, clickable to drill into
          the Inspector. Contained within the map canvas (portalTarget), not the
          full viewport, per the "nothing floats over the map [tab]" principle. */}
      {summary && portalTarget && createPortal(
        <div className="pointer-events-auto absolute z-20 bottom-3 right-3 w-72 overflow-hidden rounded-card border shadow-card-hover"
          style={{ background: 'var(--surface)', borderColor: 'var(--hairline)' }}>
          <div className="px-4 pt-3 pb-2 border-b" style={{ borderColor: 'var(--hairline)' }}>
            <p className="text-[10px] uppercase tracking-widest font-semibold text-ink-3 mb-1">
              Portfolio trade exposure
            </p>
            <div className="flex justify-between items-baseline">
              <div>
                <p className="text-[12px] text-ink-3">{summary.lanesExposed} lanes</p>
                <p className="tnum text-[20px] font-bold text-ink">{summary.tickerCount}</p>
                <p className="text-[10px] text-ink-3 -mt-0.5">unique tickers exposed</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-3 max-h-72 overflow-y-auto">
            <p className="text-[10px] uppercase tracking-wider text-ink-3 mb-2">Top chokepoints by exposure</p>
            <div className="flex flex-col gap-1.5">
              {summary.chokepointStats.slice(0, 8).map(({ cp, tickerCount }) => (
                <button key={cp.id}
                  onClick={() => toggleChokepointSelection(cp)}
                  className={`text-left rounded-chip px-3 py-2 transition flex justify-between items-center border ${
                    storeSelection?.id === cp.id ? '' : 'hover:bg-surface-2'
                  }`}
                  style={{ borderColor: storeSelection?.id === cp.id ? '#f59e0b' : 'var(--hairline)' }}>
                  <span className="text-[12px] text-ink">{cp.name}</span>
                  <span className="tnum text-[12px] font-bold"
                    style={{ color: tickerCount > 50 ? '#fbbf24' : 'var(--ink-3)' }}>
                    {tickerCount}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-ink-3 italic pt-2">Click a chokepoint to highlight + see exposed tickers</p>
          </div>
        </div>,
        portalTarget,
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

      {/* Live events banner — contained within the map canvas (portalTarget),
          shows trade-disrupting events. */}
      {events.length > 0 && portalTarget && createPortal(
        <div className="pointer-events-auto absolute z-30 top-3 left-1/2 -translate-x-1/2 max-w-2xl w-[90%]">
          <div className="overflow-hidden rounded-card border shadow-card-hover"
            style={{ background: 'var(--surface)', borderColor: 'var(--loss)' }}>
            <div className="px-4 py-2 border-b flex items-center gap-2"
              style={{ borderColor: 'var(--loss)' }}>
              <span className="inline-block w-2 h-2 rounded-full"
                style={{ background: 'var(--loss)', boxShadow: '0 0 8px var(--loss)' }} />
              <span className="text-[11px] uppercase tracking-widest font-semibold" style={{ color: 'var(--loss)' }}>
                {events.length} trade-disrupting event{events.length === 1 ? '' : 's'} (24h)
              </span>
              <span className="text-[11px] text-ink-3 ml-auto">affected lanes pulse</span>
            </div>
            <div className="px-4 py-2 flex flex-col gap-1.5 max-h-32 overflow-y-auto">
              {events.slice(0, 4).map(e => (
                <button key={e.eventId}
                  onClick={() => setExpandedEventId(e.eventId)}
                  className="text-left text-[12px] hover:bg-surface-2 rounded px-1 py-0.5 transition">
                  <span className="text-ink-3 mr-2">[{e.eventType}/sev{e.severity}]</span>
                  <span className="text-ink underline decoration-dotted underline-offset-2">{e.title}</span>
                  {e.affectedChokepoints.length > 0 && (
                    <span className="ml-2" style={{ color: '#fbbf24' }}>
                      → {e.affectedChokepoints.join(', ')}
                    </span>
                  )}
                  {e.affectedFacilities.length > 0 && (
                    <span className="ml-2" style={{ color: 'var(--loss)' }}>
                      {e.affectedFacilities.length} {e.affectedFacilities.length === 1 ? 'facility' : 'facilities'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>,
        portalTarget,
      )}

      {/* Causal tree panel (opens when user clicks an event title in the banner) */}
      {expandedEventId && (
        <CausalTreePanel
          eventId={expandedEventId}
          onClose={() => setExpandedEventId(null)}
          onSelectEvent={(id) => setExpandedEventId(id)}
        />
      )}
    </>
  )
}
