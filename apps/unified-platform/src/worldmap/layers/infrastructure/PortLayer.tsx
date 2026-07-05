/**
 * PortLayer — seaport visualization using MapLibre Source + Layer (GPU circles).
 *
 * Migrated from React Marker components (264 DOM elements) to GPU circles.
 * strategicImportance is fully populated (86 critical, 111 high, 55 medium, 12 low).
 *
 * Color:   port type (container/oil/lng/bulk/multipurpose/naval/mixed)
 * Radius:  strategicImportance — ports are the one layer where importance
 *          directly drives size since the field is complete
 * Opacity: strategicImportance
 *
 * ─── Zoom-aware filtering (future) ───────────────────────────────────────────
 * Add filter to 'port-circles' Layer when ready:
 *   filter: ['case',
 *     ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
 *     ['<', ['zoom'], 5], ['in', ['get', 'importance'], ['literal', ['critical','high']]],
 *     true
 *   ]
 * At z1–3: 86 critical ports. At z4–5: 197. At z6+: all 264.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { isValidCoord } from '../../utils/geoUtils'
import portsData from '../../data/validated/seaports.json'
import type { LayerProps } from '../_core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ports = portsData as any[]

const TYPE_COLOR: Record<string, string> = {
  container:    '#06b6d4',
  oil:          '#f59e0b',
  lng:          '#f97316',
  bulk:         '#8b5cf6',
  multipurpose: '#3b82f6',
  naval:        '#ef4444',
  mixed:        '#22c55e',
}

const TYPE_LABEL: Record<string, string> = {
  container:    'Container',
  oil:          'Oil',
  lng:          'LNG',
  bulk:         'Bulk',
  multipurpose: 'Multipurpose',
  naval:        'Naval',
  mixed:        'Mixed',
}

function formatThroughput(teu?: number | null, tonnes?: number | null): string {
  if (teu != null) {
    if (teu >= 1e6) return `${(teu / 1e6).toFixed(1)}M TEU`
    if (teu >= 1e3) return `${(teu / 1e3).toFixed(0)}K TEU`
    return `${teu} TEU`
  }
  if (tonnes != null) {
    if (tonnes >= 1e6) return `${(tonnes / 1e6).toFixed(1)}Mt`
    return `${tonnes}t`
  }
  return '—'
}

// Radius by strategicImportance — fully populated on all 264 records
const RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 9,
  'high',     7,
  'medium',   5,
  4,
] as const

const OPACITY_EXPR = [
  'match', ['get', 'importance'],
  'critical', 0.92,
  'high',     0.80,
  'medium',   0.60,
  0.40,
] as const

const HALO_RADIUS_EXPR = [
  'match', ['get', 'importance'],
  'critical', 18,
  14,
] as const

export default function PortLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: ports
      .filter(p => isValidCoord(p.coordinates))
      .map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: p.coordinates as [number, number] },
        properties: {
          name:       p.name,
          subtitle:   `${TYPE_LABEL[p.type] ?? p.type} · ${p.city} · ${p.countryId}`,
          importance: p.strategicImportance ?? 'medium',
          note:       p.geopoliticalNotes ?? '',
          tag_Throughput: formatThroughput(p.annualThroughputTEU, p.annualThroughputTonnes),
          ...(p.berthCount  != null ? { tag_Berths:   String(p.berthCount) }    : {}),
          ...(p.maxDraftM   != null ? { tag_MaxDraft: `${p.maxDraftM}m` }       : {}),
          ...(p.riskLevel && p.riskLevel !== 'low'
            ? { tag_Risk: p.riskLevel }
            : {}),
          // Paint inputs
          color: TYPE_COLOR[p.type] ?? '#3b82f6',
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="seaports" type="geojson" data={geoJSON}>

      <Layer
        id="port-halo"
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
        id="port-circles"
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

      {/* Anchor glyph for visual distinction from airports/datacenters.
          Same importance-driven zoom gating as airports. */}
      {iconsReady && (
        <Layer
          id="port-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['case',
            ['<', ['zoom'], 1], false,
            ['<', ['zoom'], 2], ['==', ['get', 'importance'], 'critical'],
            ['<', ['zoom'], 3], ['in', ['get', 'importance'], ['literal', ['critical', 'high']]],
            true,
          ]}
          layout={{
            'icon-image': 'layer-port',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 5, 0.55, 9, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
