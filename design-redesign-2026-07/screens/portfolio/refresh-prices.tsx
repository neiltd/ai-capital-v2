'use client'

// Manual "refresh prices" — one of the few mutating actions in the app.
// Calls POST /api/portfolio/refresh-prices (wraps scripts/refresh-prices.sh;
// backend gap #8: needs an API route + job-status polling instead of a
// fire-and-forget shell script).

import { useState } from 'react'

type State = 'idle' | 'running' | 'done' | 'error'

export function RefreshPricesButton({ lastPricedAt }: { lastPricedAt: string }) {
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setState('running')
    setError(null)
    try {
      const res = await fetch('/api/portfolio/refresh-prices', { method: 'POST' })
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
      // Real impl: poll GET /api/portfolio/refresh-prices/:jobId until settled,
      // then router.refresh() to re-render server components with new prices.
      setState('done')
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error')
      setState('error')
    }
  }

  return (
    <div className="flex items-center gap-2">
      {state === 'error' && <span className="text-[12px] text-loss">{error}</span>}
      <button
        onClick={refresh}
        disabled={state === 'running'}
        className="inline-flex items-center gap-1.5 rounded-chip border border-hairline px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        title={`Prices last updated ${lastPricedAt}`}
      >
        <span aria-hidden className={state === 'running' ? 'animate-spin' : ''}>⟳</span>
        {state === 'running' ? 'Refreshing…' : 'Refresh prices'}
      </button>
    </div>
  )
}
