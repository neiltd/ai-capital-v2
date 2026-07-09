// RefineryLayer — global oil/gas refineries >100k bpd + LNG terminals.
// Energy-security infrastructure signal.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import data from '../../data/validated/refineries.json'
import type { LayerProps } from '../_core/types'
import { densityFilter, densityScale, type Density } from '../_core/density'

interface RefineryEntry {
  id:                     string
  name:                   string
  operator:               string
  country:                string
  lat:                    number
  lng:                    number
  type:                   string  // crude_refinery | condensate | petrochemical | lng_export | lng_import
  capacityBarrelsPerDay:  number
  complexity:             number  // Nelson Complexity Index
  yearCommissioned?:      number
  status:                 string
  sourceUrl:              string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refineries = data as RefineryEntry[]

const TYPE_COLOR: Record<string, string> = {
  crude_refinery: '#fb923c',  // orange — crude
  condensate:     '#facc15',  // yellow — lighter crude
  petrochemical:  '#a855f7',  // purple — chemicals
  lng_export:     '#22d3ee',  // cyan — exporters
  lng_import:     '#3b82f6',  // blue — importers
}

const REFINERY_RADIUS_EXPR = [
  'case',
  ['>=', ['get', 'capacity'], 1000000], 8,
  ['>=', ['get', 'capacity'],  500000], 6,
  ['>=', ['get', 'capacity'],  250000], 4,
  3,
] as const

const REFINERY_OPACITY_EXPR = [
  'case',
  ['==', ['get', 'status'], 'operating'],    0.80,
  ['==', ['get', 'status'], 'operational'],  0.80,
  ['==', ['get', 'status'], 'maintenance'],  0.45,
  ['==', ['get', 'status'], 'planned'],      0.30,
  0.50,
] as const

interface Props extends LayerProps {
  density: Density
}

export default function RefineryLayer({ visible, labelLayerId, density }: Props) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: refineries
      .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng))
      .filter(r => r.status !== 'shutdown')
      .map(r => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] as [number, number] },
        properties: {
          name:     r.name,
          subtitle: `${r.operator} · ${r.country}${r.capacityBarrelsPerDay ? ` · ${(r.capacityBarrelsPerDay/1000).toFixed(0)}k bpd` : ''}`,
          capacity: r.capacityBarrelsPerDay ?? 0,
          color:    TYPE_COLOR[r.type] ?? '#64748b',
          status:   r.status,
          ...(r.complexity       ? { tag_Complexity:   r.complexity.toFixed(2) } : {}),
          ...(r.yearCommissioned ? { tag_Commissioned: String(r.yearCommissioned) } : {}),
          tag_Capacity:    `${(r.capacityBarrelsPerDay/1000).toFixed(0)}k bpd`,
          // No importance field — key tier = >=500k bpd (the two largest
          // capacity buckets already defined by this file's radius scale).
          isKey: (r.capacityBarrelsPerDay ?? 0) >= 500000,
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="refineries" type="geojson" data={geoJSON}>
      <Layer
        id="refinery-circles"
        type="circle"
        beforeId={labelLayerId}
        filter={densityFilter(density)}
        paint={{
          'circle-radius': densityScale(density, REFINERY_RADIUS_EXPR) as unknown as number,
          'circle-color': ['get', 'color'] as unknown as string,
          'circle-opacity': densityScale(density, REFINERY_OPACITY_EXPR) as unknown as number,
          'circle-stroke-width':   1,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.4,
        }}
      />
    </Source>
  )
}
