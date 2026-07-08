'use client'

// List ⇄ Map ⇄ Storylines tabs. The Map tab embeds the existing worldmap
// sub-app (@/worldmap/App) verbatim — port, don't rewrite, per the
// migration plan. It's a fully self-contained client component (own store/
// hooks/21-layer registry), so it's mounted only while its tab is active.

import { useState } from 'react'
import type { WorldEvent, WorldStoryline } from '@/types'
import { SectionCard, Label } from '@/components/next/ui'
import App from '@/worldmap/App'
import '@/worldmap/index.css'

const TABS = ['list', 'map', 'storylines'] as const
type Tab = (typeof TABS)[number]

const SEVERITY_COLOR = (s: number) => (s >= 5 ? '#d03b3b' : s >= 4 ? '#ec835a' : s >= 3 ? '#fab219' : '#898781')

const STATE_TONE: Record<string, string> = {
  active: 'text-status-warning',
  escalating: 'text-status-serious',
  stable: 'text-ink-3',
  dormant: 'text-ink-3',
}

export function WorldTabs({ events, storylines }: { events: WorldEvent[]; storylines: WorldStoryline[] }) {
  const [tab, setTab] = useState<Tab>('list')
  const storylineTitle = new Map(storylines.map((s) => [s.storylineId, s.title]))

  return (
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

      {tab === 'list' && (
        <SectionCard title={`Events (${events.length})`} className="mt-4">
          <ul className="divide-y divide-hairline">
            {events.map((e) => (
              <li key={e.eventId} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2.5">
                  <span
                    className="tnum mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: SEVERITY_COLOR(e.severity) }}
                    title={`Severity ${e.severity}/5`}
                  >
                    {e.severity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium leading-5 text-ink">
                      {e.title}
                      {e.storylineId && storylineTitle.has(e.storylineId) && (
                        <span className="ml-2 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">storyline</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-4 text-ink-3">{e.summary}</p>
                    <p className="mt-1 text-[11px] text-ink-3">
                      {e.countries.join(', ')}
                      {e.confidence != null && e.confidence < 0.6 && <span className="ml-2">~ single-source</span>}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {tab === 'map' && (
        <div className="mt-4 h-[80vh] overflow-hidden rounded-card border border-hairline">
          <App />
        </div>
      )}

      {tab === 'storylines' && (
        <SectionCard title={`Storylines (${storylines.length})`} className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {storylines.map((s) => (
              <div key={s.storylineId} className="rounded-card border border-hairline p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-semibold leading-5 text-ink">{s.title}</span>
                  <span className={`shrink-0 text-[11px] font-medium uppercase ${STATE_TONE[s.storylineState] ?? 'text-ink-3'}`}>
                    {s.storylineState}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-ink-3">{s.countries.join(', ')}</p>
                <dl className="mt-2 grid grid-cols-4 gap-2">
                  <div>
                    <Label>Events</Label>
                    <div className="tnum text-[13px] text-ink">{s.totalEvents}</div>
                  </div>
                  <div>
                    <Label>Sources</Label>
                    <div className="tnum text-[13px] text-ink">{s.totalSources}</div>
                  </div>
                  <div>
                    <Label>Days active</Label>
                    <div className="tnum text-[13px] text-ink">{s.daysActive}</div>
                  </div>
                  <div>
                    <Label>Max sev.</Label>
                    <div className="tnum text-[13px] text-ink">{s.maxSeverity}/5</div>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  )
}
