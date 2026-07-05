/**
 * RailHubLayer — rail hub visualization using MapLibre Source + Layer (GPU circles).
 *
 * Migrated from React Marker components (216 DOM elements) to GPU circles.
 * strategicImportance is fully populated across all 216 records.
 *
 * BRI signal: the original implementation showed a tiny red DOM dot in the
 * corner of each BRI hub marker. In GPU rendering, this is expressed as a
 * red circle-stroke-color on BRI hubs vs dark on non-BRI. Red stroke ring
 * = BRI corridor participant. Semantically equivalent, more readable at scale.
 *
 * Color:  hub type (freight/passenger/mixed/high_speed/border_crossing/port_interface)
 * Radius: strategicImportance
 * Stroke: red (#ef4444) for BRI hubs, dark (#0A0F1E) otherwise
 *
 * ─── Zoom-aware filtering (future) ───────────────────────────────────────────
 * Add filter to 'rail-hub-circles' Layer when ready:
 *   filter: ['case',
 *     ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
 *     ['<', ['zoom'], 5], ['in', ['get', 'importance'], ['literal', ['critical','high']]],
 *     true
 *   ]
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { isValidCoord } from '../../utils/geoUtils'
import railData from '../../data/validated/rail-hubs.json'
import type { LayerProps } from '../_core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hubs = railData as any[]

const TYPE_COLOR: Record<string, string> = {
  passenger:       '#60a5fa',
  freight:         '#f59e0b',
  mixed:           '#a78bfa',
  high_speed:      '#22d3ee',
  border_crossing: '#f97316',
  port_interface:  '#34d399',
  military:        '#ef4444',
}

const TYPE_LABEL: Record<string, string> = {
  passenger:       'Passenger',
  freight:         'Freight',
  mixed:           'Mixed',
  high_speed:      'High Speed',
  border_crossing: 'Border Crossing',
  port_interface:  'Port Interface',
  military:        'Military',
}

function formatPassengers(n?: number | null): string {
  if (n == null) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M/day`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K/day`
  return `${n}/day`
}

function formatFreight(n?: number | null): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}Bt/yr`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}Mt/yr`
  return `${n}t/yr`
}

const RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 9,
  'high',     7,
  'medium',   5,
  4,
] as const

const OPACITY_EXPR = [
  'match', ['get', 'importance'],
  'critical', 0.90,
  'high',     0.78,
  'medium',   0.58,
  0.40,
] as const

const HALO_RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 18,
  14,
] as const

// BRI hubs get a red stroke ring; non-BRI get the standard dark stroke.
// This replaces the DOM corner dot from the previous Marker implementation.
const STROKE_COLOR_EXPR = [
  'case',
  ['==', ['get', 'isBRI'], true], '#ef4444',
  '#0A0F1E',
] as const

export default function RailHubLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: hubs
      .filter(h => isValidCoord(h.coordinates))
      .map(h => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: h.coordinates as [number, number] },
        properties: {
          name:       h.name,
          subtitle:   `${TYPE_LABEL[h.type] ?? h.type} · ${h.city} · ${h.countryId}`,
          importance: h.strategicImportance ?? 'medium',
          note:       h.geopoliticalNotes ?? '',
          ...(h.dailyPassengers        != null ? { tag_Passengers: formatPassengers(h.dailyPassengers) } : {}),
          ...(h.annualFreightTonnes    != null ? { tag_Freight:    formatFreight(h.annualFreightTonnes) } : {}),
          ...(h.lineCount  != null && h.lineCount > 0 ? { tag_Lines: String(h.lineCount) } : {}),
          ...(h.gaugeType               ? { tag_Gauge:     h.gaugeType }                          : {}),
          ...(h.connectedCountries?.length
            ? { tag_Connected: h.connectedCountries.join(', ') }
            : {}),
          ...(h.isPartOfBRI             ? { 'tag_BRI Corridor': 'Yes' }                          : {}),
          // Paint inputs
          color: TYPE_COLOR[h.type] ?? '#64748b',
          isBRI: h.isPartOfBRI === true,
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="rail-hubs" type="geojson" data={geoJSON}>

      <Layer
        id="rail-hub-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['==', ['get', 'importance'], 'critical']}
        paint={{
          'circle-radius':  HALO_RADIUS_EXPR as unknown as number,
          'circle-color':   ['get', 'color'] as unknown as string,
          'circle-opacity': 0.10,
          'circle-stroke-width': 0,
        }}
      />

      <Layer
        id="rail-hub-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':         RADIUS_EXPR as unknown as number,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        OPACITY_EXPR as unknown as number,
          // BRI hubs: red stroke ring. Non-BRI: standard dark stroke.
          'circle-stroke-width':   2,
          'circle-stroke-color':   STROKE_COLOR_EXPR as unknown as string,
          'circle-stroke-opacity': 0.85,
        }}
      />

      {/* Train glyph — distinguishes rail hubs from ports and airports. */}
      {iconsReady && (
        <Layer
          id="rail-hub-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['case',
            ['<', ['zoom'], 1], false,
            ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
            ['<', ['zoom'], 3], ['in', ['get', 'importance'], ['literal', ['critical', 'high']]],
            true,
          ]}
          layout={{
            'icon-image': 'layer-rail',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 5, 0.55, 9, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
