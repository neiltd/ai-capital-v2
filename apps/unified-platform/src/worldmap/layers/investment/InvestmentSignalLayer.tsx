// InvestmentSignalLayer — country-level risk/opportunity signals by sector.
// Registered in the registry but had no component until world-map-v2 (round 3
// human decision: build the 4 dead-registered layers for real).
//
// Data: data/validated/investment-signals.json (240 rows, iso3-keyed, no
// coordinates) — one row per country×sector signal. Placed at the country
// centroid (lib/geo/countryCentroids.ts), same mechanism as MciLayer for
// country-level (not facility-level) points. Multiple signals can share a
// country's centroid (e.g. USA has ai/semis/energy rows) — MapLibre renders
// them stacked; the tooltip/inspector shows the specific row clicked.
//
// Structural template: MineLayer.tsx (halo + circle, tag_* tooltip props).
// Density: isKey = strength >= 4 (the two highest of the 1-5 conviction
// scale) — judgment call, documented in density.ts's per-layer contract.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import signalsData from '../../data/validated/investment-signals.json'
import { getCountryCentroid } from '../../lib/geo/countryCentroids'
import type { LayerProps } from '../_core/types'
import { densityFilter, densityScale, type Density } from '../_core/density'

interface SignalEntry {
  iso3:         string
  name:         string
  sector:       string
  signal:       'bullish' | 'neutral' | 'bearish'
  strength:     number // 1-5 conviction
  thesis:       string
  watchTickers: string[]
  riskFactors:  string[]
  asOf:         string
  sourceUrl?:   string
}

const signals = signalsData as SignalEntry[]

const SIGNAL_COLOR: Record<string, string> = {
  bullish: '#0ca30c',
  neutral: '#898781',
  bearish: '#d03b3b',
}

interface Props extends LayerProps {
  density: Density
}

export default function InvestmentSignalLayer({ visible, labelLayerId, density }: Props) {
  const geoJSON = useMemo(() => {
    const skipped: string[] = []
    // Multiple signals per country jitter slightly around the centroid so
    // they don't render as a single stacked point (small deterministic
    // offset by sector index within that country, not random — stable
    // across re-renders).
    const byCountry = new Map<string, SignalEntry[]>()
    for (const s of signals) {
      const arr = byCountry.get(s.iso3) ?? []
      arr.push(s)
      byCountry.set(s.iso3, arr)
    }
    const features: GeoJSON.Feature[] = []
    Array.from(byCountry.entries()).forEach(([iso3, rows]) => {
      const centroid = getCountryCentroid(iso3)
      if (!centroid) { skipped.push(iso3); return }
      const [lng, lat] = centroid
      rows.forEach((s, i) => {
        const n = rows.length
        const angle = (2 * Math.PI * i) / Math.max(n, 1)
        const spread = n > 1 ? 1.1 : 0
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [lng + Math.cos(angle) * spread, lat + Math.sin(angle) * spread],
          },
          properties: {
            name:       s.name,
            subtitle:   `${s.sector} · ${s.signal} (${s.strength}/5) · ${s.asOf}`,
            importance: s.strength >= 4 ? 'critical' : s.strength >= 2 ? 'high' : 'medium',
            note:       s.thesis,
            tag_Sector:      s.sector,
            tag_Signal:      s.signal,
            tag_Conviction:  `${s.strength}/5`,
            ...(s.watchTickers?.length ? { tag_Watch: s.watchTickers.join(', ') } : {}),
            ...(s.riskFactors?.length ? { tag_Risks: s.riskFactors.join(', ') } : {}),
            color: SIGNAL_COLOR[s.signal] ?? '#898781',
            isKey: s.strength >= 4,
          },
        })
      })
    })
    if (process.env.NODE_ENV !== 'production' && skipped.length > 0) {
      console.warn(`[InvestmentSignalLayer] ${skipped.length} countries had no centroid, skipped`, skipped)
    }
    return { type: 'FeatureCollection' as const, features }
  }, [])

  if (!visible) return null

  const radiusExpr = [
    'match', ['get', 'signal'],
    'bullish', 6, 'bearish', 6, 5,
  ]
  const opacityExpr = 0.82

  return (
    <Source id="investment-signals" type="geojson" data={geoJSON}>
      <Layer
        id="investment-signal-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['==', ['get', 'importance'], 'critical']}
        paint={{
          'circle-radius': 14,
          'circle-color': ['get', 'color'] as unknown as string,
          'circle-opacity': 0.14,
          'circle-stroke-width': 0,
        }}
      />
      <Layer
        id="investment-signal-circles"
        type="circle"
        beforeId={labelLayerId}
        filter={densityFilter(density)}
        paint={{
          'circle-radius':         densityScale(density, radiusExpr) as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        densityScale(density, opacityExpr) as unknown as number,
          'circle-stroke-width':   1.5,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.6,
        }}
      />
    </Source>
  )
}
