// WaterLayer — strategic water infrastructure: desalination plants + key dams.
// Surfaces water-security investment, especially Gulf desal capacity and major
// Asian hydropower.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import data from '../../data/validated/water-infrastructure.json'
import type { LayerProps } from '../_core/types'

interface WaterEntry {
  id:                string
  name:              string
  country:           string
  lat:               number
  lng:               number
  type:              string  // desalination | hydropower_dam | water_supply_dam | combined
  capacityMLD?:      number | null
  capacityGWh?:      number | null
  operator?:         string
  yearCommissioned?: number
  status:            string
  sourceUrl:         string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const water = data as WaterEntry[]

const TYPE_COLOR: Record<string, string> = {
  desalination:     '#06b6d4',  // cyan — sea water
  hydropower_dam:   '#3b82f6',  // blue — clean energy
  water_supply_dam: '#22c55e',  // green — supply
  combined:         '#a855f7',  // purple — multi-use
}

function radiusFor(w: WaterEntry): number {
  // Different units between desal (MLD) and hydropower (GWh). Use whichever
  // magnitude is meaningful — they roughly co-rank by infrastructure scale.
  const mld = w.capacityMLD ?? 0
  const gwh = w.capacityGWh ?? 0
  if (mld >= 1000 || gwh >= 10000) return 8
  if (mld >=  500 || gwh >=  5000) return 6
  if (mld >=  200 || gwh >=  2000) return 4
  return 3
}

export default function WaterLayer({ visible, labelLayerId }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: water
      .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng))
      .filter(w => w.status !== 'shutdown' && w.status !== 'decommissioned')
      .map(w => {
        const capacityTag = w.capacityMLD
          ? `${w.capacityMLD.toLocaleString()} MLD`
          : w.capacityGWh
            ? `${w.capacityGWh.toLocaleString()} GWh/yr`
            : null
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [w.lng, w.lat] as [number, number] },
          properties: {
            name:     w.name,
            subtitle: `${w.type.replace('_', ' ')} · ${w.country}${capacityTag ? ` · ${capacityTag}` : ''}`,
            radius:   radiusFor(w),
            color:    TYPE_COLOR[w.type] ?? '#64748b',
            ...(capacityTag        ? { tag_Capacity:     capacityTag } : {}),
            ...(w.operator         ? { tag_Operator:     w.operator } : {}),
            ...(w.yearCommissioned ? { tag_Commissioned: String(w.yearCommissioned) } : {}),
          },
        }
      }),
  }), [])

  if (!visible) return null

  return (
    <Source id="water-infrastructure" type="geojson" data={geoJSON}>
      <Layer
        id="water-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':         ['get', 'radius'] as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        0.75,
          'circle-stroke-width':   1,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.4,
        }}
      />
    </Source>
  )
}
