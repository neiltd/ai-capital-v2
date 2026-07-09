'use client'

// LayerRail — persistent left control rail for world-map-v2 (replaces the
// old branded header + LayerToggle dropdown-that-covers-the-map +
// HeatmapSelector). Everything that changes what the map shows lives here,
// in priority order:
//
//   1. Omnisearch — one box finds BOTH countries (jump + inspect, reusing
//      the real Fuse.js index from SearchBar.tsx) and layers (toggle).
//   2. Lenses — one-click curated layer combos, derived from the registry's
//      real `themes: ThematicScope[]` field (layers/_core/types.ts documents
//      this as the intended "thematic view mode" — this is that mode).
//   3. Country shading — the real 12-indicator heatmap selector (exclusive).
//   4. Facility detail — global Key/All density control (round 3).
//   5. Layer groups — all 21+4 toggleable layers in 7 collapsible groups.
//
// All state is real: useMapStore (layerVisibility, heatmapIndicator,
// facilityDensity, selectCountry) — nothing here is sample data.

import { useMemo, useState } from 'react'
import Fuse from 'fuse.js'
import { useMapStore, type FacilityDensity } from '../store/useMapStore'
import { INDICATOR_GROUPS, INDICATOR_LABELS, INVERTED_INDICATORS, type IndicatorKey } from '../lib/geo/indicators'
import { LAYER_REGISTRY, LAYER_GROUPS, getLayersByGroup } from '../layers/_core/registry'
import type { LayerMeta, ThematicScope } from '../layers/_core/types'
import countryIndex from '../data/country-index.json'

interface CountryEntry { id: string; iso2: string; name: string; region: string }
const countries = countryIndex as CountryEntry[]
const countryFuse = new Fuse(countries, { keys: ['name', 'id'], threshold: 0.35 })

const TOGGLEABLE_LAYERS = LAYER_REGISTRY.filter(l => l.id !== 'heatmap')
const layerFuse = new Fuse(TOGGLEABLE_LAYERS, { keys: ['label'], threshold: 0.3 })

const GROUP_LABELS: Record<string, string> = {
  geopolitical: 'Geopolitical', economic: 'Economic', infrastructure: 'Infrastructure',
  utilities: 'Utilities', intelligence: 'Intelligence', environment: 'Environment', investment: 'Investment',
}

/* ------------------------------- lenses (from registry.themes) ------------------------------- */

interface Lens { id: string; label: string; hint: string; layers: string[] }

function layersByTheme(theme: ThematicScope): string[] {
  return LAYER_REGISTRY.filter(l => l.themes?.includes(theme)).map(l => l.id)
}

const LENSES: Lens[] = [
  {
    id: 'briefing',
    label: 'Morning brief',
    hint: "Default view — active conflicts, their zones, and today's intelligence events.",
    layers: ['conflicts', 'conflict-zones', 'intelligence-events'],
  },
  {
    id: 'portfolio',
    label: 'My portfolio',
    hint: 'Trade lanes that touch the real portfolio, the chokepoints they pass, and country signals.',
    layers: ['portfolio-trade', 'chokepoints', 'investment-signals', 'intelligence-events'],
  },
  {
    id: 'energy',
    label: 'Energy security',
    hint: 'Every layer tagged energy-security in the registry.',
    layers: layersByTheme('energy-security'),
  },
  {
    id: 'logistics',
    label: 'Logistics',
    hint: 'Every layer tagged logistics-fragility in the registry.',
    layers: layersByTheme('logistics-fragility'),
  },
  {
    id: 'digital',
    label: 'Digital sovereignty',
    hint: 'Every layer tagged digital-sovereignty in the registry.',
    layers: layersByTheme('digital-sovereignty'),
  },
]

const ALL_OFF: Record<string, boolean> = Object.fromEntries(TOGGLEABLE_LAYERS.map(l => [l.id, false]))

/* ------------------------------- omnisearch -------------------------------- */

function OmniSearch({ vis, onToggle }: { vis: Record<string, boolean>; onToggle: (id: string) => void }) {
  const selectCountry = useMapStore(s => s.selectCountry)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const results = useMemo(() => {
    const needle = q.trim()
    if (!needle) return { countries: [] as CountryEntry[], layers: [] as LayerMeta[] }
    return {
      countries: countryFuse.search(needle).slice(0, 4).map(r => r.item),
      layers: layerFuse.search(needle).slice(0, 4).map(r => r.item),
    }
  }, [q])
  const hasResults = results.countries.length > 0 || results.layers.length > 0

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-chip border border-hairline bg-surface-2 px-2.5 py-1.5 focus-within:border-accent">
        <svg className="h-3.5 w-3.5 shrink-0 text-ink-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Country or layer…"
          className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3"
        />
        {q && (
          <button onClick={() => setQ('')} className="text-[14px] leading-none text-ink-3 hover:text-ink-2" aria-label="Clear search">×</button>
        )}
      </div>

      {open && hasResults && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-chip border border-hairline bg-surface shadow-card-hover">
          {results.countries.length > 0 && (
            <div>
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Countries</div>
              {results.countries.map((c) => (
                <button
                  key={c.id}
                  onMouseDown={() => { selectCountry(c.id); setQ(''); setOpen(false) }}
                  className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="tnum w-7 shrink-0 text-[10px] font-semibold text-ink-3">{c.id}</span>
                  <span className="text-[12px] text-ink">{c.name}</span>
                  <span className="ml-auto text-[10px] text-ink-3">{c.region}</span>
                </button>
              ))}
            </div>
          )}
          {results.layers.length > 0 && (
            <div className={results.countries.length > 0 ? 'border-t border-hairline' : ''}>
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Layers</div>
              {results.layers.map((l) => (
                <button
                  key={l.id}
                  onMouseDown={() => onToggle(l.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="text-[12px] text-ink">{l.label}</span>
                  <span className={`ml-auto text-[10px] ${vis[l.id] ? 'text-accent' : 'text-ink-3'}`}>
                    {vis[l.id] ? 'on — click to hide' : 'off — click to show'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* --------------------------------- lenses ---------------------------------- */

function LensRow({ activeLens, onLens }: { activeLens: string | null; onLens: (id: string) => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Lenses</span>
        {activeLens === null && <span className="text-[10px] text-ink-3">custom</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {LENSES.map((l) => (
          <button
            key={l.id}
            onClick={() => onLens(l.id)}
            title={l.hint}
            className={`rounded-chip border px-2 py-1 text-[11px] font-medium transition-colors ${
              activeLens === l.id
                ? 'border-accent bg-accent text-white'
                : 'border-hairline text-ink-2 hover:border-grid hover:text-ink'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ----------------------------- country shading ----------------------------- */

function ShadingSelector({ heat, onHeat }: { heat: IndicatorKey; onHeat: (k: IndicatorKey) => void }) {
  const inverted = INVERTED_INDICATORS.has(heat)
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Country shading</span>
        {heat !== 'none' && (
          <button onClick={() => onHeat('none')} className="text-[10px] text-accent hover:underline">clear</button>
        )}
      </div>
      <select
        value={heat}
        onChange={(e) => onHeat(e.target.value as IndicatorKey)}
        className="mt-1.5 w-full cursor-pointer rounded-chip border border-hairline bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none hover:border-grid"
      >
        <option value="none">None</option>
        {INDICATOR_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.keys.map((k) => (
              <option key={k} value={k}>
                {INDICATOR_LABELS[k]}{INVERTED_INDICATORS.has(k) ? ' (high = worse)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {heat !== 'none' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-full max-w-[96px] rounded-full"
            style={{ background: 'linear-gradient(to right, #dc2626, #d97706, #16a34a)' }} />
          <span className="whitespace-nowrap text-[10px] text-ink-3">{inverted ? 'high = worse' : 'low → high'}</span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ facility detail ----------------------------- */

function DensityControl({ density, onDensity }: { density: FacilityDensity; onDensity: (d: FacilityDensity) => void }) {
  return (
    <div>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Facility detail</span>
      <div className="mt-1.5 grid grid-cols-2 overflow-hidden rounded-chip border border-hairline" role="radiogroup" aria-label="Facility detail">
        {(['key', 'all'] as const).map((d) => (
          <button
            key={d}
            role="radio"
            aria-checked={density === d}
            onClick={() => onDensity(d)}
            className={`px-2 py-1 text-[11px] font-medium capitalize transition-colors first:border-r first:border-hairline ${
              density === d ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {d === 'key' ? 'Key' : 'All'}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-3">
        {density === 'key'
          ? 'Curated importance tier per layer. Switch to All for the full registry.'
          : 'Full registry. Extra facilities render small at world view — zoom in to see them at full size.'}
      </p>
    </div>
  )
}

/* ------------------------------- layer groups ------------------------------ */

function LayerRow({ layer, on, onToggle }: { layer: LayerMeta; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      title={layer.description}
      className="group flex w-full items-center gap-2 rounded px-2 py-[5px] text-left transition-colors hover:bg-surface-2"
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none transition-colors ${
          on ? 'border-accent bg-accent text-white' : 'border-grid text-transparent group-hover:border-ink-3'
        }`}
        aria-hidden
      >
        ✓
      </span>
      <span className={`flex-1 truncate text-[12px] leading-[18px] ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>
        {layer.label}
      </span>
      {on && layer.legend && layer.legend.length > 0 && (
        <span className="flex shrink-0 items-center gap-[3px]">
          {layer.legend.slice(0, 4).map((e) => (
            <span key={e.label} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: e.color.startsWith('#') ? e.color : '#64748b' }} />
          ))}
        </span>
      )}
    </button>
  )
}

function LayerGroups({
  vis, onToggle, openGroups, onOpenGroup,
}: {
  vis: Record<string, boolean>
  onToggle: (id: string) => void
  openGroups: Record<string, boolean>
  onOpenGroup: (id: string) => void
}) {
  return (
    <div>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">All layers</span>
      <div className="mt-1 space-y-0.5">
        {LAYER_GROUPS.map((g) => {
          const items = getLayersByGroup(g).filter(l => l.id !== 'heatmap')
          if (items.length === 0) return null
          const activeCount = items.filter((l) => vis[l.id]).length
          const open = !!openGroups[g]
          return (
            <div key={g}>
              <button
                onClick={() => onOpenGroup(g)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-surface-2"
                aria-expanded={open}
              >
                <svg width="8" height="8" viewBox="0 0 8 8"
                  className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`}>
                  <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className={`text-[12px] font-medium ${activeCount > 0 ? 'text-ink' : 'text-ink-2'}`}>{GROUP_LABELS[g] ?? g}</span>
                <span className={`tnum ml-auto text-[10px] ${activeCount > 0 ? 'text-accent' : 'text-ink-3'}`}>
                  {activeCount > 0 ? `${activeCount}/${items.length}` : items.length}
                </span>
              </button>
              {open && (
                <div className="ml-2.5 border-l border-hairline pl-1.5">
                  {items.map((l) => (
                    <LayerRow key={l.id} layer={l} on={!!vis[l.id]} onToggle={() => onToggle(l.id)} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* --------------------------------- the rail -------------------------------- */

export function LayerRail() {
  const {
    layerVisibility, setLayerVisibility, toggleLayerById,
    heatmapIndicator, setHeatmapIndicator,
    facilityDensity, setFacilityDensity,
  } = useMapStore()

  const [activeLens, setActiveLens] = useState<string | null>('briefing')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ geopolitical: true, intelligence: true })

  const toggle = (id: string) => {
    toggleLayerById(id)
    setActiveLens(null)
  }

  const applyLens = (id: string) => {
    const lens = LENSES.find(l => l.id === id)
    if (!lens) return
    setLayerVisibility({ ...ALL_OFF, ...Object.fromEntries(lens.layers.map(x => [x, true])) })
    setActiveLens(id)
    const touched = new Set(TOGGLEABLE_LAYERS.filter(l => lens.layers.includes(l.id)).map(l => l.group))
    setOpenGroups(Object.fromEntries(Array.from(touched).map(g => [g, true])))
  }

  const reset = () => {
    const defaults: Record<string, boolean> = Object.fromEntries(TOGGLEABLE_LAYERS.map(l => [l.id, l.defaultEnabled]))
    setLayerVisibility(defaults)
    setHeatmapIndicator('none')
    setFacilityDensity('key')
    setActiveLens('briefing')
  }

  const activeCount = TOGGLEABLE_LAYERS.filter(l => layerVisibility[l.id]).length

  return (
    <div className="flex w-full shrink-0 flex-col border-b border-hairline bg-surface lg:h-full lg:w-[240px] lg:border-b-0 lg:border-r">
      <div className="space-y-4 overflow-y-auto p-3">
        <OmniSearch vis={layerVisibility} onToggle={toggle} />
        <LensRow activeLens={activeLens} onLens={applyLens} />
        <ShadingSelector heat={heatmapIndicator} onHeat={setHeatmapIndicator} />
        <DensityControl density={facilityDensity} onDensity={setFacilityDensity} />
        <LayerGroups vis={layerVisibility} onToggle={toggle} openGroups={openGroups} onOpenGroup={(g) => setOpenGroups(o => ({ ...o, [g]: !o[g] }))} />
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-hairline px-3 py-2">
        <span className="tnum text-[11px] text-ink-3">{activeCount}/{TOGGLEABLE_LAYERS.length} layers on</span>
        <button onClick={reset} className="text-[11px] text-accent hover:underline">reset</button>
      </div>
    </div>
  )
}
