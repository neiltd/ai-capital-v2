'use client'

// Inspector — right-hand detail rail for world-map-v2. Replaces the old
// floating ConflictCard (bottom-left, partially clipped by the h-[80vh]
// wrapper) and cursor-only infrastructure tooltips with ONE consistent
// panel for every selection kind: event / conflict / country / chokepoint /
// facility. Nothing floats over the map.
//
// All content is real data from useMapStore / useIntelligenceStore — no
// sample payloads. The country case renders the production CountryPanel
// (7 real tabs) verbatim; this file only supplies the expand/collapse shell
// around it, per the spec ("don't reduce production's real 7-tab CountryPanel
// content to a simplified version — port the mockup's *shell*, keep serving
// the real CountryPanel underneath").
//
// Expand/collapse (Google-Maps place-panel pattern, round 3): docked 300px
// rail by default; every panel header's » control grows it to min(560px,65%)
// as an overlay over the canvas from the right. Esc-to-close is wired in
// MapShell (preserves the App.tsx behavior).

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useMapStore } from '../store/useMapStore'
import { useIntelligenceStore } from '../store/useIntelligenceStore'
import { getLayer } from '../layers/_core/registry'
import RealCountryPanel from '../components/Panel/CountryPanel'

const WideCtx = createContext<{ wide: boolean; onToggleWide: () => void }>({ wide: false, onToggleWide: () => {} })

/* -------------------------------- primitives ------------------------------- */

function RowLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{children}</p>
}

function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  )
}

function Header({ kind, title, sub, onClose }: { kind: string; title: string; sub?: string; onClose: () => void }) {
  const { wide, onToggleWide } = useContext(WideCtx)
  return (
    <div className="border-b border-hairline px-3.5 pb-3 pt-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{kind}</span>
        <div className="-mr-1 -mt-0.5 flex items-center">
          <button
            onClick={onToggleWide}
            className="hidden h-6 w-6 items-center justify-center rounded text-[13px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink lg:flex"
            aria-label={wide ? 'Collapse panel' : 'Expand panel'}
            title={wide ? 'Collapse to the side rail' : 'Expand over the map'}
          >
            {wide ? '»' : '«'}
          </button>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-[14px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Close inspector"
          >
            ×
          </button>
        </div>
      </div>
      <h3 className="mt-1 text-[14px] font-semibold leading-snug text-ink">{title}</h3>
      {sub && <p className="mt-0.5 text-[11px] text-ink-3">{sub}</p>}
    </div>
  )
}

/* --------------------------------- panels ---------------------------------- */

const INTENSITY_COLOR: Record<string, string> = {
  critical: '#d03b3b', high: '#ec835a', medium: '#fab219', low: '#84cc16',
}

function ConflictPanel({ onClose }: { onClose: () => void }) {
  const c = useMapStore(s => s.selectedConflict)
  if (!c) return null
  return (
    <>
      <Header kind="Conflict" title={c.name} sub={`${c.type.replace(/_/g, ' ')} · ${c.region} · since ${c.startYear}`} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Chip color={INTENSITY_COLOR[c.intensity] ?? '#ec835a'}>{c.intensity}</Chip>
          <span className="text-[11px] font-medium capitalize text-ink-2">{c.status.replace(/-/g, ' ')}</span>
        </div>
        <div>
          <RowLabel>Parties</RowLabel>
          {c.parties.map((p) => (
            <div key={p.countryName} className="flex items-baseline gap-1.5 text-[12px] leading-5">
              <span className="font-medium text-ink">{p.countryName}</span>
              <span className="text-ink-3">— {p.role}</span>
            </div>
          ))}
        </div>
        <div>
          <RowLabel>Situation now</RowLabel>
          <p className="text-[12px] leading-relaxed text-ink-2">{c.currentStatus}</p>
        </div>
        <div>
          <RowLabel>Casualties</RowLabel>
          <div className="rounded-chip border px-2.5 py-1.5" style={{ borderColor: 'var(--loss)' }}>
            <p className="text-[12px] leading-relaxed text-ink-2">{c.casualties}</p>
          </div>
        </div>
        <div>
          <RowLabel>International involvement</RowLabel>
          <p className="text-[12px] leading-relaxed text-ink-3">{c.internationalInvolvement}</p>
        </div>
        <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-3">{c.summary}</p>
      </div>
    </>
  )
}

const CONF_COLOR: Record<string, string> = { high: '#4ade80', medium: '#fab219', low: '#f87171' }
const COORD_QUALITY_LABEL: Record<string, string> = {
  source_exact: 'GPS / field verified', source_approx: 'Geocoded estimate', country_centroid: 'Country centroid (approximate)',
}

function EventPanel({ onClose }: { onClose: () => void }) {
  const id = useMapStore(s => s.selectedEventId)
  const events = useIntelligenceStore(s => s.events)
  const { wide } = useContext(WideCtx)
  const [openAnalysis, setOpenAnalysis] = useState(true)
  const e = events.find(x => x.id === id)
  if (!e) return null
  const analysis = e.analysis

  return (
    <>
      <Header kind="Intelligence event" title={e.headline} sub={e.iso3.join(', ')} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">{e.eventType.replace(/[._]/g, ' › ')}</span>
          <span className="tnum text-[11px] text-ink-3">
            {(e.confidenceScore * 100).toFixed(0)}% conf · tier {e.tier}
            {e.confidenceScore < 0.6 && ' · ~single-source'}
          </span>
        </div>
        {e.coordinateQuality && (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: e.coordinateQuality === 'source_exact' ? '#4ade80' : e.coordinateQuality === 'source_approx' ? '#f59e0b' : '#64748b' }}
            />
            <p className="text-[10px] text-ink-3">{COORD_QUALITY_LABEL[e.coordinateQuality] ?? e.coordinateQuality}</p>
          </div>
        )}
        {e.summary && <p className="text-[12px] leading-relaxed text-ink-2">{e.summary}</p>}
        {e.fatalities != null && e.fatalities > 0 && (
          <p className="text-[11px] font-medium" style={{ color: 'var(--loss)' }}>{e.fatalities} fatalities</p>
        )}
        <p className="text-[11px] text-ink-3">{e.eventDate}{e.sourceUrl && (
          <> · <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">source</a></>
        )}</p>

        {analysis && (
          <div className="border-t border-hairline pt-3">
            <button
              onClick={() => setOpenAnalysis((o) => !o)}
              className="flex w-full items-center gap-1.5 text-left"
              aria-expanded={openAnalysis}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" className={`text-ink-3 transition-transform ${openAnalysis ? 'rotate-90' : ''}`}>
                <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Intelligence analysis</span>
              <span className="tnum ml-auto text-[10px] text-ink-3">{(analysis.confidence.score * 100).toFixed(0)}%</span>
            </button>
            {openAnalysis && (
              <div className="mt-2.5 space-y-3">
                <div>
                  <RowLabel>What happened</RowLabel>
                  <p className="text-[12px] leading-relaxed text-ink-2">{analysis.what_happened}</p>
                </div>
                <div>
                  <RowLabel>Historical context</RowLabel>
                  <p className="text-[12px] leading-relaxed text-ink-2">{analysis.historical_context}</p>
                </div>
                <div>
                  <RowLabel>Political analysis</RowLabel>
                  <p className="text-[12px] leading-relaxed text-ink-2">{analysis.political_analysis}</p>
                </div>
                {analysis.actor_goals.length > 0 && (
                  <div>
                    <RowLabel>Actor goals</RowLabel>
                    <div className={wide ? 'grid grid-cols-2 gap-1.5' : 'space-y-1.5'}>
                      {analysis.actor_goals.map((a) => (
                        <div key={a.name} className="rounded-chip bg-surface-2 px-2.5 py-2">
                          <p className="text-[11px] font-semibold text-ink">{a.name}</p>
                          <p className="mt-0.5 text-[11px] leading-snug text-ink-3"><span className="text-ink-2">Stated:</span> {a.stated_goal}</p>
                          <p className="text-[11px] leading-snug text-ink-3"><span className="text-ink-2">Real:</span> {a.real_goal}</p>
                          <p className="text-[11px] leading-snug text-ink-3"><span style={{ color: 'var(--loss)' }}>Red lines:</span> {a.red_lines}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {analysis.bloc_perspectives.length > 0 && (
                  <div>
                    <RowLabel>Bloc perspectives</RowLabel>
                    <div className={wide ? 'grid grid-cols-2 gap-1.5' : 'space-y-1.5'}>
                      {analysis.bloc_perspectives.map((b) => (
                        <div key={b.bloc} className="rounded-chip bg-surface-2 px-2.5 py-2">
                          <p className="text-[11px] font-semibold text-ink">{b.bloc}</p>
                          <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{b.how_they_see_it}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {analysis.what_to_watch.length > 0 && (
                  <div>
                    <RowLabel>What to watch</RowLabel>
                    <ol className="list-decimal space-y-0.5 pl-4">
                      {analysis.what_to_watch.map((w) => (
                        <li key={w} className="text-[12px] leading-snug text-ink-2">{w}</li>
                      ))}
                    </ol>
                  </div>
                )}
                <p className="border-t border-hairline pt-2 text-[10px] leading-snug text-ink-3">
                  Confidence {(analysis.confidence.score * 100).toFixed(0)}% — {analysis.confidence.reasoning}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

const RISK_COLOR: Record<string, string> = { low: '#0ca30c', medium: '#fab219', high: '#d03b3b' }

function ChokepointPanel({ onClose }: { onClose: () => void }) {
  const c = useMapStore(s => s.selectedChokepoint)
  if (!c) return null
  return (
    <>
      <Header kind="Strategic chokepoint" title={c.name} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        {c.description && <p className="text-[12px] leading-relaxed text-ink-2">{c.description}</p>}
        {c.lanesThrough.length > 0 && (
          <div>
            <RowLabel>Lanes through</RowLabel>
            {c.lanesThrough.map((l) => (
              <p key={l} className="text-[12px] leading-5 text-ink-2">{l}</p>
            ))}
          </div>
        )}
        <div>
          <RowLabel>Exposed portfolio tickers</RowLabel>
          {c.exposedTickers.length > 0 ? (
            <div className="grid grid-cols-3 gap-1.5">
              {c.exposedTickers.map((t) => (
                <span key={t} className="tnum rounded-chip bg-surface-2 px-1.5 py-1 text-center text-[11px] font-semibold text-ink">{t}</span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-ink-3">No portfolio tickers currently mapped to this chokepoint.</p>
          )}
        </div>
      </div>
    </>
  )
}

function FacilityPanel({ onClose }: { onClose: () => void }) {
  const f = useMapStore(s => s.selectedFacility)
  if (!f) return null
  const layer = getLayer(f.layerId)
  return (
    <>
      <Header kind={layer?.label ?? 'Facility'} title={f.name} sub={f.subtitle} onClose={onClose} />
      <div className="space-y-3 px-3.5 py-3">
        {f.importance && (
          <Chip color="#3b82f6">{f.importance}</Chip>
        )}
        {f.tags.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-hairline pt-2.5">
            {f.tags.map(t => (
              <div key={t.label} className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] text-ink-3">{t.label}</span>
                <span className="text-[11px] text-ink-2 text-right">{t.value}</span>
              </div>
            ))}
          </div>
        )}
        {f.note && <p className="border-t border-hairline pt-2.5 text-[12px] leading-relaxed text-ink-3">{f.note}</p>}
        {layer && <p className="border-t border-hairline pt-2.5 text-[11px] leading-relaxed text-ink-3">{layer.description}</p>}
      </div>
    </>
  )
}

function CountryPanelShell() {
  const { wide, onToggleWide } = useContext(WideCtx)
  return (
    <div className="relative flex h-full flex-col">
      <button
        onClick={onToggleWide}
        className="absolute left-2 top-2 z-10 hidden h-6 w-6 items-center justify-center rounded text-[13px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink lg:flex"
        aria-label={wide ? 'Collapse panel' : 'Expand panel'}
        title={wide ? 'Collapse to the side rail' : 'Expand over the map'}
      >
        {wide ? '»' : '«'}
      </button>
      {/* Real production CountryPanel — 7 tabs, real data/countries/{ISO3}.json,
          real ally/rival relationships, real infrastructure index. Unmodified. */}
      <RealCountryPanel />
    </div>
  )
}

function IdlePanel() {
  return (
    <div className="flex h-full flex-col px-3.5 py-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Inspector</span>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
        Click anything on the map — an event, conflict, chokepoint, facility, or a country from
        search — and its full detail opens here without covering the map.
      </p>
      <div className="mt-4 space-y-1.5 border-t border-hairline pt-3 text-[11px] leading-5 text-ink-3">
        <p><span className="text-ink-2">Mark grammar:</span></p>
        <p>event size = severity · hollow/dim = approximate (country-centroid) coordinates · halo = escalation/critical tier</p>
        <p>diamonds = chokepoints and signals · lines = routes, lanes, cables · fills = country shading</p>
      </div>
    </div>
  )
}

/* -------------------------------- inspector -------------------------------- */

type SelectionKind = 'event' | 'conflict' | 'country' | 'chokepoint' | 'facility' | null

export function Inspector() {
  const {
    selectedCountryId, selectedConflict, selectedEventId, selectedChokepoint, selectedFacility,
    clearSelection, clearConflict, clearEvent, clearChokepoint, clearFacility,
  } = useMapStore()

  const kind: SelectionKind =
    selectedEventId ? 'event' :
    selectedConflict ? 'conflict' :
    selectedCountryId ? 'country' :
    selectedChokepoint ? 'chokepoint' :
    selectedFacility ? 'facility' : null

  const [wide, setWide] = useState(false)
  // Closing the selection auto-collapses so the next selection opens
  // unobtrusive (Google-Maps-style: the panel grows on demand, never
  // starts grown).
  useEffect(() => { if (kind === null) setWide(false) }, [kind])

  function onClose() {
    if (kind === 'event') clearEvent()
    else if (kind === 'conflict') clearConflict()
    else if (kind === 'country') clearSelection()
    else if (kind === 'chokepoint') clearChokepoint()
    else if (kind === 'facility') clearFacility()
  }

  const expanded = wide && kind !== null

  return (
    <WideCtx.Provider value={{ wide: expanded, onToggleWide: () => setWide(w => !w) }}>
      <aside
        className={`flex w-full flex-col border-t border-hairline bg-surface lg:border-l lg:border-t-0 ${
          expanded
            ? 'lg:absolute lg:inset-y-0 lg:right-0 lg:z-30 lg:w-[min(560px,65%)] lg:shadow-card-hover'
            : 'shrink-0 lg:h-full lg:w-[300px]'
        }`}
      >
        {kind === null ? (
          <IdlePanel />
        ) : kind === 'event' ? (
          <EventPanel onClose={onClose} />
        ) : kind === 'conflict' ? (
          <ConflictPanel onClose={onClose} />
        ) : kind === 'country' ? (
          <CountryPanelShell />
        ) : kind === 'chokepoint' ? (
          <ChokepointPanel onClose={onClose} />
        ) : (
          <FacilityPanel onClose={onClose} />
        )}
      </aside>
    </WideCtx.Provider>
  )
}
