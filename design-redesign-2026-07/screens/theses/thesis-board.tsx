'use client'

// Thesis board + detail drawer. Client component: row click opens a right
// slide-over without losing board context (design-system §6 — ticker is the
// universal link; the drawer is the position panel's thesis tab).

import { useState } from 'react'
import type { ThesisRow, RelatedName, AssumptionStatus, ThesisStatus } from './data'
import { Label, Th, Td } from '../_shared/ui'
import { fmtUsd, fmtSignedUsd } from '../_shared/format'

/* --------------------------- status vocabulary ---------------------------- */
// Same words the briefing markdown already uses; status palette, icon+label —
// never color alone.

const STATUS: Record<ThesisStatus, { icon: string; color: string; label: string }> = {
  strengthening: { icon: '▲', color: '#0ca30c', label: 'Strengthening' },
  stable: { icon: '•', color: 'var(--ink-3)', label: 'Stable' },
  mixed: { icon: '◆', color: '#fab219', label: 'Mixed' },
  weakening: { icon: '▼', color: '#ec835a', label: 'Weakening' },
  broken: { icon: '⛔', color: '#d03b3b', label: 'Broken' },
}

export function StatusBadge({ status }: { status: ThesisStatus | AssumptionStatus }) {
  const s = STATUS[status as ThesisStatus] ?? STATUS.stable
  return (
    <span className="inline-flex items-center gap-1 rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] font-medium" style={{ color: s.color }}>
      <span aria-hidden>{s.icon}</span> {s.label}
    </span>
  )
}

const RELATION_LABEL: Record<string, string> = {
  competitive: 'Competitors',
  supply_chain: 'Supply chain',
  customer: 'Customers / vendors',
  technology: 'Technology links',
  same_theme: 'Same theme',
}
const RELATION_ORDER = ['competitive', 'supply_chain', 'customer', 'technology', 'same_theme']

/* --------------------------------- board ---------------------------------- */

export function ThesisBoard({
  rows,
  related,
  variant,
}: {
  rows: ThesisRow[]
  related: Record<string, RelatedName[]>
  variant: 'held' | 'closed'
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const sel = rows.find((r) => r.ticker === selected) ?? null
  const ageDays = (r: ThesisRow) =>
    Math.round((Date.parse('2026-07-06') - Date.parse(r.lastReviewedAt)) / 86400000)

  // Sort: weakening/broken first, then mixed, then age desc — proposals are
  // already surfaced in their own queue above the board.
  const order: ThesisStatus[] = ['broken', 'weakening', 'mixed', 'strengthening', 'stable']
  const sorted = [...rows].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || ageDays(b) - ageDays(a),
  )

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Ticker</Th>
              <Th>Status</Th>
              <Th>Core thesis</Th>
              {variant === 'held' ? <Th align="right">Position</Th> : <Th align="right">Exited</Th>}
              {variant === 'held' ? <Th align="right">P&L</Th> : <Th align="right">Realized</Th>}
              <Th align="right">Reviewed</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const stale = ageDays(r) > 30 && r.status !== 'stable'
              return (
                <tr
                  key={r.ticker}
                  onClick={() => setSelected(r.ticker)}
                  className="cursor-pointer border-b border-hairline last:border-0 hover:bg-surface-2"
                >
                  <Td>
                    <span className="font-semibold text-ink">{r.ticker}</span>
                    <span className="ml-2 hidden text-ink-3 lg:inline">{r.company}</span>
                    {r.kind === 'theme' && (
                      <span className="ml-2 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">theme</span>
                    )}
                  </Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td className="max-w-[46ch]">
                    <span className="block truncate" title={r.core}>{r.core}</span>
                  </Td>
                  {variant === 'held' ? (
                    <Td align="right">{r.position ? fmtUsd(r.position.valueUsd) : '—'}</Td>
                  ) : (
                    <Td align="right">{r.closed?.exitedAt ?? '—'}</Td>
                  )}
                  {variant === 'held' ? (
                    <Td align="right">
                      {r.position && (
                        <span className={r.position.unrealizedPnlUsd > 0 ? 'text-gain' : r.position.unrealizedPnlUsd < 0 ? 'text-loss' : 'text-ink-3'}>
                          {fmtSignedUsd(r.position.unrealizedPnlUsd)}
                        </span>
                      )}
                    </Td>
                  ) : (
                    <Td align="right">
                      {r.closed && (
                        <span className={r.closed.realizedPnlUsd > 0 ? 'text-gain' : 'text-loss'}>
                          {fmtSignedUsd(r.closed.realizedPnlUsd)}
                        </span>
                      )}
                    </Td>
                  )}
                  <Td align="right">
                    <span className={stale ? 'text-status-warning' : ''} title={stale ? 'Unreviewed >30d while status ≠ stable' : undefined}>
                      {ageDays(r)}d{stale ? ' ⚠' : ''}
                    </span>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {sel && (
        <ThesisDrawer row={sel} related={related[sel.ticker] ?? []} onClose={() => setSelected(null)} />
      )}
    </>
  )
}

/* --------------------------------- drawer --------------------------------- */

function ThesisDrawer({
  row,
  related,
  onClose,
}: {
  row: ThesisRow
  related: RelatedName[]
  onClose: () => void
}) {
  const groups = RELATION_ORDER.map((rel) => ({
    rel,
    names: related.filter((r) => r.relation === rel),
  })).filter((g) => g.names.length > 0)

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto border-l border-hairline bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label={`${row.ticker} thesis`}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[20px] font-semibold text-ink">{row.ticker}</h3>
              <StatusBadge status={row.status} />
              <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">{row.positionSize}</span>
            </div>
            <div className="text-[13px] text-ink-3">{row.company}</div>
          </div>
          <button onClick={onClose} className="rounded-chip border border-hairline px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
            Esc
          </button>
        </header>

        {/* position / exit context */}
        {row.position && (
          <div className="tnum mt-3 flex items-baseline gap-4 rounded-chip bg-surface-2 px-3 py-2 text-[13px]">
            <span className="text-ink">{fmtUsd(row.position.valueUsd)}</span>
            <span className={row.position.unrealizedPnlUsd >= 0 ? 'text-gain' : 'text-loss'}>
              {fmtSignedUsd(row.position.unrealizedPnlUsd)} unrealized
            </span>
            <a href={`/portfolio?ticker=${row.ticker}`} className="ml-auto text-[12px] text-accent">Position →</a>
          </div>
        )}
        {row.closed && (
          <div className="mt-3 rounded-chip bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
            Exited {row.closed.exitedAt} ·{' '}
            <span className={`tnum ${row.closed.realizedPnlUsd >= 0 ? 'text-gain' : 'text-loss'}`}>
              {fmtSignedUsd(row.closed.realizedPnlUsd)} realized
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-3">{row.closed.exitReason}</span>
          </div>
        )}

        <section className="mt-4">
          <Label>Thesis</Label>
          <p className="mt-1 text-[14px] leading-[21px] text-ink-2">{row.narrative}</p>
        </section>

        <section className="mt-4">
          <Label>Assumptions</Label>
          <ul className="mt-1.5 space-y-1.5">
            {row.assumptions.map((a) => (
              <li key={a.label} className="flex items-start gap-2">
                <StatusBadge status={a.status} />
                <div className="min-w-0">
                  <div className="text-[13px] leading-5 text-ink">{a.label}</div>
                  {a.lastEvidence && <div className="text-[12px] leading-4 text-ink-3">{a.lastEvidence}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-4">
          <Label>Status timeline</Label>
          <ol className="mt-1.5 space-y-0 border-l border-hairline pl-3">
            {row.history.map((h) => (
              <li key={h.date + h.note} className="relative pb-3 last:pb-0">
                <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full border border-hairline bg-surface-2" />
                <div className="flex items-center gap-2">
                  <span className="tnum text-[12px] text-ink-3">{h.date}</span>
                  <StatusBadge status={h.status} />
                  {h.source && <span className="text-[11px] text-ink-3">{h.source}</span>}
                </div>
                <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{h.note}</p>
                {h.evidenceQuote && (
                  <blockquote className="mt-0.5 border-l-2 border-hairline pl-2 text-[12px] italic leading-4 text-ink-3">
                    “{h.evidenceQuote}”
                  </blockquote>
                )}
              </li>
            ))}
          </ol>
        </section>

        {/* Related names — from the dependency/trade graph, so adjacent
            tickers surface automatically (Task 3c). */}
        <section className="mt-4 border-t border-hairline pt-3">
          <div className="flex items-baseline justify-between">
            <Label>Related names · dependency graph</Label>
            <a href={`/discover/graph?focus=${row.ticker}`} className="text-[12px] text-accent">Graph →</a>
          </div>
          {groups.length === 0 ? (
            <p className="mt-1.5 text-[12px] leading-4 text-ink-3">
              {row.ticker} is not in the dependency graph — coverage today is the US AI universe
              (34 nodes). Thai/fund tickers need graph expansion (gap #17).
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.rel} className="mt-2.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                  {RELATION_LABEL[g.rel]}
                </div>
                <ul className="mt-1 space-y-1">
                  {g.names.map((n) => (
                    <li key={n.ticker} className="flex items-start gap-2 text-[13px] leading-5">
                      <a href={`/portfolio/theses?ticker=${n.ticker}`} className="font-semibold text-ink hover:text-accent">
                        {n.ticker}
                      </a>
                      {n.held && <span className="rounded-chip bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">held</span>}
                      {!n.held && n.paper && <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">paper</span>}
                      {n.hasThesis && <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[10px] text-ink-3">thesis</span>}
                      {n.strength && <span className="text-[11px] text-ink-3">{n.strength}</span>}
                      <span className="min-w-0 flex-1 truncate text-ink-3" title={n.description}>{n.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </aside>
    </div>
  )
}
