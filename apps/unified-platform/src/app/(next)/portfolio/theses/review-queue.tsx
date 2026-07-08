'use client'

// Accept/reject buttons for pending thesis-change proposals. POSTs to
// /api/theses/proposals/[id] (gated behind APP_ACCESS_KEY, like the other
// mutating routes) then router.refresh() to re-render the server component
// with the updated state.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Label, SectionCard } from '@/components/next/ui'
import type { ProposalVM } from './data'

export function ReviewQueue({ proposals }: { proposals: ProposalVM[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function resolve(id: string, decision: 'accept' | 'reject') {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/theses/proposals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error ?? 'Failed to resolve proposal')
        return
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <SectionCard title={<span className="text-status-warning">Review queue · {proposals.length} pending proposal{proposals.length > 1 ? 's' : ''}</span>}>
      {error && <p className="mb-2 text-[12px] text-loss">{error}</p>}
      <ul className="divide-y divide-hairline">
        {proposals.map((p) => (
          <li key={p.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <a href={`/portfolio?ticker=${p.ticker}`} className="text-[14px] font-semibold text-ink hover:text-accent">{p.ticker}</a>
              <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">{p.changeType.replace('_', ' ')}</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => resolve(p.id, 'accept')}
                  disabled={busyId === p.id}
                  className="rounded-chip bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  Accept
                </button>
                <button
                  onClick={() => resolve(p.id, 'reject')}
                  disabled={busyId === p.id}
                  className="rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>

            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div className="rounded-chip border border-hairline p-2.5">
                <Label>Current</Label>
                <p className="mt-0.5 text-[13px] leading-5 text-ink-3 line-through decoration-hairline">{p.oldValue}</p>
              </div>
              <div className="rounded-chip border border-accent/40 p-2.5">
                <Label>Proposed</Label>
                <p className="mt-0.5 text-[13px] leading-5 text-ink">{p.newValue}</p>
              </div>
            </div>
            <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{p.reasoning}</p>
            {p.evidenceQuotes.slice(0, 3).map((q) => (
              <blockquote key={q} className="mt-1 border-l-2 border-hairline pl-2 text-[12px] italic leading-4 text-ink-3">&ldquo;{q}&rdquo;</blockquote>
            ))}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-4 text-ink-3">
        Accept applies the change to the live thesis (assumption status + evidence). Nothing changes without your click.
      </p>
    </SectionCard>
  )
}
