'use client'

// Manual "refresh prices" — wires to the existing POST /api/portfolio/refresh
// (wraps scenario-simulator's cli-refresh.ts; already handles market-hours
// 409s and the DATABASE_URL pitfall — do not add a new route).

import { useState } from 'react'

type State = 'idle' | 'running' | 'done' | 'error'

export function RefreshPricesButton({ lastPricedAt, marketOpen }: { lastPricedAt: string; marketOpen: boolean }) {
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function refresh() {
    setState('running')
    setMessage(null)
    try {
      const res = await fetch('/api/portfolio/refresh', { method: 'POST' })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setState('error')
        setMessage(data.error ?? 'Refresh failed')
        return
      }
      setState('done')
      window.location.reload()
    } catch (e) {
      setState('error')
      setMessage(e instanceof Error ? e.message : 'unknown error')
    }
  }

  return (
    <div className="flex items-center gap-2">
      {state === 'error' && <span className="text-[12px] text-loss">{message}</span>}
      <button
        onClick={refresh}
        disabled={state === 'running' || !marketOpen}
        className="inline-flex items-center gap-1.5 rounded-chip border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        title={marketOpen ? `Prices last updated ${lastPricedAt}` : 'Markets are closed'}
      >
        <span aria-hidden className={state === 'running' ? 'animate-spin' : ''}>⟳</span>
        {state === 'running' ? 'Refreshing…' : 'Refresh prices'}
      </button>
    </div>
  )
}
