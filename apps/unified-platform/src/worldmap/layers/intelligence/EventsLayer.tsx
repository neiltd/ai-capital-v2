/**
 * EventsLayer — renders hub-imported intelligence events using MapLibre
 * Source + Layer (GPU-rendered circles), not React Marker components.
 *
 * ─── Why Source + Layer, not Markers ─────────────────────────────────────────
 * React Marker components create one DOM element per event. At 50+ events
 * they begin to degrade; at 500+ they visibly stutter on zoom/pan.
 * MapLibre's circle layer renders thousands of points on the GPU, applies
 * data-driven paint expressions without touching the DOM, and plugs into
 * the existing onMouseMove feature-querying flow in useMapInteraction.
 *
 * ─── Rendering tiers ─────────────────────────────────────────────────────────
 * Two circle layers share one GeoJSON source:
 *
 *   intelligence-events-halo   (below, exact-only, soft ambient glow)
 *   intelligence-events-points (above, all events, interactive, tooltip)
 *
 * ─── Coordinate quality → visual signal ──────────────────────────────────────
 *   exact       → full opacity (0.90), 2px stroke, halo behind
 *   approximate → reduced opacity (0.65), no stroke, no halo
 *   centroid    → low opacity (0.35), flat 5px radius regardless of tier
 *   missing     → not included in GeoJSON → not rendered
 *
 * ─── Tooltips ─────────────────────────────────────────────────────────────────
 * Handled by useMapInteraction (onMouseMove on 'intelligence-events-points').
 * This component owns no tooltip state — it is a pure rendering layer.
 *
 * ─── Future scaling notes ─────────────────────────────────────────────────────
 * Clustering: add `cluster: true` to the Source when event count exceeds ~300
 * in a single viewport. MapLibre handles cluster GeoJSON natively.
 *
 * Filtering: add a `filter` prop to the Layer to show only events matching
 * active eventType filters — no data re-fetching, just expression change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { useIntelligenceStore } from '../../store/useIntelligenceStore'
import type { LayerProps } from '../_core/types'

// ── Event type → fill color ───────────────────────────────────────────────────
// Kept as a JS record so both this layer and useMapInteraction can reference
// the same values — single source of truth for event colors.
export const EVENT_TYPE_COLOR: Record<string, string> = {
  'conflict.armed':          '#ef4444',
  'conflict.protest':        '#f97316',
  'conflict.riot':           '#f59e0b',
  'conflict.cyberattack':    '#a78bfa',
  'diplomatic.cooperation':  '#22c55e',
  'diplomatic.dispute':      '#06b6d4',
  'economic.sanctions':      '#fbbf24',
  'economic.trade':          '#34d399',
  'energy.disruption':       '#f97316',
  'political.election':      '#8b5cf6',
  'political.coup':          '#ef4444',
  'political.policy':        '#60a5fa',
  'humanitarian.disaster':   '#fb7185',
  'humanitarian.crisis':     '#f43f5e',
  'other':                   '#64748b',
}

function eventColor(type: string): string {
  return EVENT_TYPE_COLOR[type] ?? '#64748b'
}

// ── Paint expressions (data-driven, evaluated on GPU) ────────────────────────

// ── Hub contract quality values (PM-confirmed 2026-05-14) ────────────────────
// source_exact    → precise GPS/field point
// source_approx   → geocoded estimate (city/district level)
// country_centroid→ no sub-national data, centroid only
// missing         → no coordinates; filtered out before GeoJSON build

// Radius: country_centroid events are always small (5px) to signal imprecision.
// source_exact and source_approx scale by tier (global=10, regional=7, local=5).
const RADIUS_EXPR = [
  'case',
  ['==', ['get', 'coordQuality'], 'country_centroid'], 5,
  ['==', ['get', 'tier'], 1], 10,
  ['==', ['get', 'tier'], 2], 7,
  5,
] as const

// Opacity signals coordinate confidence to the reader without any legend.
// source_exact = full presence; country_centroid = ghost to signal imprecision.
const OPACITY_EXPR = [
  'match', ['get', 'coordQuality'],
  'source_exact',     0.90,
  'source_approx',    0.65,
  'country_centroid', 0.35,
  0.65,   // fallback for any future hub values
] as const

// Stroke ring appears only on source_exact — crisp 2px border signals precision.
const STROKE_WIDTH_EXPR = [
  'match', ['get', 'coordQuality'],
  'source_exact', 2,
  0,
] as const

// Halo radius: ~2× the main circle, rendered only for source_exact events.
const HALO_RADIUS_EXPR = [
  'case',
  ['==', ['get', 'tier'], 1], 20,
  ['==', ['get', 'tier'], 2], 14,
  10,
] as const

export default function EventsLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const events = useIntelligenceStore(s => s.events)

  // Build GeoJSON once per events array change.
  // Excluded from the GeoJSON (not rendered on map):
  //   - coordinateQuality === 'missing'  (hub signals no location available)
  //   - coordinates is null/undefined    (belt-and-suspenders guard)
  // All tooltip-relevant data is baked into feature properties so
  // useMapInteraction can build tooltips from feature props only — no store lookup.
  const geoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: events
      .filter(e => e.coordinateQuality !== 'missing' && e.coordinates != null)
      .map(e => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: e.coordinates as [number, number],
        },
        properties: {
          id:              e.id,
          color:           eventColor(e.eventType),
          tier:            e.tier,
          coordQuality:    e.coordinateQuality ?? 'source_approx',
          coordSource:     e.coordinateSource  ?? '',
          // Tooltip fields — baked in so no store round-trip on hover
          headline:        e.headline,
          eventDate:       e.eventDate,
          eventType:       e.eventType,
          confidenceLabel: e.confidenceLabel,
          fatalities:      e.fatalities ?? 0,
        },
      })),
  }), [events])

  if (!visible) return null

  return (
    <Source id="intelligence-events" type="geojson" data={geoJSON}>

      {/* ── Halo layer — source_exact only, ambient glow behind the point ── */}
      <Layer
        id="intelligence-events-halo"
        type="circle"
        beforeId={labelLayerId}
        filter={['==', ['get', 'coordQuality'], 'source_exact']}
        paint={{
          'circle-radius':  HALO_RADIUS_EXPR as unknown as number,
          'circle-color':   ['get', 'color'] as unknown as string,
          'circle-opacity': 0.12,
          'circle-stroke-width': 0,
        }}
      />

      {/* ── Main point layer — all geocoordinated events, interactive ── */}
      <Layer
        id="intelligence-events-points"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':        RADIUS_EXPR as unknown as number,
          'circle-color':         ['get', 'color'] as unknown as string,
          'circle-opacity':       OPACITY_EXPR as unknown as number,
          'circle-stroke-width':  STROKE_WIDTH_EXPR as unknown as number,
          'circle-stroke-color':  '#0A0F1E',
          'circle-stroke-opacity': 0.6,
        }}
      />

      {/* Event glyph (bullseye ring) — flags this as an event vs an
          infrastructure point. Centroid events are omitted to avoid
          stamping an icon on imprecise coordinates. */}
      {iconsReady && (
        <Layer
          id="intelligence-events-icons"
          type="symbol"
          beforeId={labelLayerId}
          filter={['all',
            ['!=', ['get', 'coordQuality'], 'country_centroid'],
            ['case',
              ['<', ['zoom'], 1], false,
              ['<', ['zoom'], 3], ['==', ['get', 'tier'], 1],
              ['<', ['zoom'], 4], ['<=', ['get', 'tier'], 2],
              true,
            ],
          ]}
          layout={{
            'icon-image': 'layer-event',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.5, 10, 0.7],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
      )}

    </Source>
  )
}
