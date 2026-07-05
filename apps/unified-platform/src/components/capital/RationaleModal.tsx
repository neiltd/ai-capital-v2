'use client'

import { useEffect, useState } from 'react'

interface Props {
  ticker:           string
  company:          string
  score:            number
  source:           string
  rationale:        string
  analystRationale: string | null
  conviction:       string | null
  sizingTier:       string
  allocPct:         number
  paperBudget:      number
  shares:           number
  currentValue:     number
  openedAt:         string
}

export function RationaleModal(props: Props) {
  const {
    ticker, company, score, source, rationale,
    analystRationale, conviction, sizingTier, allocPct, paperBudget,
    shares, currentValue, openedAt,
  } = props

  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [isOpen])

  const isNews   = source === 'news_mention'
  const scoreCls = score >= 80
    ? 'bg-green-signal/10 text-green-signal border-green-signal/20'
    : 'bg-amber-signal/10 text-amber-signal border-amber-signal/20'

  return (
    <>
      {/* Trigger — clickable cell content */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="text-left w-full group cursor-pointer"
        aria-label={`Show full reasoning for ${ticker}`}
      >
        <div className="text-[11px] text-text-secondary line-clamp-2 leading-snug group-hover:text-text-primary transition-colors">
          {rationale}
        </div>
        <div className="text-[9px] text-text-inactive mt-0.5 flex items-center gap-1">
          {sizingTier}
          <span className="text-indigo-active opacity-0 group-hover:opacity-100 transition-opacity">· click to expand</span>
        </div>
      </button>

      {/* Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="bg-bg-card border border-border-subtle rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {/* Header */}
            <div className="sticky top-0 bg-bg-card border-b border-border-subtle px-5 py-4 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-lg font-bold text-indigo-active">{ticker}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${scoreCls}`}>
                    Score {score}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    isNews
                      ? 'bg-accent-primary/10 text-indigo-active border-accent-primary/20'
                      : 'bg-border-subtle text-text-muted border-border-subtle'
                  }`}>
                    {isNews ? 'news mention' : 'tracked watchlist'}
                  </span>
                </div>
                <div className="text-[13px] text-text-secondary mt-1">{company}</div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-text-inactive hover:text-text-primary text-2xl leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-bg-sidebar"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-5">

              {/* Section 1 — Why it surfaced */}
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-inactive mb-2">
                  ① Why this ticker surfaced
                </div>
                <p className="text-[13px] text-text-primary leading-relaxed">
                  {rationale}
                </p>
              </section>

              {/* Section 2 — Analyst recommendation */}
              {analystRationale && (
                <section>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-text-inactive mb-2">
                    ② Analyst deep dive
                    {conviction && (
                      <span className="ml-2 text-green-signal normal-case font-bold">
                        · {conviction} conviction
                      </span>
                    )}
                  </div>
                  <div className="bg-green-signal/5 border border-green-signal/15 rounded p-3">
                    <p className="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap">
                      {analystRationale}
                    </p>
                  </div>
                </section>
              )}

              {/* Section 3 — Sizing math */}
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-inactive mb-2">
                  ③ Position sizing
                </div>
                <div className="bg-bg-sidebar border border-border-subtle rounded p-3 space-y-2 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Conviction tier</span>
                    <span className="text-text-primary font-medium">{sizingTier}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Allocation</span>
                    <span className="text-text-primary font-medium tabular-nums">
                      ${currentValue.toFixed(2)} <span className="text-text-inactive">({allocPct.toFixed(1)}% of budget)</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Shares purchased</span>
                    <span className="text-text-primary font-medium tabular-nums">{shares.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Total budget</span>
                    <span className="text-text-primary font-medium tabular-nums">${paperBudget.toLocaleString()}</span>
                  </div>
                </div>
                <p className="text-[11px] text-text-inactive mt-2 leading-relaxed">
                  Size is conviction-driven: score ≥90 → 12% of deployable, ≥80 → 8%, else 5%. A 20% cash reserve is held back regardless of conviction.
                </p>
              </section>

              {/* Section 4 — Position metadata */}
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-inactive mb-2">
                  ④ Position info
                </div>
                <div className="text-[12px] text-text-muted">
                  Opened on <span className="text-text-primary font-medium">{new Date(openedAt).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
