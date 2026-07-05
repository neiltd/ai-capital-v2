/**
 * useGeoData — topology fetch and GeoJSON conversion lifecycle.
 *
 * Responsibilities:
 *   - Fetch countries-110m.json from the public/ directory (once, on mount)
 *   - Convert topojson → GeoJSON
 *   - Apply antimeridian fix (Fiji, Russia, USA/Alaska)
 *   - Attach ISO3 + numId properties to each feature
 *   - Expose ready state for loading overlay
 *
 * No UI logic. No business logic. No store reads.
 * Returns a stable, read-only GeoJSON object that never changes after mount.
 *
 * ─── Future scaling note ──────────────────────────────────────────────────────
 * The 110m topology (~500KB) is small enough to fetch on every page load.
 * If switching to 50m or 10m (multi-MB), consider:
 *   1. Moving the fetch into a Web Worker to avoid blocking the main thread
 *   2. Caching the converted GeoJSON in sessionStorage
 *   3. Or pre-converting at build time and serving as a static JSON asset
 *
 * ─── Future agent integration point ──────────────────────────────────────────
 * If the platform moves to sub-national intelligence (admin1/province level),
 * this hook will need to accept a `resolution` param ('110m' | '50m' | '10m')
 * and the topology object key ('countries' | 'provinces'). The rest of the
 * pipeline — antimeridian fix, property attachment — remains unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect } from 'react'
import * as topojson from 'topojson-client'
import { NUM_TO_ISO3 } from '../lib/geo/numToIso3'
import { fixFeatureCollection } from '../lib/geo/antimeridian'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GeoJSONData = any

export interface GeoDataResult {
  /** Processed GeoJSON FeatureCollection with iso3/numId/name properties. Null until ready. */
  geoJSON: GeoJSONData | null
  /** True once fetch + conversion is complete. Controls the loading overlay. */
  isReady: boolean
}

export function useGeoData(): GeoDataResult {
  const [geoJSON, setGeoJSON] = useState<GeoJSONData | null>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? '/'}countries-110m.json`)
      .then(r => r.json())
      .then((topo: GeoJSONData) => {
        const geo = topojson.feature(topo, topo.objects.countries) as GeoJSONData
        // Fix antimeridian crossings — see lib/geo/antimeridian.ts for details
        const fixed = fixFeatureCollection(geo)
        setGeoJSON({
          ...fixed,
          features: fixed.features.map((f: GeoJSONData) => ({
            ...f,
            properties: {
              numId: String(f.id),
              iso3: NUM_TO_ISO3[String(f.id)] ?? null,
              name: f.properties?.name ?? '',
            },
          })),
        })
        setIsReady(true)
      })
  }, [])

  return { geoJSON, isReady }
}
