'use client'

// List ⇄ Map ⇄ Storylines — three lenses on one event set. Selection (an
// event) persists across tabs; the inspector rail is shared. Client component
// because tab + selection + filter state live here.

import { useMemo, useState } from 'react'
import type { WorldEventVM, StorylineVM } from './data'
import { Label } from '../_shared/ui'
import { MapTab } from './map-tab'

type Tab = 'list' | 'map' | 'storylines'

export function WorldTabs({ events, storylines }: { events: WorldEventVM[]; storylines: StorylineVM[] }) {
  const [tab, setTab] = useState<Tab>('list')
  const [selectedId, setSelectedId] = useState<string | null>(events[0]?.eventId ?? null)
  const [showAll, setShowAll] = useState(false)
  const [consumedOnly, setConsumedOnly] = useState(false)

  // Default filter = the briefing's own bar (sev ≥ 3 OR mktRel ≥ 0.4).
  const visible = useMemo(
    () =>
      events
        .filter((e) => showAll || e.severity >= 3 || e.marketRelevance >= 0.4)
        .filter((e) => !consumedOnly || e.fedRegime || e.briefingRank !== null),
    [events, showAll, consumedOnly],
  )
  const selected = events.find((e) => e.eventId === selectedId) ?? null

  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-12 xl:col-span-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(['list', 'map', 'storylines'] as Tab[]).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`rounded-chip px-3 py-1 text-[13px] capitalize ${
                tab === tb ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {tb}
            </button>
          ))}
          {tab !== 'storylines' && (
            <div className="ml-auto flex items-center gap-3 text-[12px] text-ink-2">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={consumedOnly} onChange={(e) => setConsumedOnly(e.target.checked)} />
                consumed only
              </label>
              <label className="flex items-center gap-1.5" title="Default filter is the briefing’s own bar: severity ≥ 3 OR market relevance ≥ 0.4">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                show all ({events.length})
              </label>
            </div>
          )}
        </div>

        {tab === 'list' && (
          <ul className="divide-y divide-hairline rounded-card border border-hairline bg-surface px-4">
            {visible.map((e) => (
              <EventRow key={e.eventId} e={e} selected={e.eventId === selectedId} onClick={() => setSelectedId(e.eventId)} />
            ))}
          </ul>
        )}
        {tab === 'map' && <MapTab events={visible} selectedId={selectedId} onSelect={setSelectedId} />}
        {tab === 'storylines' && (
          <div className="space-y-4">
            {storylines.map((s) => (
              <StorylineThread key={s.storylineId} s={s} onSelectEvent={setSelectedId} events={events} />
            ))}
          </div>
        )}
      </div>

      <div className="col-span-12 xl:col-span-4">
        {selected ? <Inspector e={selected} /> : (
          <p className="text-[13px] text-ink-3">Select an event.</p>
        )}
      </div>
    </div>
  )
}

/* -------------------------------- list row -------------------------------- */

function SeverityPip({ severity }: { severity: number }) {
  const color = severity >= 5 ? '#d03b3b' : severity >= 4 ? '#ec835a' : severity >= 3 ? '#fab219' : '#898781'
  return (
    <span
      className="tnum mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: color }}
      title={`Severity ${severity}/5`}
    >
      {severity}
    </span>
  )
}

/** 5-dot relevance meter — filled dots = quintile. */
function DotMeter({ v, label }: { v: number; label: string }) {
  const filled = Math.round(v * 5)
  return (
    <span className="inline-flex items-center gap-[2px]" title={`${label}: ${(v * 100).toFixed(0)}%`}>
      {[0, 1, 2, 3, 4].map((idx) => (
        <span key={idx} className={`h-1.5 w-1.5 rounded-full ${idx < filled ? 'bg-accent' : 'bg-surface-2'}`} />
      ))}
    </span>
  )
}

/** Consumption chips — the whole point of the screen. */
function ConsumedBy({ e, compact }: { e: WorldEventVM; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {e.fedRegime && (
        <span className="rounded-chip border border-accent px-1.5 py-0.5 text-[10px] font-medium text-accent" title="Entered today’s regime-analysis World Intelligence context block">
          regime
        </span>
      )}
      {e.briefingRank !== null && (
        <span className="rounded-chip bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white" title={`#${e.briefingRank} in today’s briefing top-5`}>
          briefing #{e.briefingRank}
        </span>
      )}
      {!e.fedRegime && e.briefingRank === null && !compact && (
        <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[10px] text-ink-3" title="Below both consumption bars — visible here, consumed by nothing">
          not consumed
        </span>
      )}
    </span>
  )
}

function EventRow({ e, selected, onClick }: { e: WorldEventVM; selected: boolean; onClick: () => void }) {
  const lowConf = e.confidence < 0.6
  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-start gap-2.5 py-2.5 text-left ${selected ? 'bg-surface-2 -mx-4 px-4' : ''}`}
      >
        <SeverityPip severity={e.severity} />
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-medium leading-5 ${lowConf ? 'text-ink-3' : 'text-ink'}`}>
            {lowConf && <span title={`Single-source / low confidence (${(e.confidence * 100).toFixed(0)}%)`}>~ </span>}
            {e.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            {e.countries.map((c) => (
              <span key={c} className="rounded-chip bg-surface-2 px-1 py-px">{c}</span>
            ))}
            <span className="tnum">{e.latestSeenAt.slice(5, 16).replace('T', ' ')}</span>
            <DotMeter v={e.marketRelevance} label="market relevance" />
            {e.affectedTickers.map((tk) => (
              <span key={tk.ticker} className={`tnum ${tk.held ? 'text-accent' : ''}`}>{tk.ticker}</span>
            ))}
          </div>
        </div>
        <ConsumedBy e={e} />
      </button>
    </li>
  )
}

/* ---------------------------------- map ----------------------------------- */
// The Map tab now lives in map-tab.tsx: full 21-layer registry (grouped picker,
// per-layer legends, provenance glyphs) with the event marks on top, wired to
// the same shared selection/inspector. Layer metadata + verified data-source
// provenance: map-layers.ts.

/* ------------------------------- storylines -------------------------------- */

const STATE_STYLE: Record<string, string> = {
  active: 'border-status-warning text-status-warning',
  escalating: 'border-status-serious text-status-serious',
  stable: 'border-hairline text-ink-3',
  dormant: 'border-hairline text-ink-3',
}

function StorylineThread({ s, events, onSelectEvent }: { s: StorylineVM; events: WorldEventVM[]; onSelectEvent: (id: string) => void }) {
  return (
    <section className="rounded-card border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{s.title}</h3>
        <span className={`rounded-chip border px-1.5 py-0.5 text-[11px] font-medium uppercase ${STATE_STYLE[s.state]}`}>
          {s.state}
        </span>
        <span className="tnum ml-auto text-[11px] text-ink-3">
          {s.totalEvents} events · {s.totalSources} sources · {s.daysActive}d · esc {(s.avgEscalation * 100).toFixed(0)}%
        </span>
      </div>

      <ol className="mt-3 border-l border-hairline pl-4">
        {s.nodes.map((n) => {
          const ev = events.find((e) => e.storylineId === s.storylineId && e.title.startsWith(n.title.slice(0, 20)))
          return (
            <li key={n.date + n.title} className="relative pb-1">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-hairline bg-surface-2" />
              <div className="flex items-baseline gap-2">
                <span className="tnum text-[12px] text-ink-3">{n.date}</span>
                <button
                  onClick={ev ? () => onSelectEvent(ev.eventId) : undefined}
                  className={`text-left text-[13px] leading-5 ${ev ? 'text-ink hover:text-accent' : 'text-ink-2'}`}
                >
                  {n.title}
                </button>
              </div>
              {n.linkToNext && (
                <div className="my-1 text-[11px] italic leading-4 text-ink-3">↓ {n.linkToNext}</div>
              )}
            </li>
          )
        })}
      </ol>

      <footer className="mt-2 border-t border-hairline pt-2">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <Label>Portfolio relevance</Label>
          {s.tickers.map((tk) => (
            <a key={tk.ticker} href={`/portfolio?ticker=${tk.ticker}`} className={`tnum font-medium ${tk.held ? 'text-accent' : 'text-ink-2'}`}>
              {tk.ticker}{tk.held ? ' · held' : ''}
            </a>
          ))}
        </div>
        {s.briefingCitation && (
          <blockquote className="mt-1 border-l-2 border-hairline pl-2 text-[12px] italic leading-4 text-ink-3">
            “{s.briefingCitation}” <span className="not-italic">— briefing 2026-07-06</span>
          </blockquote>
        )}
      </footer>
    </section>
  )
}

/* -------------------------------- inspector -------------------------------- */

function Meter({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-[0.08em] text-ink-3">{label}</span>
      <div className="h-[5px] flex-1 rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${v * 100}%` }} />
      </div>
      <span className="tnum w-9 shrink-0 text-right text-[12px] text-ink-2">{(v * 100).toFixed(0)}%</span>
    </div>
  )
}

function Inspector({ e }: { e: WorldEventVM }) {
  return (
    <aside className="rounded-card border border-hairline bg-surface p-4 xl:sticky xl:top-4">
      <div className="flex items-start gap-2">
        <SeverityPip severity={e.severity} />
        <h3 className="text-[15px] font-semibold leading-[22px] text-ink">{e.title}</h3>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <ConsumedBy e={e} />
        <span className="tnum text-[11px] text-ink-3">{e.uniqueSourceCount} sources · {e.eventType} · {e.eventState}</span>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-ink-2">{e.summary}</p>

      <div className="mt-3 space-y-1.5">
        <Meter label="confidence" v={e.confidence} />
        <Meter label="mkt relevance" v={e.marketRelevance} />
        <Meter label="escalation" v={e.escalationPotential} />
      </div>

      {e.causedByRationales.length > 0 && (
        <div className="mt-3">
          <Label>Why now — causal chain</Label>
          <ul className="mt-1 space-y-1">
            {e.causedByRationales.map((r) => (
              <li key={r} className="text-[12px] leading-4 text-ink-2">← {r}</li>
            ))}
          </ul>
        </div>
      )}
      {e.expectedConsequences.length > 0 && (
        <div className="mt-3">
          <Label>Expected consequences</Label>
          <ul className="mt-1 space-y-1">
            {e.expectedConsequences.map((c) => (
              <li key={c} className="text-[12px] leading-4 text-ink-2">→ {c}</li>
            ))}
          </ul>
        </div>
      )}
      {e.counterfactual && (
        <div className="mt-3">
          <Label>Counterfactual</Label>
          <p className="mt-1 text-[12px] italic leading-4 text-ink-3">{e.counterfactual}</p>
        </div>
      )}

      {(e.affectedChokepoints.length > 0 || e.affectedTickers.length > 0) && (
        <div className="mt-3 border-t border-hairline pt-2.5">
          <Label>Trade-graph exposure</Label>
          {e.affectedChokepoints.length > 0 && (
            <div className="mt-1 text-[12px] text-ink-2">
              chokepoints: {e.affectedChokepoints.join(', ')}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-1.5">
            {e.affectedTickers.map((tk) => (
              <a
                key={tk.ticker}
                href={`/portfolio?ticker=${tk.ticker}`}
                className={`tnum rounded-chip border px-1.5 py-0.5 text-[11px] ${tk.held ? 'border-accent text-accent' : 'border-hairline text-ink-2'}`}
              >
                {tk.ticker}{tk.held ? ' · held' : ''}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-hairline pt-2.5">
        <Label>Where this event went</Label>
        <ul className="mt-1 space-y-1 text-[12px] leading-4">
          <li className={e.fedRegime ? 'text-ink-2' : 'text-ink-3'}>
            {e.fedRegime ? '✓' : '✗'} regime analysis context block{' '}
            {e.fedRegime && <a href="/today" className="text-accent">→ today’s regime call</a>}
          </li>
          <li className={e.briefingRank !== null ? 'text-ink-2' : 'text-ink-3'}>
            {e.briefingRank !== null ? `✓ briefing top-5 (rank ${e.briefingRank})` : '✗ briefing top-5'}
            {e.briefingRank !== null && <a href="/today" className="ml-1 text-accent">→ briefing</a>}
          </li>
        </ul>
        {e.briefingQuote && (
          <blockquote className="mt-1.5 border-l-2 border-hairline pl-2 text-[12px] italic leading-4 text-ink-3">
            “{e.briefingQuote}”
          </blockquote>
        )}
      </div>
    </aside>
  )
}
