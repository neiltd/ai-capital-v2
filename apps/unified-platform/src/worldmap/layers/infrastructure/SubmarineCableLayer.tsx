/**
 * SubmarineCableLayer — submarine cable visualization.
 *
 * Cable LINES were already Source + Layer (GPU) — unchanged.
 * Landing POINTS migrated from React Marker (~120 DOM elements) to GPU circles.
 *
 * Two separate GeoJSON Sources:
 *   'submarine-cables'       — cable route LineStrings (derived from landing points)
 *   'cable-landing-points'   — landing point Points
 *
 * Both cable and landing point data are baked into each landing point feature's
 * properties so the generic infrastructure tooltip can render cable context
 * (name, capacity, operator) alongside landing point location context (city, country).
 *
 * Production data (validated/submarine-cables.json, 300 records) has no `route`
 * or `strategicImportance`/`geopoliticalNotes` fields — cable lines are derived
 * by connecting landing points in array order; `importance`/`note` are left
 * empty until that data is populated. No halo layer added — will be added when
 * strategic-importance data is populated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import { fixGeometry, isValidCoord } from '../../utils/geoUtils'
import cablesData from '../../data/validated/submarine-cables.json'
import type { LayerProps } from '../_core/types'

/**
 * Real shape of validated/submarine-cables.json (verified against all 300
 * records). Landing points carry `lat`/`lng` — NOT a `coordinates` tuple —
 * and cables have no `route`, `owners`, `strategicImportance`, or
 * `geopoliticalNotes` fields. Cable lines are derived by connecting each
 * cable's landing points in array order (see cablesGeo below).
 */
interface CableLandingPoint {
  city:    string
  country: string
  lat:     number
  lng:     number
}

interface SubmarineCable {
  id:            string
  name:          string
  operator:      string
  status:        string
  lengthKm?:     number
  capacityTbps?: number
  yearReady?:    number
  sourceUrl?:    string
  landingPoints: CableLandingPoint[]
}

const cables = cablesData as SubmarineCable[]

const STATUS_COLOR: Record<string, string> = {
  active:       '#06b6d4',
  construction: '#f59e0b',
  planned:      '#64748b',
  damaged:      '#ef4444',
  unknown:      '#475569',
}

export default function SubmarineCableLayer({ visible, labelLayerId }: LayerProps) {

  // ── Cable route LineStrings — production data has no `route` field, so we
  // derive one LineString per cable by connecting its landing points in the
  // order they appear in the array. Reasonably accurate for a world map at
  // this zoom level (matches how the original `route` polylines were drawn).
  const cablesGeo = useMemo(() => {
    const features = cables
      .map(c => {
        const coords = (c.landingPoints ?? [])
          .map((lp): [number, number] => [lp.lng, lp.lat])
          .filter(isValidCoord)
        return { c, coords }
      })
      .filter(({ coords }) => coords.length >= 2)
      .map(({ c, coords }) => ({
        type: 'Feature' as const,
        geometry: fixGeometry({ type: 'LineString', coordinates: coords }),
        properties: {
          id:           c.id,
          name:         c.name,
          status:       c.status,
          capacityTbps: c.capacityTbps ?? null,
          lengthKm:     c.lengthKm ?? null,
          yearReady:    c.yearReady ?? null,
          operator:     c.operator ?? null,
        },
      }))

    if (process.env.NODE_ENV !== 'production' && features.length === 0 && cables.length > 0) {
      console.warn(`[SubmarineCableLayer] built 0 line features from ${cables.length} cable records — check data shape`)
    }

    return { type: 'FeatureCollection' as const, features }
  }, [])

  // ── Landing point circles — cable + point data baked into each feature ────
  // Landing points are shaped { city, country, lat, lng } — not { coordinates }.
  const landingGeo = useMemo(() => {
    const features = cables.flatMap((cable) =>
      (cable.landingPoints ?? [])
        .filter((lp): lp is CableLandingPoint => isValidCoord([lp.lng, lp.lat]))
        .map((lp) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [lp.lng, lp.lat] as [number, number] },
          properties: {
            // Tooltip fields — cable name as primary, landing point as subtitle
            name:       cable.name,
            subtitle:   [`Landing: ${lp.city}`, lp.country].filter(Boolean).join(' · '),
            importance: '',
            note:       '',
            ...(cable.capacityTbps ? { tag_Capacity:      `${cable.capacityTbps} Tbps` }      : {}),
            ...(cable.lengthKm     ? { tag_Length:        `${cable.lengthKm.toLocaleString()} km` } : {}),
            ...(cable.yearReady    ? { tag_YearReady:     String(cable.yearReady) }             : {}),
            tag_LandingPoints: String((cable.landingPoints ?? []).length),
            ...(cable.operator ? { tag_Operator: cable.operator } : {}),
            // Paint input
            color: STATUS_COLOR[cable.status] ?? '#475569',
          },
        }))
    )

    if (process.env.NODE_ENV !== 'production' && features.length === 0 && cables.length > 0) {
      console.warn(`[SubmarineCableLayer] built 0 landing point features from ${cables.length} cable records — check data shape`)
    }

    return { type: 'FeatureCollection' as const, features }
  }, [])

  if (!visible) return null

  return (
    <>
      {/* ── Cable route lines (unchanged) ──────────────────────────────── */}
      <Source id="submarine-cables" type="geojson" data={cablesGeo}>
        <Layer
          id="submarine-cables-glow"
          type="line"
          beforeId={labelLayerId}
          paint={{
            'line-color': ['match', ['get', 'status'],
              'active', '#06b6d4', 'construction', '#f59e0b', 'damaged', '#ef4444', '#475569',
            ],
            'line-width': 6,
            'line-opacity': 0.08,
          }}
        />
        <Layer
          id="submarine-cables-line"
          type="line"
          beforeId={labelLayerId}
          paint={{
            'line-color': ['match', ['get', 'status'],
              'active', '#06b6d4', 'construction', '#f59e0b',
              'planned', '#64748b', 'damaged', '#ef4444', '#475569',
            ],
            'line-width': 2,
            'line-opacity': 0.75,
            'line-dasharray': ['match', ['get', 'status'],
              'construction', ['literal', [4, 3]],
              'planned',      ['literal', [2, 4]],
              ['literal', [1]],
            ],
          }}
        />
      </Source>

      {/* ── Landing point circles ───────────────────────────────────────── */}
      <Source id="cable-landing-points" type="geojson" data={landingGeo}>
        <Layer
          id="cable-landing-circles"
          type="circle"
          paint={{
            'circle-radius':         4,
            'circle-color':          ['get', 'color'] as unknown as string,
            'circle-opacity':        0.85,
            'circle-stroke-width':   1,
            'circle-stroke-color':   '#0A0F1E',
            'circle-stroke-opacity': 0.6,
          }}
        />
      </Source>
    </>
  )
}
