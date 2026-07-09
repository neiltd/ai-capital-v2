// WaterStressLayer — country-fill choropleth of water scarcity risk.
// Registered in the registry but had no component until world-map-v2
// (round 3 human decision) — previously fed the heatmap dropdown only
// (lib/geo/indicators.ts's waterStressScore key). This is a SEPARATE,
// layer-toggle-gated fill so it can be shown without going into the
// heatmap selector, per the spec's "graded shading" round-3 direction.
//
// Data: data/validated/water-stress.json (194 countries, WRI Aqueduct 4.0),
// stressScore 0-5 (5 = extreme). Joined onto the same country polygons the
// main heatmap fill uses (passed down from WorldMap's useGeoData result) by
// iso3 — same join key as useCountryColors.ts.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import waterStressData from '../../data/validated/water-stress.json'
import { rampColor, WATER_STRESS_RAMP, NO_DATA_FILL } from '../_core/choropleth'
import type { LayerProps } from '../_core/types'
import type { GeoJSONData } from '../../hooks/useGeoData'

interface WaterStressEntry {
  iso3: string
  name: string
  stressScore: number // 0-5, WRI Aqueduct
  category: string
  trend: string
  sourceUrl?: string
}

const rows = waterStressData as WaterStressEntry[]
const byIso3 = new Map(rows.map(r => [r.iso3, r]))

interface Props extends LayerProps {
  countriesGeoJSON: GeoJSONData | null
}

export default function WaterStressLayer({ visible, labelLayerId, countriesGeoJSON }: Props) {
  const geoJSON = useMemo(() => {
    if (!countriesGeoJSON) return null
    return {
      ...countriesGeoJSON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: countriesGeoJSON.features.map((f: any) => {
        const iso3: string | null = f.properties?.iso3
        const row = iso3 ? byIso3.get(iso3) : undefined
        const color = row ? rampColor(WATER_STRESS_RAMP, row.stressScore / 5) : NO_DATA_FILL
        return {
          ...f,
          properties: {
            ...f.properties,
            waterStressColor: color,
            waterStressScore: row?.stressScore ?? null,
            waterStressCategory: row?.category ?? null,
          },
        }
      }),
    }
  }, [countriesGeoJSON])

  if (!visible || !geoJSON) return null

  return (
    <Source id="water-stress-countries" type="geojson" data={geoJSON}>
      <Layer
        id="water-stress-fill"
        type="fill"
        beforeId={labelLayerId}
        paint={{
          'fill-color': ['get', 'waterStressColor'] as unknown as string,
          'fill-opacity': 0.75,
        }}
      />
    </Source>
  )
}
