'use client'

import { useState } from 'react'

interface Props {
  marketOpen: boolean
}

export function RefreshPricesButton({ marketOpen }: Props) {
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  async function run() {
    setLoading(true)
    setMessage(null)
    setIsError(false)
    try {
      const res = await fetch('/api/portfolio/refresh', { method: 'POST' })
      const data = await res.json() as { ok: boolean; error?: string }
      if (!data.ok) {
        setIsError(true)
        setMessage(data.error ?? 'Refresh failed')
      } else {
        setMessage(`Prices refreshed at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT`)
      }
    } catch (e) {
      setIsError(true)
      setMessage(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={run}
        disabled={loading || !marketOpen}
        title={marketOpen ? undefined : 'Markets are closed'}
        className="text-[11px] px-2.5 py-1 rounded border border-[#23252a] text-[#8a8f98] hover:text-[#d0d6e0] hover:border-[#34343a] transition-colors disabled:opacity-40">
        {loading ? 'Refreshing…' : 'Refresh prices'}
      </button>
      {message && (
        <span className={`text-[11px] ${isError ? 'text-[#ef4444]' : 'text-[#62666d]'}`}>{message}</span>
      )}
    </div>
  )
}
