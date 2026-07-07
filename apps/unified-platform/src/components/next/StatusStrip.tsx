'use client'

import { useEffect, useState } from 'react'
import { fmtUsd, relTime } from '@/lib/next/format'

interface StatusResponse {
  stale: boolean
  date?: string
  netWorthUsd: number | null
  usdThb: number | null
  washSale: Array<{ ticker: string; daysRemaining: number }>
  freshness: { lastRunAt: string | null; ok: boolean }
}

// design-system.md §1 — "Global status strip": NW + day change, FX rate,
// wash-sale countdowns, pipeline freshness. Day change is a known gap
// (backend-gaps #3, no day-over-day NW series yet) — renders as an em dash.
export function StatusStrip() {
  const [status, setStatus] = useState<StatusResponse | null>(null)

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {})
  }, [])

  const freshnessColor = !status
    ? 'bg-ink-3'
    : status.freshness.ok
      ? 'bg-gain'
      : status.freshness.lastRunAt
        ? 'bg-status-warning'
        : 'bg-status-critical'

  const freshnessTitle = status?.freshness.lastRunAt
    ? `Pipeline last ran ${relTime(status.freshness.lastRunAt)}`
    : 'No pipeline run recorded'

  return (
    <div className="flex items-center gap-3 h-7 px-4 text-[12px] text-ink-3 tnum border-b border-hairline">
      <span className="text-ink-2">
        {status?.netWorthUsd != null ? fmtUsd(status.netWorthUsd) : '—'}
      </span>
      <span className="text-ink-3">—</span>
      {status?.usdThb != null && (
        <>
          <span>·</span>
          <span>USD/THB {status.usdThb.toFixed(2)}</span>
        </>
      )}
      {status?.washSale.map((w) => (
        <span key={w.ticker} className="flex items-center gap-1">
          <span>·</span>
          <span className="text-status-warning">
            ⚠ {w.ticker} wash-sale {w.daysRemaining}d
          </span>
        </span>
      ))}
      <span className="ml-auto flex items-center gap-1.5" title={freshnessTitle}>
        <span className={`w-1.5 h-1.5 rounded-full ${freshnessColor}`} />
        data {status?.freshness.lastRunAt ? relTime(status.freshness.lastRunAt) : '—'}
      </span>
    </div>
  )
}
