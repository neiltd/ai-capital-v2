'use client'

// world-map-v2 — Map tab content orchestrator.
//
// Layout (desktop):
//   ┌ layer rail 240px ┬──────────── map canvas ─────────────┬ inspector 300px ┐
//   │ omnisearch       │ full-bleed SVG world (drag to pan,  │ selection-      │
//   │ lenses           │ +/- zoom), landmass silhouettes,    │ synced detail   │
//   │ country shading  │ layer marks, legend strip at bottom │ (event/conflict │
//   │ 7 layer groups   │ heatmap chip top-right              │ /country/choke- │
//   │ n/21 on · reset  │                                     │ point/facility) │
//   └──────────────────┴─────────────────────────────────────┴─────────────────┘
// Stacks vertically on small screens (rail → canvas → inspector).
//
// State model mirrors the production store surface (useMapStore):
//   vis            layerVisibility        (21 toggleable layers)
//   heat           heatmapIndicator       (exclusive, 12 indicators + none)
//   sel            selectedCountry/selectedConflict/selected event → unified
//   lens           NEW — which curated combo is active (null = custom)
//   density        NEW (round 3) — 'key' | 'all' facility detail
//   inspectorWide  NEW (round 3) — inspector expanded over the canvas

import { useEffect, useState } from 'react'
import { DEFAULT_VISIBILITY, LAYERS, LENSES, type IndicatorKey } from './data'
import { LayerRail } from './layer-rail'
import { MapCanvas } from './map-canvas'
import { Inspector } from './inspector'

export type Selection =
  | { kind: 'event'; id: string }
  | { kind: 'conflict'; id: string }
  | { kind: 'country'; id: string }
  | { kind: 'chokepoint'; id: string }
  | { kind: 'facility'; layerId: string; name: string; k?: string }

export type Density = 'key' | 'all'

const ALL_OFF: Record<string, boolean> = Object.fromEntries(
  LAYERS.filter((l) => l.id !== 'heatmap').map((l) => [l.id, false]),
)

export function MapView() {
  const [vis, setVis] = useState<Record<string, boolean>>({ ...DEFAULT_VISIBILITY })
  const [heat, setHeat] = useState<IndicatorKey>('none')
  const [lens, setLens] = useState<string | null>('briefing') // default = Morning brief
  const [density, setDensity] = useState<Density>('key') // facility detail: key = curated tier
  const [sel, setSel] = useState<Selection | null>({ kind: 'event', id: 'ev-hormuz-01' }) // showcase selection
  const [inspectorWide, setInspectorWide] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    geopolitical: true, intelligence: true, // groups with default-on layers start expanded
  })

  // Escape clears the selection — preserved from the current App.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Closing the selection also collapses the expanded inspector, so the next
  // selection opens at the unobtrusive default width (Google-Maps-style: the
  // panel grows on demand, never starts grown).
  useEffect(() => { if (sel === null) setInspectorWide(false) }, [sel])

  // Manual toggle → lens becomes custom.
  const toggle = (id: string) => {
    setVis((v) => ({ ...v, [id]: !v[id] }))
    setLens(null)
  }

  // Lens → replace the visible set with the curated combo (re-click keeps it).
  const applyLens = (id: string) => {
    const l = LENSES.find((x) => x.id === id)
    if (!l) return
    setVis({ ...ALL_OFF, ...Object.fromEntries(l.layers.map((x) => [x, true])) })
    setLens(id)
    // Expand the groups the lens touched so the rail explains what just happened.
    const touched = new Set(LAYERS.filter((x) => l.layers.includes(x.id)).map((x) => x.group))
    setOpenGroups(Object.fromEntries(Array.from(touched).map((g) => [g, true])))
  }

  const reset = () => {
    setVis({ ...DEFAULT_VISIBILITY })
    setHeat('none')
    setLens('briefing')
    setDensity('key')
  }

  return (
    <div className="mt-4 overflow-hidden rounded-card border border-hairline bg-surface">
      {/* relative: the expanded inspector overlays the canvas from the right */}
      <div className="relative flex h-[80vh] min-h-[560px] flex-col lg:flex-row">
        <LayerRail
          vis={vis}
          heat={heat}
          activeLens={lens}
          density={density}
          openGroups={openGroups}
          onToggle={toggle}
          onHeat={(k) => setHeat(k)}
          onLens={applyLens}
          onDensity={setDensity}
          onOpenGroup={(g) => setOpenGroups((o) => ({ ...o, [g]: !o[g] }))}
          onReset={reset}
          onSelect={setSel}
        />
        <MapCanvas vis={vis} heat={heat} density={density} sel={sel} onSelect={setSel} />
        <Inspector
          sel={sel}
          wide={inspectorWide}
          onToggleWide={() => setInspectorWide((w) => !w)}
          onClose={() => setSel(null)}
        />
      </div>
    </div>
  )
}
