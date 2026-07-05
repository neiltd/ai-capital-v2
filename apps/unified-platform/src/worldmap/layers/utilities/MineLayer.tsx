// MineLayer — critical mineral mines, each producing ≥1% of global supply.
// 10 minerals colored distinctly so the choke-point geography reads at a glance.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import data from '../../data/validated/critical-mineral-mines.json'
import type { LayerProps } from '../_core/types'

interface MineEntry {
  id:                     string
  name:                   string
  operator:               string
  country:                string
  lat:                    number
  lng:                    number
  mineral:                string  // 10 minerals
  annualProductionTonnes: number
  globalShare:            number  // percentage
  yearOpened?:            number
  status:                 string
  sourceUrl:              string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mines = data as MineEntry[]

const MINERAL_COLOR: Record<string, string> = {
  copper:        '#f97316',  // orange — Cu
  lithium:       '#22d3ee',  // cyan
  cobalt:        '#3b82f6',  // blue
  nickel:        '#94a3b8',  // slate
  rare_earths:   '#a855f7',  // purple
  tin:           '#facc15',  // yellow
  tungsten:      '#0ea5e9',  // sky
  uranium:       '#10b981',  // emerald — radioactive vibes
  graphite:      '#6b7280',  // gray
  manganese:     '#ef4444',  // red — Mn
}

export default function MineLayer({ visible, labelLayerId }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: mines
      .filter(m => Number.isFinite(m.lat) && Number.isFinite(m.lng))
      .filter(m => m.status !== 'shutdown' && m.status !== 'closed')
      .map(m => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] as [number, number] },
        properties: {
          name:        m.name,
          subtitle:    `${m.operator ?? '—'} · ${m.mineral} · ${m.country}`,
          share:       m.globalShare ?? 0,
          color:       MINERAL_COLOR[m.mineral] ?? '#64748b',
          tag_Mineral: m.mineral,
          ...(m.annualProductionTonnes ? { tag_Production: `${m.annualProductionTonnes.toLocaleString()} t/yr` } : {}),
          ...(m.globalShare    ? { tag_GlobalShare: `${m.globalShare.toFixed(1)}%` } : {}),
          ...(m.yearOpened     ? { tag_Opened:      String(m.yearOpened) } : {}),
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="critical-mineral-mines" type="geojson" data={geoJSON}>
      {/* Halo on mines with >3% global share — chokepoint candidates */}
      <Layer
        id="mine-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['>=', ['get', 'share'], 3]}
        paint={{
          'circle-radius':  12,
          'circle-color':   ['get', 'color'] as unknown as string,
          'circle-opacity': 0.15,
          'circle-stroke-width': 0,
        }}
      />
      <Layer
        id="mine-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          // Share scale: <2%=3, 2-5%=4, 5-10%=6, >10%=8.
          'circle-radius': [
            'case',
            ['>=', ['get', 'share'], 10], 8,
            ['>=', ['get', 'share'],  5], 6,
            ['>=', ['get', 'share'],  2], 4,
            3,
          ] as unknown as number,
          'circle-color': ['get', 'color'] as unknown as string,
          'circle-opacity': 0.80,
          'circle-stroke-width':   1,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.5,
        }}
      />
    </Source>
  )
}
