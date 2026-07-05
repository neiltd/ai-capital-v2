'use client'

import { useState } from 'react'

interface Proposal {
  ticker:         string
  assumption:     string
  currentStatus:  string
  proposedStatus: string
  rationale:      string
}

const STATUS_COLOR: Record<string, string> = {
  strengthening: '#22c55e',
  stable:        '#8a8f98',
  weakening:     '#f59e0b',
  broken:        '#ef4444',
}

export function ThesisProposals() {
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/thesis-proposals', { method: 'POST' })
      const data = await res.json() as { proposals: Proposal[]; generatedAt?: string; error?: string }
      if (data.error) { setError(data.error); return }
      setProposals(data.proposals)
      setGeneratedAt(data.generatedAt ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load proposals')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-[#0e1116] border border-[#1e2026] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider">
          AI Thesis Proposals
        </span>
        <button
          onClick={run}
          disabled={loading}
          className="text-[11px] px-2.5 py-1 rounded border border-[#23252a] text-[#8a8f98] hover:text-[#d0d6e0] hover:border-[#34343a] transition-colors disabled:opacity-40">
          {loading ? 'Analyzing…' : proposals === null ? 'Run analysis' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-[#ef4444]">{error}</p>
      )}

      {proposals !== null && proposals.length === 0 && (
        <p className="text-xs text-[#62666d]">No material thesis updates suggested based on today's data.</p>
      )}

      {proposals !== null && proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((p, i) => (
            <div key={i} className="border border-[#1e2026] rounded p-3 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-[#d0d6e0]">{p.ticker}</span>
                <span className="text-xs text-[#62666d]">{p.assumption}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                  <span style={{ color: STATUS_COLOR[p.currentStatus] ?? '#8a8f98' }}>{p.currentStatus}</span>
                  <span className="text-[#62666d]">→</span>
                  <span style={{ color: STATUS_COLOR[p.proposedStatus] ?? '#8a8f98' }}>{p.proposedStatus}</span>
                </span>
              </div>
              <p className="text-xs text-[#8a8f98]">{p.rationale}</p>
            </div>
          ))}
          {generatedAt && (
            <p className="text-[10px] text-[#62666d]">
              Generated {new Date(generatedAt).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT
            </p>
          )}
        </div>
      )}

      {proposals === null && !loading && !error && (
        <p className="text-xs text-[#62666d]">Click "Run analysis" to get AI-suggested thesis updates based on today's briefing.</p>
      )}
    </div>
  )
}
