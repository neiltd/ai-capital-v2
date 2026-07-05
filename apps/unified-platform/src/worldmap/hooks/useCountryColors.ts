/**
 * useCountryColors — per-feature fill color computation.
 *
 * Responsibilities:
 *   - Apply heatmap indicator colors (normalised 0–10 scale)
 *   - Apply selection highlight (selected country = blue)
 *   - Apply comparison highlight (compare country = purple)
 *   - Apply relationship sentiment colors (ally/rival/neutral) for selected country
 *   - Fall back to a dim baseline for data-absent countries
 *
 * Takes the raw GeoJSON from useGeoData and returns a new GeoJSON object
 * with a `color` property baked into each feature's properties. MapLibre
 * then reads that property via ['get', 'color'] in the fill layer paint spec.
 *
 * No side effects. Deterministic: same inputs → same output.
 * Safe to call in useMemo — all dependencies are listed.
 *
 * ─── Color legend ─────────────────────────────────────────────────────────────
 *   Heatmap active:     scoreToColor / inverted (from lib/geo/indicators)
 *   Selected country:   #2563eb  (blue-600)
 *   Compare country:    #8b5cf6  (violet-500)
 *   Ally/positive:      #1e3a8a  (blue-900)
 *   Neutral:            #78350f  (amber-900)
 *   Rival/negative:     #7f1d1d  (red-900)
 *   Has intelligence:   #131C30  (dim navy — data exists but not selected)
 *   No intelligence:    #0C1220  (near-black — no data)
 *
 * ─── Future scaling note ──────────────────────────────────────────────────────
 * At 214 countries this useMemo runs in <1ms per indicator change.
 * If moving to sub-national features (thousands of regions), switch to
 * MapLibre expression-based coloring (match/interpolate evaluated on GPU)
 * instead of computing colors in JS. The indicators index shape won't change;
 * only the rendering strategy needs to change.
 *
 * ─── Future agent integration point ──────────────────────────────────────────
 * When AI agents begin producing real-time intelligence events (IntelligenceEvent),
 * the event's iso3[] array may trigger a different highlight color per country.
 * Add an `activeEventMap?: Record<string, string>` param here — the color
 * logic extends naturally without changing the MapLibre layer spec.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from 'react'
import { useMapStore } from '../store/useMapStore'
import { useIntelligenceStore } from '../store/useIntelligenceStore'
import { allIndicators, toHeatmapColor } from '../lib/geo/indicators'
import type { GeoJSONData } from './useGeoData'

const RELATIONSHIP_COLORS: Record<string, string> = {
  positive: '#1e3a8a',
  negative: '#7f1d1d',
  mixed:    '#78350f',
  neutral:  '#78350f',
}

export function useCountryColors(geoJSON: GeoJSONData | null): GeoJSONData | null {
  const { countryData, compareData, heatmapIndicator } = useMapStore()
  // eventsByIso3 is a stable object — changes only when imports are refreshed
  const eventsByIso3 = useIntelligenceStore(s => s.eventsByIso3)

  return useMemo(() => {
    if (!geoJSON) return null

    // Build relationship color lookup for the currently selected country.
    // Only recomputed when countryData changes.
    const relMap: Record<string, string> = {}
    if (countryData) {
      for (const rel of countryData.relationships ?? []) {
        relMap[rel.countryId] = RELATIONSHIP_COLORS[rel.sentiment] ?? RELATIONSHIP_COLORS.neutral
      }
    }

    return {
      ...geoJSON,
      features: geoJSON.features.map((f: GeoJSONData) => {
        const iso3: string | null = f.properties?.iso3
        let color = '#0C1220'  // default: no data

        if (heatmapIndicator !== 'none' && iso3) {
          // Heatmap mode: color by indicator score, inverted where high = bad
          const score = allIndicators[iso3]?.[heatmapIndicator]
          color = score !== undefined ? toHeatmapColor(heatmapIndicator, score) : '#1a1f2e'
        } else if (iso3 === countryData?.id) {
          color = '#2563eb'  // selected country
        } else if (iso3 === compareData?.id) {
          color = '#8b5cf6'  // compare country
        } else if (iso3 && relMap[iso3]) {
          color = relMap[iso3]  // relationship sentiment
        } else if (iso3 && eventsByIso3[iso3]?.length > 0) {
          // Country has hub-imported intelligence events — subtle highlight.
          // Lower priority than selection/compare/relationship, higher than baseline.
          // Future: shade by highest-tier or highest-confidence event for this country.
          color = '#1a2540'
        } else if (iso3 && allIndicators[iso3]) {
          color = '#131C30'  // has intelligence data but not selected
        }

        return { ...f, properties: { ...f.properties, color } }
      }),
    }
  }, [geoJSON, countryData, compareData, heatmapIndicator, eventsByIso3])
}
