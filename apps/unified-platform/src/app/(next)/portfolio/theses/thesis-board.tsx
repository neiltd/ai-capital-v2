// Thesis board table. No detail drawer (server component, no client JS
// needed) — a future pass can add the click-to-expand position panel once
// the drawer pattern exists elsewhere in the app.

import { Th, Td } from '@/components/next/ui'
import type { ThesisRowVM, RelatedName, ThesisStatus } from './data'

const STATUS: Record<ThesisStatus, { icon: string; color: string; label: string }> = {
  strengthening: { icon: '▲', color: '#0ca30c', label: 'Strengthening' },
  stable: { icon: '•', color: 'var(--ink-3)', label: 'Stable' },
  weakening: { icon: '▼', color: '#ec835a', label: 'Weakening' },
  broken: { icon: '⛔', color: '#d03b3b', label: 'Broken' },
}

function StatusBadge({ status }: { status: ThesisStatus }) {
  const s = STATUS[status]
  return (
    <span className="inline-flex items-center gap-1 rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] font-medium" style={{ color: s.color }}>
      <span aria-hidden>{s.icon}</span> {s.label}
    </span>
  )
}

export function ThesisBoard({ rows, related }: { rows: ThesisRowVM[]; related: Record<string, RelatedName[]> }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-3">No theses in this group.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Ticker</Th>
            <Th>Status</Th>
            <Th>Assumptions</Th>
            <Th>Related</Th>
            <Th>Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
              <Td>
                <a href={`/portfolio?ticker=${r.ticker}`} className="font-semibold text-ink hover:text-accent">{r.ticker}</a>
                <span className="ml-2 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">{r.positionSize}</span>
              </Td>
              <Td><StatusBadge status={r.status} /></Td>
              <Td className="max-w-[36ch]">
                <div className="flex flex-wrap gap-1">
                  {r.assumptions.map((a) => (
                    <span
                      key={a.id}
                      className="rounded-chip border border-hairline px-1.5 py-0.5 text-[11px]"
                      style={{ color: STATUS[a.status as ThesisStatus]?.color ?? 'var(--ink-3)' }}
                      title={a.lastEvidenceSummary ?? undefined}
                    >
                      {a.label}
                    </span>
                  ))}
                </div>
              </Td>
              <Td className="max-w-[28ch]">
                <span className="text-[12px] text-ink-3">
                  {(related[r.ticker] ?? []).slice(0, 3).map((n) => n.ticker).join(', ') || '—'}
                </span>
              </Td>
              <Td>{r.updatedAt.slice(0, 10)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
