'use client'

// Side panel that expands an event into its causal tree.
// Triggered by clicking an event title in the trade-disrupting events banner.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface TreeEventDto {
  eventId:    string
  title:      string
  summary:    string
  eventType:  string
  severity:   number
  status:     string
  countries:  string[]
  occurredAt: string
}
interface TreeLinkDto {
  event:      TreeEventDto
  confidence: number
  rationale:  string
}
interface CausalTreeResponse {
  target: TreeEventDto & {
    causalConfidence:     number | null
    counterfactual:       string | null
    expectedConsequences: string[]
  }
  predecessors: TreeLinkDto[]
  successors:   TreeLinkDto[]
}

interface Props {
  eventId: string
  onClose: () => void
  // Allow navigating from a child event back into another tree (replace eventId).
  onSelectEvent?: (eventId: string) => void
}

export default function CausalTreePanel({ eventId, onClose, onSelectEvent }: Props) {
  const [data, setData] = useState<CausalTreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Guard against out-of-order responses: rapid clicks through the
    // predecessor/successor chain change `eventId` before the prior fetch
    // resolves, so an older (slower) response can otherwise land after a
    // newer one and clobber the panel with the wrong event's tree.
    const controller = new AbortController()
    setData(null); setError(null)
    fetch(`/api/world-intel/causal-tree?eventId=${encodeURIComponent(eventId)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => controller.abort()
  }, [eventId])

  return createPortal(
    <div className="fixed z-[9995] inset-y-4 right-4 w-[420px] max-w-[90vw] rounded-xl shadow-2xl overflow-hidden flex flex-col"
      style={{ background: '#0A0F1E', border: '1px solid #1E2D4A' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b flex justify-between items-start"
        style={{ borderColor: '#1E2D4A' }}>
        <div>
          <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-400 mb-1">
            Causal tree
          </p>
          <p className="text-[11px] text-text-muted">{eventId}</p>
        </div>
        <button onClick={onClose}
          className="text-text-muted hover:text-text-secondary text-lg leading-none">×</button>
      </div>

      {/* Body */}
      <div className="px-4 py-3 overflow-y-auto flex-1 flex flex-col gap-3">
        {error && (
          <p className="text-[12px] text-red-300">Error: {error}</p>
        )}
        {!data && !error && (
          <p className="text-[12px] text-text-muted">Loading…</p>
        )}
        {data && (
          <>
            {/* Predecessors (caused-by chain, ascending in time) */}
            {data.predecessors.length > 0 && (
              <section>
                <p className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                  Why now ({data.predecessors.length} caused-by link{data.predecessors.length === 1 ? '' : 's'})
                </p>
                <div className="flex flex-col gap-2">
                  {data.predecessors.map(p => (
                    <button key={p.event.eventId}
                      onClick={() => onSelectEvent?.(p.event.eventId)}
                      className="text-left rounded-lg px-3 py-2 hover:bg-bg-card-hover transition"
                      style={{ background: '#0F1729', border: '1px solid #1E2D4A' }}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] text-amber-300 font-semibold tabular-nums">
                          conf {p.confidence.toFixed(2)}
                        </span>
                        <span className="text-[10px] text-text-muted tabular-nums">
                          {p.event.occurredAt.slice(0, 10)}
                        </span>
                      </div>
                      <p className="text-[12px] text-text-primary font-medium leading-snug">
                        {p.event.title}
                      </p>
                      <p className="text-[11px] text-text-muted italic mt-1 leading-snug">
                        {p.rationale}
                      </p>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Target (the event we're tree-ing) */}
            <section className="rounded-lg px-3 py-3"
              style={{ background: '#0F1729', border: '2px solid #dc2626' }}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-red-400">
                  This event · sev {data.target.severity}
                </span>
                {data.target.causalConfidence != null && (
                  <span className="text-[10px] text-text-muted tabular-nums">
                    causal conf {data.target.causalConfidence.toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-white font-bold leading-snug">{data.target.title}</p>
              <p className="text-[11px] text-text-secondary leading-snug mt-1">{data.target.summary}</p>
              {data.target.countries.length > 0 && (
                <p className="text-[10px] text-text-muted mt-2">
                  {data.target.countries.join(' · ')}
                </p>
              )}
              {data.target.counterfactual && (
                <div className="mt-2 pt-2 border-t" style={{ borderColor: '#1E2D4A' }}>
                  <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                    If this hadn’t happened
                  </p>
                  <p className="text-[11px] text-text-secondary italic leading-snug">
                    {data.target.counterfactual}
                  </p>
                </div>
              )}
            </section>

            {/* Expected consequences */}
            {data.target.expectedConsequences.length > 0 && (
              <section>
                <p className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                  Expected near-term consequences
                </p>
                <ul className="flex flex-col gap-1.5">
                  {data.target.expectedConsequences.map((c, i) => (
                    <li key={i}
                      className="text-[11px] text-text-secondary leading-snug pl-3 border-l-2"
                      style={{ borderColor: '#f59e0b' }}>
                      {c}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Successors (events caused by this one) */}
            {data.successors.length > 0 && (
              <section>
                <p className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                  Already triggered ({data.successors.length} downstream event{data.successors.length === 1 ? '' : 's'})
                </p>
                <div className="flex flex-col gap-2">
                  {data.successors.map(s => (
                    <button key={s.event.eventId}
                      onClick={() => onSelectEvent?.(s.event.eventId)}
                      className="text-left rounded-lg px-3 py-2 hover:bg-bg-card-hover transition"
                      style={{ background: '#0F1729', border: '1px solid #1E2D4A' }}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] text-amber-300 font-semibold tabular-nums">
                          conf {s.confidence.toFixed(2)}
                        </span>
                        <span className="text-[10px] text-text-muted tabular-nums">
                          {s.event.occurredAt.slice(0, 10)}
                        </span>
                      </div>
                      <p className="text-[12px] text-text-primary font-medium leading-snug">
                        {s.event.title}
                      </p>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
