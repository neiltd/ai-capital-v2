// FoodSecurityLayer — country-fill choropleth of food-supply vulnerability.
// Registered in the registry but had no component until world-map-v2
// (round 3 human decision) — previously fed the heatmap dropdown only.
// Separate, layer-toggle-gated fill (see WaterStressLayer.tsx for the same
// pattern and rationale).
//
// Data: data/validated/food-security.json (148 countries, GHI/IPC/FAO),
// hungerIndex ~0-50+ (Global Hunger Index; higher = worse). Normalized to
// 0-1 by dividing by 50 (GHI's de facto "extremely alarming" ceiling) and
// clamped, then mapped through the amber-red ramp.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import foodSecurityData from '../../data/validated/food-security.json'
import { rampColor, FOOD_SECURITY_RAMP, NO_DATA_FILL } from '../_core/choropleth'
import type { LayerProps } from '../_core/types'
import type { GeoJSONData } from '../../hooks/useGeoData'

interface FoodSecurityEntry {
  iso3: string
  name: string
  hungerIndex: number
  ipcPhase: number | null
  undernourishmentPct: number | null
  cerealImportDependency: number | null
  category: string
  asOf: string
  sourceUrl?: string
}

const rows = foodSecurityData as FoodSecurityEntry[]
const byIso3 = new Map(rows.map(r => [r.iso3, r]))
const GHI_CEILING = 50

interface Props extends LayerProps {
  countriesGeoJSON: GeoJSONData | null
}

export default function FoodSecurityLayer({ visible, labelLayerId, countriesGeoJSON }: Props) {
  const geoJSON = useMemo(() => {
    if (!countriesGeoJSON) return null
    return {
      ...countriesGeoJSON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: countriesGeoJSON.features.map((f: any) => {
        const iso3: string | null = f.properties?.iso3
        const row = iso3 ? byIso3.get(iso3) : undefined
        const color = row
          ? rampColor(FOOD_SECURITY_RAMP, Math.min(1, row.hungerIndex / GHI_CEILING))
          : NO_DATA_FILL
        return {
          ...f,
          properties: {
            ...f.properties,
            foodSecurityColor: color,
            foodSecurityIndex: row?.hungerIndex ?? null,
            foodSecurityCategory: row?.category ?? null,
          },
        }
      }),
    }
  }, [countriesGeoJSON])

  if (!visible || !geoJSON) return null

  return (
    <Source id="food-security-countries" type="geojson" data={geoJSON}>
      <Layer
        id="food-security-fill"
        type="fill"
        beforeId={labelLayerId}
        paint={{
          'fill-color': ['get', 'foodSecurityColor'] as unknown as string,
          'fill-opacity': 0.75,
        }}
      />
    </Source>
  )
}
