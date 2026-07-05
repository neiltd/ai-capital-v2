// MciLayer — GSMA Mobile Connectivity Index 2024 snapshot.
// One circle per country at its centroid, sized & colored by the overall
// MCI index score (0-100). Captures digital-readiness as a development
// signal — paired with hospitals (health) + datacenters (infra) for a
// proxy of "how is this country doing".
//
// Centroids come from the shared worldmap country-centroid lookup (see
// lib/geo/countryCentroids.ts), which covers all 211 known countries —
// including the full 173-country MCI list. If an MCI country is ever
// missing from that table, it is dropped from the layer and a dev-mode
// warning is logged so the gap is visible instead of silent.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import mciData from '../../data/validated/mci-latest.json'
import { getCountryCentroid } from '../../lib/geo/countryCentroids'
import type { LayerProps } from '../_core/types'

interface MciEntry {
  iso_code:       string
  country:        string
  region:         string
  year:           number
  cluster:        string  // Leader | Advanced | Transitioner | Discoverer
  index:          number
  infrastructure: number
  affordability:  number
  consumer_readiness: number
  content_and_services: number
  '5g_population_coverage'?: number
  // ...32 more indicators; we use a subset for tags
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mci = mciData as MciEntry[]

const CLUSTER_COLOR: Record<string, string> = {
  Leader:       '#22d3ee',  // cyan — best
  Advanced:     '#3b82f6',  // blue
  Transitioner: '#a855f7',  // purple
  Discoverer:   '#f59e0b',  // amber — emerging
}

export default function MciLayer({ visible, labelLayerId }: LayerProps) {
  const geoJSON = useMemo(() => {
    const skipped: string[] = []
    const features = mci
      .map(e => {
        const centroid = getCountryCentroid(e.iso_code)
        if (!centroid) {
          skipped.push(e.iso_code)
          return null
        }
        const [lng, lat] = centroid
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
          properties: {
            name:     e.country,
            subtitle: `${e.region} · MCI ${e.index.toFixed(1)} (${e.cluster})`,
            index:    e.index,
            color:    CLUSTER_COLOR[e.cluster] ?? '#64748b',
            tag_MCI:           e.index.toFixed(1),
            tag_Cluster:       e.cluster,
            tag_Infrastructure: e.infrastructure.toFixed(1),
            tag_Affordability: e.affordability.toFixed(1),
            tag_Consumer:      e.consumer_readiness.toFixed(1),
            tag_Content:       e.content_and_services.toFixed(1),
            ...(e['5g_population_coverage'] != null
              ? { tag_5G: `${e['5g_population_coverage'].toFixed(0)}%` } : {}),
          },
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)

    if (process.env.NODE_ENV !== 'production' && skipped.length > 0) {
      console.warn(`[MciLayer] ${skipped.length} countries had no centroid, skipped`, skipped)
    }

    return { type: 'FeatureCollection' as const, features }
  }, [])

  if (!visible) return null

  return (
    <Source id="mci" type="geojson" data={geoJSON}>
      <Layer
        id="mci-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          // Radius scales with index: 0→3, 100→14. Use linear interp.
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'index'],
            0,  3,
            50, 7,
            100, 14,
          ] as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        0.55,
          'circle-stroke-width':   1.5,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.6,
        }}
      />
    </Source>
  )
}
