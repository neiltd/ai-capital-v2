/**
 * AirportLayer — airport visualization using MapLibre Source + Layer (GPU circles).
 *
 * Migrated from React Marker components (320 DOM elements) to GPU circles.
 * Airports already have strategicImportance fully populated (82 critical,
 * 161 high, 73 medium, 4 low) so importance-driven rendering is active immediately.
 *
 * Color and size are both driven by strategicImportance — unlike power plants
 * where color is fuel type. For airports, importance IS the primary signal.
 *
 * ─── Zoom-aware filtering ─────────────────────────────────────────────────────
 * Airports are the best candidate for zoom filtering since importance is complete.
 * To activate, add to 'airport-circles' Layer:
 *
 *   filter: ['case',
 *     ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
 *     ['<', ['zoom'], 5], ['in', ['get', 'importance'], ['literal', ['critical','high']]],
 *     true
 *   ]
 *
 * At z1–3: 82 critical airports shown. At z4–5: 243. At z6+: all 320.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { isValidCoord } from '../../utils/geoUtils'
import airportsData from '../../data/validated/airports.json'
import type { LayerProps } from '../_core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const airports = airportsData as any[]

// Color by strategicImportance — airports' primary rendering signal
const IMPORTANCE_COLOR: Record<string, string> = {
  critical: '#f97316',  // orange — global hub
  high:     '#3b82f6',  // blue   — regional hub
  medium:   '#64748b',  // slate  — contextual
  low:      '#334155',  // dark   — minor
}

// Radius by strategicImportance
const RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 8,
  'high',     6,
  'medium',   4,
  3,
] as const

// Opacity — uniform for airports since all are operating
const OPACITY_EXPR = [
  'match', ['get', 'importance'],
  'critical', 0.90,
  'high',     0.80,
  'medium',   0.55,
  0.35,
] as const

const HALO_RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 16,
  12,
] as const

function formatVolume(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}

export default function AirportLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: airports
      .filter(ap => isValidCoord(ap.coordinates))
      .map(ap => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: ap.coordinates as [number, number] },
        properties: {
          name:       ap.name,
          subtitle:   [ap.iata, ap.city, ap.countryId].filter(Boolean).join(' · '),
          importance: ap.strategicImportance ?? 'medium',
          note:       ap.geopoliticalNotes ?? '',
          tag_Passengers: formatVolume(ap.passengerVolume),
          ...(ap.cargoVolume ? { tag_Cargo: `${formatVolume(ap.cargoVolume)} t/yr` } : {}),
          // Paint inputs
          color: IMPORTANCE_COLOR[ap.strategicImportance] ?? '#64748b',
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="airports" type="geojson" data={geoJSON}>

      {/* Halo — critical airports only */}
      <Layer
        id="airport-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['==', ['get', 'importance'], 'critical']}
        paint={{
          'circle-radius':  HALO_RADIUS_EXPR as unknown as number,
          'circle-color':   ['get', 'color'] as unknown as string,
          'circle-opacity': 0.12,
          'circle-stroke-width': 0,
        }}
      />

      {/* Main circles — all airports, interactive */}
      <Layer
        id="airport-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':         RADIUS_EXPR as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        OPACITY_EXPR as unknown as number,
          'circle-stroke-width':   1,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.4,
        }}
      />

      {/* Symbol icons — airplane glyph for visual distinction across layers.
          Critical at z>=2, high+ at z>=3, all at z>=4. Hidden at world zoom
          to avoid clutter. */}
      {iconsReady && (
        <Layer
          id="airport-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['case',
            ['<', ['zoom'], 1], false,
            ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
            ['<', ['zoom'], 3], ['in', ['get', 'importance'], ['literal', ['critical', 'high']]],
            true,
          ]}
          layout={{
            'icon-image': 'layer-airport',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 5, 0.55, 9, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
