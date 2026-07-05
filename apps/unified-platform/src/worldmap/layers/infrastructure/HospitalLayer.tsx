// HospitalLayer — top hospital locations (Newsweek 2024 + JCI + beds).
// Surfaces healthcare-system strength as a soft-power / development signal.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import data from '../../data/validated/hospitals.json'
import type { LayerProps } from '../_core/types'

interface HospitalEntry {
  id:              string
  name:            string
  country:         string
  city:            string
  lat:             number
  lng:             number
  type:            string
  beds:            number
  globalRank:      number | null
  jciAccredited:   boolean
  specialties:     string[]
  researchOutput?: string
  fundingSource?:  string
  sourceUrl:       string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hospitals = data as HospitalEntry[]

// Color hospitals by funding source — captures the geopolitical signal
// (state-run health system vs private vs nonprofit research).
const COLOR_BY_FUNDING: Record<string, string> = {
  'Government':           '#3b82f6',
  'Public':               '#3b82f6',
  'Private Non-profit':   '#22d3ee',
  'Private For-profit':   '#a78bfa',
}
function colorFor(h: HospitalEntry): string {
  if (!h.fundingSource) return '#64748b'
  return COLOR_BY_FUNDING[h.fundingSource] ?? '#64748b'
}

export default function HospitalLayer({ visible, labelLayerId }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: hospitals
      .filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lng))
      .map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [h.lng, h.lat] as [number, number] },
        properties: {
          name:        h.name,
          subtitle:    `${h.city} · ${h.country}${h.beds ? ` · ${h.beds.toLocaleString()} beds` : ''}`,
          beds:        h.beds ?? 0,
          // The 12 globally-ranked hospitals get a halo. Others stay subtle.
          isRanked:    h.globalRank != null,
          ...(h.globalRank      ? { tag_Rank:        `#${h.globalRank}` } : {}),
          ...(h.beds            ? { tag_Beds:        h.beds.toLocaleString() } : {}),
          ...(h.jciAccredited   ? { tag_JCI:         'Accredited' } : {}),
          ...(h.researchOutput  ? { tag_Research:    h.researchOutput } : {}),
          ...(h.specialties && h.specialties.length > 0
            ? { tag_Specialties: h.specialties.slice(0, 3).join(', ') } : {}),
          color: colorFor(h),
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="hospitals" type="geojson" data={geoJSON}>
      {/* Halo on the 12 globally-ranked top hospitals */}
      <Layer
        id="hospital-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['==', ['get', 'isRanked'], true]}
        paint={{
          'circle-radius':  10,
          'circle-color':   ['get', 'color'] as unknown as string,
          'circle-opacity': 0.18,
          'circle-stroke-width': 0,
        }}
      />
      {/* Main circles. Larger for higher bed counts. */}
      <Layer
        id="hospital-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          // Beds scale: <500=3, 500-1000=4, 1000-1500=5, 1500-2500=6, >2500=8.
          'circle-radius': [
            'case',
            ['>=', ['get', 'beds'], 2500], 8,
            ['>=', ['get', 'beds'], 1500], 6,
            ['>=', ['get', 'beds'], 1000], 5,
            ['>=', ['get', 'beds'],  500], 4,
            3,
          ] as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        0.75,
          'circle-stroke-width':   1,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.5,
        }}
      />
    </Source>
  )
}
