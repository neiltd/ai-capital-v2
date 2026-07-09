import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Source, Layer, Marker } from 'react-map-gl/maplibre'
import tradeData from '../../data/trade-routes.json'
import type { EconomicTradeRoute as TradeRoute, StrategicChokepoint as Chokepoint } from './types'
import { isValidCoord, fixGeometry } from '../../utils/geoUtils'
import type { LayerProps } from '../_core/types'
import { useMapStore } from '../../store/useMapStore'

// Gemini's expanded trade-routes.json omits the optional `type` + `notes`
// fields that EconomicTradeRoute has — cast through unknown so the schema
// stays loose for ingest-driven data.
const routes      = tradeData.routes as unknown as TradeRoute[]
const chokepoints = tradeData.chokepoints as unknown as Chokepoint[]

const RISK_COLOR: Record<string, string> = {
  low: '#22c55e', medium: '#f59e0b', high: '#ef4444',
}

interface Props extends LayerProps {
  showChokepoints: boolean
  portalContainer?: Element | null
}

export default function TradeRouteLayer({ visible, showChokepoints, labelLayerId, portalContainer }: Props) {
  const [cpTooltip, setCpTooltip] = useState<{ cp: Chokepoint; x: number; y: number } | null>(null)
  const { selectedChokepoint: storeSelection, selectChokepoint, clearChokepoint } = useMapStore()
  const portalTarget = portalContainer ?? (typeof document !== 'undefined' ? document.body : null)

  function toggleChokepointSelection(cp: Chokepoint) {
    if (storeSelection?.id === cp.id) { clearChokepoint(); return }
    selectChokepoint({
      id: cp.id,
      name: cp.name,
      description: [
        cp.currentThreat ?? null,
        `${cp.dailyVessels} vessels/day`,
        `${cp.percentGlobalTrade}% of global trade`,
      ].filter(Boolean).join(' · '),
      // This static dataset (trade-routes.json) has no per-lane routing or
      // portfolio-ticker linkage — that's the portfolio-trade layer's job
      // (GET /api/trade-graph, live). Both layers share the same chokepoint
      // ID space, so selecting a chokepoint here still opens the Inspector's
      // ChokepointPanel with whatever context this dataset provides.
      lanesThrough: [],
      exposedTickers: [],
    })
  }

  const routesGeo = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: routes
      .filter(r => isValidCoord(r.from.coords) && isValidCoord(r.to.coords))
      .map(r => ({
        type: 'Feature' as const,
        // Use multi-segment waypoints when present; fall back to straight from→to line.
        // fixGeometry handles antimeridian crossings for both single and multi-segment paths.
        geometry: fixGeometry({
          type: 'LineString',
          coordinates: (r.waypoints && r.waypoints.length >= 2)
            ? r.waypoints
            : [r.from.coords, r.to.coords],
        }),
        properties: {
          id: r.id, name: r.name, volume: r.volume, riskLevel: r.riskLevel,
          keyGoods: (r.keyGoods ?? []).join(', '), annualValue: r.annualValue,
          fromName: r.from.name, toName: r.to.name,
          strategicImportance: r.strategicImportance ?? 'medium',
        },
      })),
  }), [])

  return (
    <>
      {visible && (
        <Source id="trade-routes" type="geojson" data={routesGeo}>
          <Layer
            id="trade-routes-line"
            type="line"
            beforeId={labelLayerId}
            paint={{
              'line-color': ['match', ['get', 'volume'],
                'critical', '#06b6d4', 'very_high', '#0ea5e9',
                'high', '#3b82f6', 'medium', '#6366f1', '#8b5cf6',
              ],
              'line-width': ['match', ['get', 'volume'],
                'critical', 3, 'very_high', 2.5, 'high', 2, 'medium', 1.5, 1,
              ],
              'line-opacity': 0.6,
            }}
          />
        </Source>
      )}

      {showChokepoints && chokepoints.filter(cp => isValidCoord(cp.coordinates)).map(cp => (
        <Marker key={cp.id} longitude={cp.coordinates[0]} latitude={cp.coordinates[1]}
          anchor="center" onClick={e => { e.originalEvent.stopPropagation(); toggleChokepointSelection(cp) }}>
          <div
            style={{
              width: storeSelection?.id === cp.id ? 14 : 10,
              height: storeSelection?.id === cp.id ? 14 : 10,
              background: RISK_COLOR[cp.riskLevel],
              transform: 'rotate(45deg)', border: '1px solid var(--surface)', cursor: 'pointer',
              boxShadow: storeSelection?.id === cp.id ? '0 0 0 2px #fff' : 'none',
            }}
            onMouseEnter={e => setCpTooltip({ cp, x: e.clientX, y: e.clientY })}
            onMouseMove={e => setCpTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
            onMouseLeave={() => setCpTooltip(null)}
          />
        </Marker>
      ))}

      {cpTooltip && portalTarget && createPortal(
        <div className="pointer-events-none absolute z-50"
          style={{ left: cpTooltip.x + 14, top: cpTooltip.y - 10 }}>
          <div className="overflow-hidden rounded-card border shadow-card-hover"
            style={{ background: 'var(--surface)', borderColor: 'var(--hairline)', minWidth: 200, maxWidth: 240 }}>
            <div className="px-3.5 pt-3 pb-2 border-b" style={{ borderColor: 'var(--hairline)' }}>
              <p className="text-[10px] uppercase tracking-widest font-semibold text-ink-3 mb-1">Chokepoint</p>
              <p className="text-[13px] font-bold text-ink leading-snug">{cpTooltip.cp.name}</p>
            </div>
            <div className="px-3.5 py-2.5 flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-ink-3">Daily vessels</span>
                <span className="tnum text-[12px] font-semibold text-ink-2">{cpTooltip.cp.dailyVessels}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-ink-3">Global trade</span>
                <span className="tnum text-[12px] font-semibold text-ink-2">{cpTooltip.cp.percentGlobalTrade}%</span>
              </div>
              {cpTooltip.cp.currentThreat && (
                <p className="text-[11px] text-ink-3 leading-snug pt-1 border-t" style={{ borderColor: 'var(--hairline)' }}>
                  {cpTooltip.cp.currentThreat}
                </p>
              )}
              <p className="text-[10px] text-ink-3 italic">Click for full detail</p>
            </div>
          </div>
        </div>,
        portalTarget,
      )}
    </>
  )
}
