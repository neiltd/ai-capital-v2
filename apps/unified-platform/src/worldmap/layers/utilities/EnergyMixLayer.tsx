// EnergyMixLayer — one dot per country at its centroid, colored by dominant
// electricity-generation source. Registered in the registry but had no
// component until world-map-v2 (round 3 human decision).
//
// Data: data/validated/energy-mix.json (60 countries) — mix.{coal,gas,oil,
// nuclear,hydro,wind,solar,biomass,other} as % shares, plus renewableShare
// and fossilDependency roll-ups. NOTE: this is a different, richer file than
// lib/geo/indicators.ts's utilities.json merge (that file's electricityMix
// field does not exist in the current data/validated/utilities.json — a
// pre-existing data-pipeline drift, out of scope here; this layer uses its
// own energy-mix.json which does have real per-source data).
//
// Density: no per-row tier field exists (country-level dataset, not a
// facility registry) — always shown regardless of Key/All, per the
// documented fallback in density.ts / registry.ts.

import { useMemo } from 'react'
import { Source, Layer } from 'react-map-gl/maplibre'
import energyMixData from '../../data/validated/energy-mix.json'
import { getCountryCentroid } from '../../lib/geo/countryCentroids'
import type { LayerProps } from '../_core/types'

interface EnergyMixEntry {
  iso3: string
  name: string
  year: number
  totalGenerationTWh: number
  mix: {
    coal: number; gas: number; oil: number; nuclear: number
    hydro: number; wind: number; solar: number; biomass: number; other: number
  }
  renewableShare: number
  fossilDependency: number
  sourceUrl?: string
}

const rows = energyMixData as EnergyMixEntry[]

const SOURCE_COLOR: Record<string, string> = {
  coal:    '#78716c',
  gas:     '#f59e0b',
  oil:     '#92400e',
  nuclear: '#a78bfa',
  hydro:   '#0ea5e9',
  wind:    '#34d399',
  solar:   '#fbbf24',
  biomass: '#84cc16',
  other:   '#64748b',
}

const SOURCE_LABEL: Record<string, string> = {
  coal: 'Coal', gas: 'Gas', oil: 'Oil', nuclear: 'Nuclear',
  hydro: 'Hydro', wind: 'Wind', solar: 'Solar', biomass: 'Biomass', other: 'Other',
}

function dominantSource(mix: EnergyMixEntry['mix']): string {
  let best = 'other'
  let bestVal = -1
  for (const [k, v] of Object.entries(mix)) {
    if (v > bestVal) { bestVal = v; best = k }
  }
  return best
}

export default function EnergyMixLayer({ visible, labelLayerId }: LayerProps) {
  const geoJSON = useMemo(() => {
    const skipped: string[] = []
    const features = rows.map(r => {
      const centroid = getCountryCentroid(r.iso3)
      if (!centroid) { skipped.push(r.iso3); return null }
      const [lng, lat] = centroid
      const dom = dominantSource(r.mix)
      const breakdown = Object.entries(r.mix)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${SOURCE_LABEL[k] ?? k} ${v.toFixed(0)}%`)
        .join(', ')
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
        properties: {
          name:       r.name,
          subtitle:   `${SOURCE_LABEL[dom] ?? dom}-led · ${r.totalGenerationTWh.toLocaleString()} TWh/yr`,
          importance: '',
          note:       '',
          tag_Dominant:    SOURCE_LABEL[dom] ?? dom,
          tag_Mix:         breakdown,
          tag_Renewable:   `${r.renewableShare.toFixed(0)}%`,
          tag_FossilDep:   `${r.fossilDependency.toFixed(0)}%`,
          tag_Year:        String(r.year),
          color: SOURCE_COLOR[dom] ?? '#64748b',
        },
      }
    }).filter((f): f is NonNullable<typeof f> => f !== null)

    if (process.env.NODE_ENV !== 'production' && skipped.length > 0) {
      console.warn(`[EnergyMixLayer] ${skipped.length} countries had no centroid, skipped`, skipped)
    }
    return { type: 'FeatureCollection' as const, features }
  }, [])

  if (!visible) return null

  return (
    <Source id="energy-mix" type="geojson" data={geoJSON}>
      <Layer
        id="energy-mix-circles"
        type="circle"
        beforeId={labelLayerId}
        paint={{
          'circle-radius':         7,
          'circle-color':          ['get', 'color'] as unknown as string,
          'circle-opacity':        0.78,
          'circle-stroke-width':   1.5,
          'circle-stroke-color':   '#0A0F1E',
          'circle-stroke-opacity': 0.6,
        }}
      />
    </Source>
  )
}
