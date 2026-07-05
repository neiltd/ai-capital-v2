import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Source, Layer, Marker } from 'react-map-gl/maplibre'
import tradeData from '../../data/trade-routes.json'
import type { EconomicTradeRoute as TradeRoute, StrategicChokepoint as Chokepoint } from './types'
import { isValidCoord, fixGeometry } from '../../utils/geoUtils'
import type { LayerProps } from '../_core/types'

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
}

export default function TradeRouteLayer({ visible, showChokepoints, labelLayerId }: Props) {
  const [cpTooltip, setCpTooltip] = useState<{ cp: Chokepoint; x: number; y: number } | null>(null)

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
          anchor="center" onClick={e => e.originalEvent.stopPropagation()}>
          <div
            style={{ width: 10, height: 10, background: RISK_COLOR[cp.riskLevel],
              transform: 'rotate(45deg)', border: '1px solid #070B14', cursor: 'pointer' }}
            onMouseEnter={e => setCpTooltip({ cp, x: e.clientX, y: e.clientY })}
            onMouseMove={e => setCpTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
            onMouseLeave={() => setCpTooltip(null)}
          />
        </Marker>
      ))}

      {cpTooltip && createPortal(
        <div className="fixed z-[9999] pointer-events-none"
          style={{ left: cpTooltip.x + 14, top: cpTooltip.y - 10 }}>
          <div className="rounded-xl shadow-2xl overflow-hidden"
            style={{ background: '#0A0F1E', border: '1px solid #1E2D4A', minWidth: 200, maxWidth: 240 }}>
            <div className="px-3.5 pt-3 pb-2 border-b" style={{ borderColor: '#1E2D4A' }}>
              <p className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-1">Chokepoint</p>
              <p className="text-[13px] font-bold text-white leading-snug">{cpTooltip.cp.name}</p>
            </div>
            <div className="px-3.5 py-2.5 flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-text-muted">Daily vessels</span>
                <span className="text-[12px] font-semibold text-text-secondary tabular-nums">{cpTooltip.cp.dailyVessels}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-text-muted">Global trade</span>
                <span className="text-[12px] font-semibold text-text-secondary tabular-nums">{cpTooltip.cp.percentGlobalTrade}%</span>
              </div>
              {cpTooltip.cp.currentThreat && (
                <p className="text-[11px] text-text-muted leading-snug pt-1 border-t" style={{ borderColor: '#1E2D4A' }}>
                  {cpTooltip.cp.currentThreat}
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
