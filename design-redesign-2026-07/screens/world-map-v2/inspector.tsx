'use client'

// Selection-synced inspector rail for world-map-v2 — replaces the current
// app's floating cards (ConflictCard bottom-left, CountryPanel, event popups)
// with ONE consistent right rail that never covers the map.
//
// Preserves every detail surface the current panels expose:
//   - Conflict: intensity/status, parties, situation, casualties,
//     international involvement, summary        (ConflictCard contract)
//   - Event: severity/type/confidence/sources + collapsible intelligence
//     analysis with actor goals + what-to-watch (AnalysisCard contract)
//   - Country: 7 indicator score bars w/ trend + confidence + note,
//     investment strengths/risks/sectors        (CountryPanel + ScoreBar)
//   - Chokepoint: risk, lanes through, exposed portfolio tickers
//     (portfolio-trade click contract)
//   - Facility: name/class/layer context for any infrastructure mark.
// Idle state teaches the map instead of showing nothing.
//
// Round 3 — expandable (the Google-Maps side-panel pattern the reviewer
// asked for): the default is still a slim 300px docked rail so simple
// selections (chokepoint, facility) never crowd the map, but every panel
// header has an expand control that grows the inspector to min(560px, 65%)
// as an OVERLAY sliding over the canvas from the right — the map keeps its
// full width underneath, exactly like Google Maps' place panel. Content
// reflows to use the width (two-column actor goals / country indicators).
// Collapse returns to the docked rail; closing the selection auto-collapses.

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Selection } from './map-view'
import {
  LAYERS, classColor, EVENT_COLOR,
  SAMPLE_EVENTS, EVENT_ANALYSES, CONFLICT_DETAILS, COUNTRY_PROFILES,
  CHOKEPOINT_DETAILS, COUNTRY_INDEX,
  type CountryIndicator,
} from './data'
import { COUNTRY_SHAPES } from './countries-geo'

/** Expansion state, provided by <Inspector> so the shared Header (and any
 *  width-aware panel content) can read it without prop-threading. */
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

/** Score bar — same contract as the current ScoreBar (score/trend/confidence/note). */
function ScoreRow({ label, ind }: { label: string; ind: CountryIndicator }) {
  const trendGlyph = ind.trend === 'rising' || ind.trend === 'improving' ? '↑' : ind.trend === 'declining' ? '↓' : '→'
  const trendTone =
    ind.trend === 'improving' ? 'text-gain'
    : ind.trend === 'declining' || ind.trend === 'rising' ? 'text-loss'
    : 'text-ink-3'
  // Sequential accent fill scaled by score — replaces the old red/amber/green
  // bar (design-system: status colors are reserved for alerts, not scales).
  const opacity = 0.35 + (ind.score / 10) * 0.65
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink-2">{label}</span>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className={`text-[11px] ${trendTone}`} title={ind.trend}>{trendGlyph}</span>
          <span className="text-[10px] text-ink-3" title={`${ind.confidence} confidence`}>{ind.confidence[0]}</span>
          <span className="tnum text-[12px] font-semibold text-ink">{ind.score}</span>
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${ind.score * 10}%`, opacity }} />
      </div>
      {ind.note && <p className="mt-0.5 text-[10px] leading-snug text-ink-3">{ind.note}</p>}
    </div>
  )
}

const INDICATOR_ROWS: Array<[string, string]> = [
  ['politicalStability', 'Political stability'],
  ['economicDirection', 'Economic direction'],
  ['investmentAttractiveness', 'Investment attractiveness'],
  ['geopoliticalRisk', 'Geopolitical risk'],
  ['educationQuality', 'Education'],
  ['healthcareQuality', 'Healthcare'],
  ['technologyInvestment', 'Technology investment'],
]

/* --------------------------------- panels ---------------------------------- */

const INTENSITY_COLOR: Record<string, string> = {
  critical: '#d03b3b', high: '#ec835a', medium: '#fab219', low: '#84cc16',
}

function ConflictPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const c = CONFLICT_DETAILS[id]
  if (!c) return <FacilityFallback kind="Conflict" name={id} layerId="conflicts" onClose={onClose} />
  return (
    <>
      <Header kind="Conflict" title={c.name} sub={`${c.type} · ${c.region} · since ${c.startYear}`} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Chip color={INTENSITY_COLOR[c.intensity]}>{c.intensity}</Chip>
          <span className="text-[11px] font-medium capitalize text-ink-2">{c.status}</span>
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

function EventPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const e = SAMPLE_EVENTS.find((x) => x.eventId === id)
  const { wide } = useContext(WideCtx)
  const [openAnalysis, setOpenAnalysis] = useState(true)
  if (!e) return null
  const analysis = EVENT_ANALYSES[e.eventId]
  return (
    <>
      <Header kind="Intelligence event" title={e.title} sub={e.countries.join(', ')} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip color={EVENT_COLOR(e.severity)}>sev {e.severity}</Chip>
          <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">{e.eventType.replace(/_/g, ' ')}</span>
          <span className="tnum text-[11px] text-ink-3">
            {(e.confidence * 100).toFixed(0)}% conf · {e.uniqueSourceCount} src
            {e.confidence < 0.6 && ' · ~single-source'}
          </span>
        </div>
        {e.coordinateQuality === 'country_centroid' && (
          <p className="text-[10px] text-ink-3">Hollow mark: country-centroid coordinates (approximate).</p>
        )}
        <p className="text-[12px] leading-relaxed text-ink-2">{e.summary}</p>
        {e.escalationPotential >= 0.7 && (
          <p className="text-[11px] font-medium" style={{ color: '#ec835a' }}>
            Escalation potential {(e.escalationPotential * 100).toFixed(0)}% — ringed on the map.
          </p>
        )}

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

function CountryPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const p = COUNTRY_PROFILES[id]
  const idx = COUNTRY_INDEX.find((c) => c.id === id)
  const { wide } = useContext(WideCtx)
  if (!p) {
    // Any country on the map is clickable now — fall back to the polygon's
    // name for countries outside the 20-entry sample index.
    const shapeName = COUNTRY_SHAPES.find((c) => c.iso === id)?.name
    return (
      <>
        <Header kind="Country" title={idx?.name ?? shapeName ?? id} sub={idx?.region} onClose={onClose} />
        <div className="px-3.5 py-3">
          <p className="text-[12px] leading-relaxed text-ink-3">
            Full profile loads from data/countries/{id}.json in production (7 scored indicators,
            demographics, alliances, investment notes). Sample profiles in this mockup: Thailand, Taiwan.
          </p>
        </div>
      </>
    )
  }
  return (
    <>
      <Header kind="Country" title={p.name} sub={`${p.region} · ${p.capital}`} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <p className="text-[12px] leading-relaxed text-ink-2">{p.summary}</p>
        <div>
          <RowLabel>Indicators</RowLabel>
          <div className={wide ? 'grid grid-cols-2 gap-x-5 gap-y-2.5' : 'space-y-2.5'}>
            {INDICATOR_ROWS.map(([key, label]) =>
              p.indicators[key] ? <ScoreRow key={key} label={label} ind={p.indicators[key]} /> : null,
            )}
          </div>
        </div>
        <div className="border-t border-hairline pt-3">
          <RowLabel>Investment notes</RowLabel>
          <div className="space-y-1.5">
            {p.investmentNotes.strengths.map((s) => (
              <p key={s} className="text-[12px] leading-snug text-ink-2"><span className="text-gain">+</span> {s}</p>
            ))}
            {p.investmentNotes.risks.map((r) => (
              <p key={r} className="text-[12px] leading-snug text-ink-2"><span className="text-loss">−</span> {r}</p>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Sectors: {p.investmentNotes.sectors.join(' · ')}</p>
        </div>
      </div>
    </>
  )
}

const RISK_COLOR: Record<string, string> = { low: '#0ca30c', medium: '#fab219', high: '#d03b3b' }

function ChokepointPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const c = CHOKEPOINT_DETAILS[id]
  if (!c) return <FacilityFallback kind="Chokepoint" name={id} layerId="chokepoints" onClose={onClose} />
  return (
    <>
      <Header kind="Strategic chokepoint" title={c.name} sub={c.share} onClose={onClose} />
      <div className="space-y-3.5 overflow-y-auto px-3.5 py-3">
        <Chip color={RISK_COLOR[c.risk]}>{c.risk} risk</Chip>
        <div>
          <RowLabel>Lanes through</RowLabel>
          {c.lanesThrough.map((l) => (
            <p key={l} className="text-[12px] leading-5 text-ink-2">{l}</p>
          ))}
        </div>
        <div>
          <RowLabel>Exposed portfolio tickers</RowLabel>
          <div className="space-y-1">
            {c.exposedTickers.map((t) => (
              <div key={t.ticker} className="flex items-baseline gap-2">
                <span className="tnum rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink">{t.ticker}</span>
                <span className="text-[11px] text-ink-3">{t.via}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-3">{c.note}</p>
      </div>
    </>
  )
}

function FacilityFallback({ kind, name, layerId, k, onClose }: {
  kind: string; name: string; layerId: string; k?: string; onClose: () => void
}) {
  const layer = LAYERS.find((l) => l.id === layerId)
  return (
    <>
      <Header kind={kind} title={name} sub={layer?.label} onClose={onClose} />
      <div className="space-y-3 px-3.5 py-3">
        {k && (
          <span className="inline-flex items-center gap-1.5 rounded-chip bg-surface-2 px-2 py-1 text-[11px] capitalize text-ink-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: classColor(layerId, k) }} />
            {k.replace(/_/g, ' ')}
          </span>
        )}
        {layer && <p className="text-[12px] leading-relaxed text-ink-3">{layer.description}</p>}
        {layer && <p className="text-[10px] leading-snug text-ink-3">Source: {layer.source}</p>}
      </div>
    </>
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
        <p>event size = severity · hollow = approximate (country-centroid) coordinates · thin ring = escalation ≥ 70%</p>
        <p>diamonds = chokepoints and signals · lines = routes, lanes, cables · soft fills = country shading</p>
      </div>
    </div>
  )
}

/* -------------------------------- inspector -------------------------------- */

export function Inspector({ sel, wide, onToggleWide, onClose }: {
  sel: Selection | null
  wide: boolean
  onToggleWide: () => void
  onClose: () => void
}) {
  // Docked rail by default; expanded = overlay over the canvas from the
  // right (Google-Maps place-panel pattern) — the map keeps its full width
  // underneath and stays interactive to its left. Expansion is lg-only; on
  // small screens the inspector already stacks full-width below the map.
  const expanded = wide && sel !== null
  return (
    <WideCtx.Provider value={{ wide: expanded, onToggleWide }}>
      <aside
        className={`flex w-full flex-col border-t border-hairline bg-surface lg:border-l lg:border-t-0 ${
          expanded
            ? 'lg:absolute lg:inset-y-0 lg:right-0 lg:z-20 lg:w-[min(560px,65%)] lg:shadow-card-hover'
            : 'shrink-0 lg:w-[300px]'
        }`}
      >
        {sel === null ? (
          <IdlePanel />
        ) : sel.kind === 'event' ? (
          <EventPanel id={sel.id} onClose={onClose} />
        ) : sel.kind === 'conflict' ? (
          <ConflictPanel id={sel.id} onClose={onClose} />
        ) : sel.kind === 'country' ? (
          <CountryPanel id={sel.id} onClose={onClose} />
        ) : sel.kind === 'chokepoint' ? (
          <ChokepointPanel id={sel.id} onClose={onClose} />
        ) : (
          <FacilityFallback kind="Facility" name={sel.name} layerId={sel.layerId} k={sel.k} onClose={onClose} />
        )}
      </aside>
    </WideCtx.Provider>
  )
}
