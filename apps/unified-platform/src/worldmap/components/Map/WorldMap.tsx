/**
 * WorldMap — map orchestration layer.
 *
 * Responsibilities:
 *   - Wire useGeoData, useCountryColors, useMapInteraction hooks
 *   - Detect the first symbol layer in the CARTO tile style (labelLayerId)
 *     so fills are inserted below map labels
 *   - Render <Map> with all intelligence layers
 *   - Render map overlays: loading spinner, legends, tooltip
 *
 * Contains NO data transformation, NO color computation, NO fetch logic.
 * All interaction handling is delegated to hooks.
 */

import { useEffect, useState } from 'react'
import Map, { Source, Layer, NavigationControl } from 'react-map-gl/maplibre'
import type { MapEvent } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useMapStore } from '../../store/useMapStore'
import { useGeoData } from '../../hooks/useGeoData'
import { useCountryColors } from '../../hooks/useCountryColors'
import { useMapInteraction } from '../../hooks/useMapInteraction'
import type { TooltipState } from '../../hooks/useMapInteraction'
import { useLayerIcons } from '../../hooks/useLayerIcons'
import ConflictZoneLayer    from '../../layers/geopolitical/ConflictZoneLayer'
import TradeRouteLayer      from '../../layers/economic/TradeRouteLayer'
import PortfolioTradeLayer  from '../../layers/economic/PortfolioTradeLayer'
import AirportLayer         from '../../layers/infrastructure/AirportLayer'
import PortLayer            from '../../layers/infrastructure/PortLayer'
import PowerLayer           from '../../layers/utilities/PowerLayer'
import RailHubLayer         from '../../layers/infrastructure/RailHubLayer'
import SubmarineCableLayer  from '../../layers/infrastructure/SubmarineCableLayer'
import DatacenterLayer      from '../../layers/infrastructure/DatacenterLayer'
import HospitalLayer        from '../../layers/infrastructure/HospitalLayer'
import RefineryLayer        from '../../layers/utilities/RefineryLayer'
import MineLayer            from '../../layers/utilities/MineLayer'
import WaterLayer           from '../../layers/utilities/WaterLayer'
import MciLayer             from '../../layers/utilities/MciLayer'
import EventsLayer          from '../../layers/intelligence/EventsLayer'

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

// Display colors for tooltip badges
const RISK_COLOR: Record<string, string>         = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' }
const CONF_COLOR: Record<string, string>         = { high: '#4ade80', medium: '#f59e0b', low: '#f87171' }
const IMPORTANCE_COLOR: Record<string, string>   = {
  critical: '#f97316',  // orange — global artery
  high:     '#3b82f6',  // blue   — regional strategic
  medium:   '#64748b',  // slate  — contextual
  low:      '#334155',  // dark   — background
}
const COORD_QUALITY_COLOR: Record<string, string> = {
  source_exact:     '#4ade80',  // green — GPS/field verified
  source_approx:    '#f59e0b',  // amber — geocoded estimate
  country_centroid: '#64748b',  // slate — country-level only
}

export default function WorldMap() {
  const { heatmapIndicator, isLayerVisible } = useMapStore()

  // ── Data hooks ────────────────────────────────────────────────────────────
  const { geoJSON, isReady } = useGeoData()
  const geoWithColors = useCountryColors(geoJSON)

  // ── Interaction hooks ─────────────────────────────────────────────────────
  const { tooltip, interactiveIds, handleMouseMove, handleMouseLeave, handleClick } = useMapInteraction()

  // ── MapLibre tile style — insert fills below label layers ─────────────────
  // Detected once on map load; stable for the lifetime of the session.
  const [labelLayerId, setLabelLayerId] = useState<string | undefined>()

  // ── Per-layer icon registration state ─────────────────────────────────────
  // useLayerIcons must be invoked from inside <Map> (the MapProvider scope).
  // IconRegistrar is a child component that calls the hook and lifts the
  // readiness flag back up via this state setter, so we can pass it to all
  // layers as iconsReady.
  const [iconsReady, setIconsReady] = useState(false)

  function handleMapLoad(e: MapEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers = (e.target.getStyle().layers ?? []) as any[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = layers.find((l: any) => l.type === 'symbol')
    setLabelLayerId(first?.id)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">

      {/* Loading overlay — visible until topology GeoJSON is ready */}
      {!isReady && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3"
          style={{ background: '#070B14' }}>
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-[12px] text-text-muted">Loading intelligence map…</p>
        </div>
      )}

      <Map
        mapStyle={MAP_STYLE}
        initialViewState={{ longitude: 0, latitude: 10, zoom: 1.5 }}
        style={{ width: '100%', height: '100%' }}
        interactiveLayerIds={interactiveIds}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onLoad={handleMapLoad}
      >
        {/* Country fill layer — inserted before tile labels */}
        {geoWithColors && (
          <Source id="countries" type="geojson" data={geoWithColors} generateId>
            <Layer
              id="countries-fill"
              type="fill"
              beforeId={labelLayerId}
              paint={{
                'fill-color': ['get', 'color'],
                'fill-opacity': 0.82,
              }}
            />
          </Source>
        )}

        {/* Per-layer icon registrar — registers SVG icons with the map and
            updates iconsReady. Must live inside <Map> to access useMap(). */}
        <IconRegistrar onReady={setIconsReady} />

        {/* Intelligence layers — controlled by layer registry visibility */}
        {/* ConflictZoneLayer renders both conflict markers AND zone polygons.
            Both are gated by 'conflicts', not 'conflict-zones' — they are ganged.
            See registry.ts COUPLING NOTE for decoupling instructions. */}
        <ConflictZoneLayer    visible={isLayerVisible('conflicts')}        labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <TradeRouteLayer      visible={isLayerVisible('trade-routes')}     showChokepoints={isLayerVisible('chokepoints')} labelLayerId={labelLayerId} />
        <PortfolioTradeLayer  visible={isLayerVisible('portfolio-trade')}  labelLayerId={labelLayerId} />
        <AirportLayer         visible={isLayerVisible('airports')}         labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <PortLayer            visible={isLayerVisible('seaports')}         labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <PowerLayer           visible={isLayerVisible('power-plants')}     labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <RailHubLayer         visible={isLayerVisible('rail-hubs')}        labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <SubmarineCableLayer  visible={isLayerVisible('submarine-cables')} labelLayerId={labelLayerId} />
        <DatacenterLayer      visible={isLayerVisible('datacenters')}      labelLayerId={labelLayerId} iconsReady={iconsReady} />
        <HospitalLayer        visible={isLayerVisible('hospitals')}        labelLayerId={labelLayerId} />
        <RefineryLayer        visible={isLayerVisible('refineries')}       labelLayerId={labelLayerId} />
        <MineLayer            visible={isLayerVisible('critical-minerals')} labelLayerId={labelLayerId} />
        <WaterLayer           visible={isLayerVisible('water-infra')}      labelLayerId={labelLayerId} />
        <MciLayer             visible={isLayerVisible('mci')}              labelLayerId={labelLayerId} />
        {/* Intelligence events — hub-imported, read-only display */}
        <EventsLayer          visible={isLayerVisible('intelligence-events')} labelLayerId={labelLayerId} iconsReady={iconsReady} />

        <NavigationControl position="top-right" showCompass={false} />
      </Map>

      {/* ── Map overlays ───────────────────────────────────────────────────── */}

      {/* Default legend — relationship colors, shown when no heatmap is active */}
      {heatmapIndicator === 'none' && (
        <div className="absolute bottom-4 left-3 z-10 rounded-lg p-2.5 border text-xs space-y-1.5"
          style={{ background: '#0E1525CC', borderColor: '#1E2D4A' }}>
          {[
            { color: '#2563eb', label: 'Selected' },
            { color: '#8b5cf6', label: 'Compare'  },
            { color: '#1e3a8a', label: 'Ally'     },
            { color: '#78350f', label: 'Neutral'  },
            { color: '#7f1d1d', label: 'Rival'    },
          ].map(l => (
            <div key={l.label} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: l.color }} />
              <span className="text-text-muted">{l.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Heatmap gradient legend */}
      {heatmapIndicator !== 'none' && (
        <div className="absolute bottom-4 left-3 z-10 rounded-lg p-2.5 border text-xs"
          style={{ background: '#0E1525CC', borderColor: '#1E2D4A' }}>
          <div className="w-32 h-2 rounded-full mb-1"
            style={{ background: 'linear-gradient(to right, #dc2626, #d97706, #16a34a)' }} />
          <div className="flex justify-between text-text-muted">
            <span>Low 1</span><span>High 10</span>
          </div>
        </div>
      )}

      {/* Tooltip — positioned relative to cursor */}
      {tooltip && <MapTooltip tooltip={tooltip} riskColor={RISK_COLOR} />}
    </div>
  )
}

// ── IconRegistrar — invokes useLayerIcons inside the MapProvider scope ─────
// useMap() only resolves to a real map ref when called from a descendant of
// the react-map-gl <Map> component. This thin wrapper lets us register
// icons there while keeping `iconsReady` state in WorldMap so it can be
// passed to sibling layers as a prop.
function IconRegistrar({ onReady }: { onReady: (ready: boolean) => void }) {
  const { ready } = useLayerIcons()
  useEffect(() => { onReady(ready) }, [ready, onReady])
  return null
}

// ── MapTooltip — isolated tooltip renderer ─────────────────────────────────
// Extracted as a local component so the tooltip JSX doesn't inflate WorldMap's
// render return. Not a separate file — it has no independent use case.
function MapTooltip({
  tooltip,
  riskColor,
}: {
  tooltip: TooltipState
  riskColor: Record<string, string>
}) {
  return (
    <div
      className="absolute pointer-events-none z-50"
      style={{ left: tooltip.x + 14, top: tooltip.y - 36 }}
    >
      <div className="rounded-lg shadow-xl border text-xs" style={{ background: '#0E1525', borderColor: '#1E2D4A' }}>

        {tooltip.kind === 'country' && (
          <div className="px-2.5 py-1.5">
            <span className="font-medium text-white">{tooltip.name}</span>
            {tooltip.score !== undefined && (
              <span className="ml-2 text-text-muted">{tooltip.score.toFixed(1)}/10</span>
            )}
          </div>
        )}

        {tooltip.kind === 'route' && (
          <div className="px-3 py-2 space-y-1 max-w-52">
            <p className="font-semibold text-white">{tooltip.name}</p>
            <p className="text-text-muted">{tooltip.from} → {tooltip.to}</p>
            <p className="text-text-muted">{tooltip.goods}</p>
            <p className="text-text-muted">
              {tooltip.value} ·{' '}
              <span style={{ color: riskColor[tooltip.risk] }}>{tooltip.risk} risk</span>
            </p>
          </div>
        )}

        {tooltip.kind === 'infrastructure' && (
          <div className="px-3 py-2.5 max-w-64 space-y-1.5">
            {/* Strategic importance badge — shown when data is available */}
            {tooltip.importance && IMPORTANCE_COLOR[tooltip.importance] && (
              <p className="text-[9px] uppercase tracking-widest font-semibold"
                style={{ color: IMPORTANCE_COLOR[tooltip.importance] }}>
                {tooltip.importance}
              </p>
            )}
            <p className="font-semibold text-white leading-snug">{tooltip.name}</p>
            <p className="text-[11px] text-text-muted">{tooltip.subtitle}</p>
            {tooltip.tags.length > 0 && (
              <div className="flex flex-col gap-1 pt-1.5 border-t" style={{ borderColor: '#1E2D4A' }}>
                {tooltip.tags.map(t => (
                  <div key={t.label} className="flex justify-between items-center gap-3">
                    <span className="text-[10px] text-text-muted flex-shrink-0">{t.label}</span>
                    <span className="text-[10px] text-text-secondary text-right truncate">{t.value}</span>
                  </div>
                ))}
              </div>
            )}
            {tooltip.note && (
              <p className="text-[10px] text-text-inactive leading-snug pt-1.5 border-t line-clamp-3"
                style={{ borderColor: '#1E2D4A' }}>
                {tooltip.note}
              </p>
            )}
          </div>
        )}

        {tooltip.kind === 'event' && (
          <div className="px-3 py-2.5 max-w-64 space-y-1.5">
            {/* Event type */}
            <p className="text-[9px] uppercase tracking-widest font-semibold text-text-muted">
              {tooltip.eventType.replace('.', ' › ')}
            </p>
            {/* Headline */}
            <p className="font-semibold text-white leading-snug">{tooltip.headline}</p>
            {/* Date + quality + confidence row */}
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              <span className="text-text-muted">{tooltip.eventDate}</span>
              {tooltip.coordQuality && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                  style={{
                    color:      COORD_QUALITY_COLOR[tooltip.coordQuality] ?? '#64748b',
                    background: '#0D1829',
                    border:     `1px solid ${(COORD_QUALITY_COLOR[tooltip.coordQuality] ?? '#64748b')}44`,
                  }}>
                  {tooltip.coordQuality}
                </span>
              )}
              <span style={{ color: CONF_COLOR[tooltip.confidenceLabel] ?? '#94a3b8' }}>
                {tooltip.confidenceLabel} conf.
              </span>
            </div>
            {/* Coordinate source (when available) */}
            {tooltip.coordSource && (
              <p className="text-[10px] text-text-inactive">loc: {tooltip.coordSource}</p>
            )}
            {/* Fatalities */}
            {tooltip.fatalities > 0 && (
              <p className="text-[11px] text-red-400">{tooltip.fatalities} fatalities</p>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
