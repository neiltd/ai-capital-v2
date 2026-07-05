/**
 * DatacenterLayer — datacenter visualization using MapLibre Source + Layer.
 *
 * Migrated from React Marker components (180 DOM elements) to GPU circles.
 *
 * Note: DatacenterTier (Uptime Institute I–IV redundancy rating) is separate from
 * strategicImportance (geopolitical/intelligence significance). This layer uses
 * strategicImportance for opacity and shows tierLevel in the tooltip only.
 *
 * ─── Zoom-aware filtering (future) ───────────────────────────────────────────
 * Add filter expression to 'datacenter-circles' Layer when strategicImportance
 * is populated. Pattern identical to PowerLayer — see that file's comment.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { isValidCoord } from '../../utils/geoUtils'
import dcData from '../../data/validated/datacenters.json'
import type { LayerProps } from '../_core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const datacenters = dcData as any[]

const TYPE_COLOR: Record<string, string> = {
  hyperscale:  '#a78bfa',
  colocation:  '#22d3ee',
  enterprise:  '#64748b',
  government:  '#ef4444',
  edge:        '#34d399',
}

const TYPE_LABEL: Record<string, string> = {
  hyperscale: 'Hyperscale',
  colocation: 'Colocation',
  enterprise: 'Enterprise',
  government: 'Government',
  edge:       'Edge',
}

// Radius: type-based (hyperscale and government are most visible)
const RADIUS_EXPR = [
  'match', ['get', 'dcType'],
  'hyperscale', 7,
  'government', 7,
  'colocation', 5,
  4,
] as const

// Opacity: importance-driven when present; status-based fallback
const OPACITY_EXPR = [
  'case',
  ['==', ['get', 'status'], 'operational'],
    ['match', ['get', 'importance'],
      'critical', 0.90,
      'high',     0.75,
      'medium',   0.55,
      0.50,  // null/missing — neutral, data gap visible
    ],
  ['==', ['get', 'status'], 'construction'], 0.55,
  ['==', ['get', 'status'], 'planned'],      0.30,
  0.15,
] as const

const HALO_RADIUS_EXPR = [
  'match', ['get', 'dcType'],
  'hyperscale', 14,
  'government', 14,
  10,
] as const

function brandLabel(operator?: string | null): string {
  if (!operator) return ''
  if (/amazon|aws/i.test(operator))         return 'AWS'
  if (/google/i.test(operator))             return 'GCP'
  if (/microsoft|azure/i.test(operator))    return 'Azure'
  if (/meta/i.test(operator))               return 'Meta'
  if (/alibaba/i.test(operator))            return 'Alibaba'
  if (/equinix/i.test(operator))            return 'Equinix'
  if (/digital realty/i.test(operator))     return 'DigitalRealty'
  if (/ntt/i.test(operator))                return 'NTT'
  if (/huawei/i.test(operator))             return 'Huawei'
  return operator.split(' ')[0]
}

export default function DatacenterLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: datacenters
      .filter(d => isValidCoord(d.coordinates) && d.status !== 'decommissioned')
      .map(d => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: d.coordinates as [number, number] },
        properties: {
          name:       d.name,
          subtitle:   `${TYPE_LABEL[d.type] ?? d.type} · ${d.city} · ${d.countryId}`,
          importance: d.strategicImportance ?? '',
          note:       d.geopoliticalNotes ?? '',
          ...(d.operator    ? { tag_Operator:    brandLabel(d.operator) } : {}),
          ...(d.cloudRegion ? { tag_CloudRegion: d.cloudRegion }         : {}),
          ...(d.capacityMW  ? { tag_Capacity:    `${d.capacityMW} MW` } : {}),
          ...(d.tierLevel   ? { tag_UptimeTier:  `Tier ${d.tierLevel}` } : {}),
          ...(d.yearOpened  ? { tag_Opened:      String(d.yearOpened) }  : {}),
          ...(d.pue         ? { tag_PUE:         String(d.pue) }         : {}),
          // Paint inputs
          color:  TYPE_COLOR[d.type] ?? '#64748b',
          dcType: d.type,
          status: d.status,
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="datacenters" type="geojson" data={geoJSON}>

      <Layer
        id="datacenter-halo"
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
        id="datacenter-circles"
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

      {/* Server-rack glyph — separates datacenters from generic circle layers.
          strategicImportance is not yet populated on this dataset, so the
          gate falls back to dcType: hyperscale + government at low zoom,
          everything once zoomed past z4. */}
      {iconsReady && (
        <Layer
          id="datacenter-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['case',
            ['<', ['zoom'], 1], false,
            ['<', ['zoom'], 4],
              ['any',
                ['==', ['get', 'importance'], 'critical'],
                ['in', ['get', 'dcType'], ['literal', ['hyperscale', 'government']]],
              ],
            true,
          ]}
          layout={{
            'icon-image': 'layer-datacenter',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 5, 0.55, 9, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
