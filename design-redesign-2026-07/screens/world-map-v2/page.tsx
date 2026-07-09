// /world — Map tab redesign (world-map-v2).
//
// Scope: the MAP TAB ONLY. The page shell (header, event/source counts, tab
// strip) and the List/Storylines tabs are the shipped /world implementation
// and are reproduced here unchanged so the redesigned Map tab can be judged
// as a sibling of them, not in isolation.
//
// The Map tab replaces the verbatim-embedded worldmap sub-app (src/worldmap/
// App.tsx) with a three-panel view built in the app's own design language:
// layer rail (search + lenses + shading + grouped toggles) · full-bleed map
// canvas · selection-synced inspector. See README.md for rationale and the
// capability-preservation audit.

'use client'

import { useState } from 'react'
import { MapView } from './map-view'

const TABS = ['list', 'map', 'storylines'] as const
type Tab = (typeof TABS)[number]

export default function WorldMapV2Page() {
  const [tab, setTab] = useState<Tab>('map') // map active — the tab under review

  return (
    <main className="mx-auto max-w-[1520px] space-y-4 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">World intelligence</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            12 events · 7 sources · 3 excluded by review — the feed that today&apos;s regime call
            and briefing were built from.
          </p>
        </div>
        <span className="tnum text-[11px] text-ink-3">as of 2h ago</span>
      </header>

      {/* Tab strip — identical to the shipped world-tabs.tsx */}
      <div>
        <div className="flex items-center gap-1 border-b border-hairline">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-[13px] font-medium capitalize transition-colors ${
                tab === t ? 'border-b-2 border-accent text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'map' && <MapView />}

        {tab !== 'map' && (
          <div className="mt-4 rounded-card border border-dashed border-hairline px-6 py-10 text-center">
            <p className="text-[13px] font-medium text-ink-2">
              {tab === 'list' ? 'List' : 'Storylines'} tab — out of scope
            </p>
            <p className="mx-auto mt-1 max-w-[420px] text-[12px] leading-5 text-ink-3">
              This tab keeps the shipped implementation unchanged; only the Map tab is being
              redesigned. Switch back to Map to review.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
