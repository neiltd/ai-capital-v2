'use client'

// Left control rail for world-map-v2. One place for everything that changes
// what the map shows, in priority order:
//
//   1. Omnisearch — one box finds BOTH countries (jump + inspect) and layers
//      (toggle). Replaces the separate SearchBar + scanning 21 rows.
//   2. Lenses — one-click curated layer combos (the 90% path).
//   3. Country shading — the heatmap indicator selector (exclusive mode).
//   4. Layer groups — all 21 toggleable layers in 7 collapsible categories
//      (the 10% path, fully preserved).
//
// Production notes: country matching uses the existing Fuse.js index over
// country-index.json (~214 entries); the mockup does simple includes()
// matching over a 20-country sample.

import { useMemo, useState } from 'react'
import type { Density, Selection } from './map-view'
import {
  GROUPS, LAYERS, LENSES, layersByGroup,
  INDICATOR_GROUPS, INDICATOR_LABELS, INVERTED_INDICATORS, SEQ_RAMP,
  COUNTRY_INDEX, type IndicatorKey, type LayerDef,
} from './data'

/* ------------------------------- omnisearch -------------------------------- */

function OmniSearch({
  onCountry, onLayer, vis,
}: {
  onCountry: (id: string) => void
  onLayer: (id: string) => void
  vis: Record<string, boolean>
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return { countries: [], layers: [] }
    return {
      countries: COUNTRY_INDEX.filter((c) => c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)).slice(0, 4),
      layers: LAYERS.filter((l) => l.id !== 'heatmap' && l.label.toLowerCase().includes(needle)).slice(0, 4),
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
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-chip border border-hairline bg-surface shadow-card-hover">
          {results.countries.length > 0 && (
            <div>
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Countries</div>
              {results.countries.map((c) => (
                <button
                  key={c.id}
                  onMouseDown={() => { onCountry(c.id); setQ(''); setOpen(false) }}
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
                  onMouseDown={() => { onLayer(l.id) }}
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
          {/* gradient matches the dark-basemap fills: low = dark, high = bright */}
          <span
            className="inline-block h-1.5 w-full max-w-[96px] rounded-full"
            style={{ background: `linear-gradient(to right, ${SEQ_RAMP[SEQ_RAMP.length - 1]}, ${SEQ_RAMP[0]})` }}
          />
          <span className="whitespace-nowrap text-[10px] text-ink-3">{inverted ? 'high = worse' : 'low → high'}</span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ facility detail ----------------------------- */
// Round-3 addition: the reviewer collected full registries (hundreds of
// facilities per layer) and wants to SEE them, not just a curated handful.
// One global two-state control instead of per-layer switches — "how much
// detail" is one mental setting, and 10 more per-layer toggles would bury the
// rail. "All" works with zoom: extra facilities render small and quiet at
// world view (so the picture stays readable) and grow to full marks as you
// zoom into a region. Production adds grid-collision decluttering on top for
// the densest registries; the mechanic is the same.

function DensityControl({ density, onDensity }: { density: Density; onDensity: (d: Density) => void }) {
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
          : 'Full registry. Extra facilities render small at world view — zoom in to a region to see them at full size.'}
      </p>
    </div>
  )
}

/* ------------------------------- layer groups ------------------------------ */

function LayerRow({ layer, on, onToggle }: { layer: LayerDef; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      title={`${layer.description}\n\nSource: ${layer.source}`}
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
      {on && layer.legend && layer.legend[0].shape !== 'ramp' && (
        <span className="flex shrink-0 items-center gap-[3px]">
          {layer.legend.slice(0, 4).map((e) => (
            <span key={e.label} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: e.color }} />
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
        {GROUPS.map((g) => {
          // 'heatmap' lives under Country shading above, not in the toggle list —
          // mirrors the current app's LayerToggle exclusion.
          const items = layersByGroup(g.id).filter((l) => l.id !== 'heatmap')
          if (items.length === 0) return null
          const activeCount = items.filter((l) => vis[l.id]).length
          const open = !!openGroups[g.id]
          return (
            <div key={g.id}>
              <button
                onClick={() => onOpenGroup(g.id)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-surface-2"
                aria-expanded={open}
              >
                <svg
                  width="8" height="8" viewBox="0 0 8 8"
                  className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`}
                >
                  <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className={`text-[12px] font-medium ${activeCount > 0 ? 'text-ink' : 'text-ink-2'}`}>{g.label}</span>
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

export function LayerRail({
  vis, heat, activeLens, density, openGroups,
  onToggle, onHeat, onLens, onDensity, onOpenGroup, onReset, onSelect,
}: {
  vis: Record<string, boolean>
  heat: IndicatorKey
  activeLens: string | null
  density: Density
  openGroups: Record<string, boolean>
  onToggle: (id: string) => void
  onHeat: (k: IndicatorKey) => void
  onLens: (id: string) => void
  onDensity: (d: Density) => void
  onOpenGroup: (id: string) => void
  onReset: () => void
  onSelect: (s: Selection) => void
}) {
  const toggleable = LAYERS.filter((l) => l.id !== 'heatmap')
  const activeCount = toggleable.filter((l) => vis[l.id]).length

  return (
    <div className="flex w-full shrink-0 flex-col border-b border-hairline lg:w-[240px] lg:border-b-0 lg:border-r">
      <div className="space-y-4 overflow-y-auto p-3 lg:max-h-[calc(80vh-37px)]">
        <OmniSearch
          vis={vis}
          onCountry={(id) => onSelect({ kind: 'country', id })}
          onLayer={onToggle}
        />
        <LensRow activeLens={activeLens} onLens={onLens} />
        <ShadingSelector heat={heat} onHeat={onHeat} />
        <DensityControl density={density} onDensity={onDensity} />
        <LayerGroups vis={vis} onToggle={onToggle} openGroups={openGroups} onOpenGroup={onOpenGroup} />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-hairline px-3 py-2">
        <span className="tnum text-[11px] text-ink-3">{activeCount}/{toggleable.length} layers on</span>
        <button onClick={onReset} className="text-[11px] text-accent hover:underline">reset</button>
      </div>
    </div>
  )
}
