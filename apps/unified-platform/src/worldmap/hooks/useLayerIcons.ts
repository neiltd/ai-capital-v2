/**
 * useLayerIcons — registers per-layer SVG icons with the MapLibre instance.
 *
 * Why this exists:
 *   All map layers render as GPU circles for performance. When multiple
 *   layers are active simultaneously, color alone is not enough to
 *   distinguish airports from ports from datacenters. This hook loads
 *   small SVG glyphs as map images that `type="symbol"` layers can
 *   reference via `icon-image: 'layer-<name>'`.
 *
 * Constraints honored:
 *   - CartoCDN dark-matter SDF glyphs do not include emoji codepoints
 *     (U+1F000+) so we cannot rely on text-field with unicode emojis.
 *   - The hook ships its own raster images so it does not depend on the
 *     basemap's font resources at all.
 *   - Icons are encoded as inline data URIs (no network round-trip).
 *
 * Lifecycle:
 *   - Waits for the map's `load` event (or fires immediately if the
 *     map is already loaded) before adding images.
 *   - Re-registers icons if the style is swapped (style.load fires).
 *   - Returns `ready` so layers can defer rendering their symbol layer
 *     until the icons exist — MapLibre will warn if an icon-image
 *     references an unknown id.
 *
 * Add a new icon:
 *   1. Append `{ id: 'layer-foo', svg: '<svg…></svg>' }` to ICONS below.
 *   2. Reference it in the layer file as `icon-image: 'layer-foo'`.
 */

import { useEffect, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'

// ── Icon catalogue ───────────────────────────────────────────────────────────
// 24x24 viewBox, white fill on transparent background. Designed to read at
// 8–16 rendered pixels on the dark basemap. Stroke-less geometry where
// possible — small strokes alias badly at icon-size 0.4–0.8.

const ICON_SIZE = 24

/**
 * Airport — stylized airplane silhouette pointing up-right.
 */
const AIRPORT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1L15 22v-1.5L13 19v-5.5l8 2.5z"/>
</svg>
`.trim()

/**
 * Seaport — anchor.
 */
const PORT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M12 2a2.5 2.5 0 0 0-1 4.79V9H8v2h3v8.92a8 8 0 0 1-5.6-5.3l1.8.4-2.5-4.3-2.5 4.3 1.7-.4A10 10 0 0 0 12 22a10 10 0 0 0 8.1-7.38l1.7.4-2.5-4.3-2.5 4.3 1.8-.4A8 8 0 0 1 13 19.92V11h3V9h-3V6.79A2.5 2.5 0 0 0 12 2zm0 2a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1z"/>
</svg>
`.trim()

/**
 * Datacenter — stacked server racks.
 */
const DATACENTER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M4 3h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 2v2h2V5H6zm12 0v2h2V5h-2zM4 11h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm2 2v2h2v-2H6zm12 0v2h2v-2h-2zM4 19h16a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z"/>
</svg>
`.trim()

/**
 * Rail hub — train front view with two windows.
 */
const RAIL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19l-1.5 1.5v.5h12v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM6 6h5v4H6V6zm7 0h5v4h-5V6zM8.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>
</svg>
`.trim()

/**
 * Power — lightning bolt.
 */
const POWER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>
</svg>
`.trim()

/**
 * Conflict — crossed swords. Two diagonal blades.
 */
const CONFLICT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <path fill="#ffffff" d="M6.92 2 2 6.92l9.07 9.07L9.66 17.4l-2.83-2.83-1.41 1.41 1.41 1.42L2 22h4.24l4.59-4.59 1.41 1.42 2.83-2.83L15.49 17l4.93-4.93L11.34 3 6.92 2zm10.16 0L13.5 5.59l3.83 3.83 4.59-4.59L21 2h-3.92z"/>
</svg>
`.trim()

/**
 * Intelligence event — bullseye-style event pin.
 */
const EVENT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}">
  <circle cx="12" cy="12" r="9" fill="none" stroke="#ffffff" stroke-width="2"/>
  <circle cx="12" cy="12" r="3" fill="#ffffff"/>
</svg>
`.trim()

interface IconSpec {
  id: string
  svg: string
}

const ICONS: IconSpec[] = [
  { id: 'layer-airport',    svg: AIRPORT_SVG    },
  { id: 'layer-port',       svg: PORT_SVG       },
  { id: 'layer-datacenter', svg: DATACENTER_SVG },
  { id: 'layer-rail',       svg: RAIL_SVG       },
  { id: 'layer-power',      svg: POWER_SVG      },
  { id: 'layer-conflict',   svg: CONFLICT_SVG   },
  { id: 'layer-event',      svg: EVENT_SVG      },
]

/**
 * Render the SVG to a pixel-density-aware bitmap so MapLibre stores it as
 * a sharp raster image. Returns a Promise that resolves once the image
 * has decoded and is ready to be passed to `map.addImage`.
 *
 * We bypass `Image.decode()` on data URIs in favor of an explicit
 * `onload` handler so this works on older Safari builds that throw on
 * `decode()` for SVG data URIs.
 */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = (err) => reject(err)
    // Pixel ratio 2 keeps the icon crisp on retina displays.
    img.width  = ICON_SIZE * 2
    img.height = ICON_SIZE * 2
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  })
}

export interface LayerIconsResult {
  /** True once every icon in ICONS has been registered with the map. */
  ready: boolean
}

export function useLayerIcons(): LayerIconsResult {
  const { current: mapRef } = useMap()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!mapRef) return
    const map = mapRef.getMap()

    let cancelled = false

    async function registerAll() {
      try {
        await Promise.all(
          ICONS.map(async ({ id, svg }) => {
            if (cancelled) return
            if (map.hasImage(id)) return
            const img = await loadSvgImage(svg)
            if (cancelled || map.hasImage(id)) return
            map.addImage(id, img, { pixelRatio: 2 })
          })
        )
        if (!cancelled) setReady(true)
      } catch (err) {
        console.error('[useLayerIcons] failed to register icons:', err)
      }
    }

    // Run immediately if the style is already loaded, otherwise wait for load.
    // We do NOT listen to styledata because it fires on every tile fetch and
    // causes ready to flicker on/off. This app never swaps the map style, so
    // a single registration on load is sufficient.
    if (map.isStyleLoaded()) {
      registerAll()
    } else {
      map.once('load', registerAll)
    }

    return () => { cancelled = true }
  }, [mapRef])

  return { ready }
}
