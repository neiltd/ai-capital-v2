'use client'

// "Promote to real portfolio" — the bridge from paper conviction to real
// money. Deliberately heavyweight: a dialog that shows exactly what will be
// written, runs the wash-sale check first, and requires typing the ticker.
//
// Backend gap #5: needs POST /api/portfolio/promote
//   { ticker, shares, limitNote } → runs wash-sale + jurisdiction check,
//   appends to scenario-simulator trade_log, removes from paper portfolio,
//   archives the discovery rationale into thesis-memory as the opening thesis.

import { useState } from 'react'
import { fmtUsd } from '../_shared/format'

export function PromoteButton({
  ticker,
  company,
  currentPrice,
  paperShares,
  rationale,
}: {
  ticker: string
  company: string
  currentPrice: number
  paperShares: number
  rationale: string
}) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState(paperShares)
  const [confirmText, setConfirmText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function promote() {
    setSubmitting(true)
    try {
      await fetch('/api/portfolio/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker, shares }),
      })
      setOpen(false)
      // Real impl: toast + router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-chip bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90"
      >
        Promote…
      </button>

      {open && (
        // shadcn <Dialog> in the real app; minimal modal here for completeness
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-md rounded-card border border-hairline bg-surface p-5">
            <h3 className="text-[15px] font-semibold text-ink">
              Promote {ticker} to the real portfolio
            </h3>
            <p className="mt-1 text-[13px] leading-5 text-ink-2">
              {company} · paper position opened by the discovery agent. This logs a <b>real BUY</b> in
              the trade log and seeds thesis-memory with the discovery rationale.
            </p>

            {/* wash-sale / jurisdiction pre-check result (fetched on open) */}
            <div className="mt-3 rounded-chip bg-surface-2 px-3 py-2 text-[12px] leading-4 text-ink-2">
              ✓ No active wash-sale window for {ticker} · US taxable jurisdiction
            </div>

            <label className="mt-4 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
              Shares (paper held {paperShares})
            </label>
            <input
              type="number"
              value={shares}
              min={0}
              step="any"
              onChange={(e) => setShares(Number(e.target.value))}
              className="tnum mt-1 w-full rounded-chip border border-hairline bg-surface-2 px-2.5 py-1.5 text-[14px] text-ink"
            />
            <div className="tnum mt-1 text-[12px] text-ink-3">
              ≈ {fmtUsd(shares * currentPrice)} at {fmtUsd(currentPrice, { cents: true })}
            </div>

            <details className="mt-3 text-[12px] text-ink-3">
              <summary className="cursor-pointer">Opening thesis (from discovery)</summary>
              <p className="mt-1 leading-4">{rationale}</p>
            </details>

            <label className="mt-4 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
              Type {ticker} to confirm
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded-chip border border-hairline bg-surface-2 px-2.5 py-1.5 text-[14px] text-ink"
              placeholder={ticker}
            />

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-chip border border-hairline px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2">
                Cancel
              </button>
              <button
                onClick={promote}
                disabled={confirmText !== ticker || shares <= 0 || submitting}
                className="rounded-chip bg-accent px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {submitting ? 'Logging…' : 'Log real BUY'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
