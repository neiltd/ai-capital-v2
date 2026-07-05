/**
 * PowerLayer — power plant visualization using MapLibre Source + Layer (GPU circles).
 *
 * Migrated from React Marker components (412 DOM elements) to GPU-rendered
 * circles. All tooltip data is baked into GeoJSON feature properties so
 * useMapInteraction can handle hover without any store lookups.
 *
 * ─── Rendering signals ────────────────────────────────────────────────────────
 * Color:   fuel type (nuclear=violet, gas=amber, coal=stone, hydro=sky, …)
 * Radius:  capacity in MW — proxy for installed significance
 * Opacity: strategicImportance when present; status-based fallback otherwise
 *          null/missing importance → neutral 0.45 (makes data gap visible)
 *
 * ─── Zoom-aware filtering (future) ───────────────────────────────────────────
 * Once strategicImportance is populated across all 412 records, add a MapLibre
 * filter expression to the 'power-plants-circles' Layer:
 *
 *   filter: ['case',
 *     ['<', ['zoom'], 3], ['==', ['get', 'importance'], 'critical'],
 *     ['<', ['zoom'], 5], ['in', ['get', 'importance'], ['literal', ['critical', 'high']]],
 *     true
 *   ]
 *
 * This shows only Tier 1 at global zoom, Tier 1+2 at continental, all at regional.
 * No code changes needed beyond adding this filter to the Layer props below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { isValidCoord } from '../../utils/geoUtils'
import plantsData from '../../data/validated/power-plants.json'
import type { LayerProps } from '../_core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plants = plantsData as any[]

// ── Color by fuel type ────────────────────────────────────────────────────────
const TYPE_COLOR: Record<string, string> = {
  nuclear:    '#a78bfa',
  coal:       '#78716c',
  gas:        '#f59e0b',
  oil:        '#92400e',
  hydro:      '#0ea5e9',
  solar:      '#fbbf24',
  wind:       '#34d399',
  geothermal: '#f97316',
  biomass:    '#84cc16',
  other:      '#64748b',
}

function formatCapacity(mw: number | null): string {
  if (!mw) return '—'
  return mw >= 1000 ? `${(mw / 1000).toFixed(1)} GW` : `${mw} MW`
}

// ── Paint expressions — evaluated on GPU, not per React render ────────────────

// Radius: capacity-based (MW). Interpretable without strategicImportance data.
const RADIUS_EXPR = [
  'case',
  ['>=', ['get', 'capacityMW'], 5000], 9,
  ['>=', ['get', 'capacityMW'], 2000], 7,
  ['>=', ['get', 'capacityMW'], 1000], 6,
  ['>=', ['get', 'capacityMW'], 500],  5,
  4,
] as const

// Opacity: importance-driven for operating plants; status-based otherwise.
// null/empty importance → 0.45 (neutral, makes data gap visible, not inferred).
const OPACITY_EXPR = [
  'case',
  ['==', ['get', 'status'], 'operating'],
    ['match', ['get', 'importance'],
      'critical', 0.90,
      'high',     0.75,
      'medium',   0.55,
      0.45,  // null or unknown — intentionally dim to signal missing classification
    ],
  ['==', ['get', 'status'], 'construction'], 0.60,
  ['==', ['get', 'status'], 'mothballed'],   0.30,
  0.20,
] as const

// Halo radius — larger soft glow behind critical-importance plants
const HALO_RADIUS_EXPR = [
  'case',
  ['>=', ['get', 'capacityMW'], 5000], 18,
  ['>=', ['get', 'capacityMW'], 2000], 14,
  12,
] as const

export default function PowerLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: plants
      .filter(p =>
        isValidCoord(p.coordinates) &&
        p.status !== 'decommissioned' &&
        p.status !== 'planned'
      )
      .map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: p.coordinates as [number, number] },
        properties: {
          // Tooltip fields (read by useMapInteraction infrastructure handler)
          name:       p.name,
          subtitle:   [p.type, p.city ?? p.countryId].filter(Boolean).join(' · '),
          importance: p.strategicImportance ?? '',
          note:       p.strategicNote ?? '',
          tag_Capacity:    formatCapacity(p.capacityMW),
          tag_Status:      p.status.charAt(0).toUpperCase() + p.status.slice(1),
          ...(p.operator        ? { tag_Operator:     p.operator }            : {}),
          ...(p.yearCommissioned ? { tag_Commissioned: String(p.yearCommissioned) } : {}),
          // Paint expression inputs
          color:      TYPE_COLOR[p.type] ?? '#64748b',
          capacityMW: p.capacityMW ?? 0,
          status:     p.status,
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <Source id="power-plants" type="geojson" data={geoJSON}>

      {/* Halo — critical-importance plants only, ambient depth cue */}
      <Layer
        id="power-plants-halo"
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

      {/* Main circles — all plants, interactive */}
      <Layer
        id="power-plants-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':        RADIUS_EXPR as unknown as number,
          'circle-color':         ['get', 'color'] as unknown as string,
          'circle-opacity':       OPACITY_EXPR as unknown as number,
          'circle-stroke-width':  1,
          'circle-stroke-color':  '#0A0F1E',
          'circle-stroke-opacity': 0.4,
        }}
      />

      {/* Lightning bolt glyph — distinguishes power from other dot layers.
          strategicImportance is sparse on this dataset; fall back to
          capacity-based gating so the largest plants always show first. */}
      {iconsReady && (
        <Layer
          id="power-plants-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['case',
            ['<', ['zoom'], 1], false,
            ['<', ['zoom'], 4],
              ['any',
                ['==', ['get', 'importance'], 'critical'],
                ['>=', ['get', 'capacityMW'], 2000],
              ],
            true,
          ]}
          layout={{
            'icon-image': 'layer-power',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.35, 5, 0.55, 9, 0.8],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
