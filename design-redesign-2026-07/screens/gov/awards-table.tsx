'use client'

// Awards table with the filter row (agency combobox, held-only toggle,
// min-amount). Held-ticker rows get the row-left 2px accent border — held
// relevance is the point of this screen.

import { useMemo, useState } from 'react'
import type { AwardRow } from './data'
import { Th, Td } from '../_shared/ui'
import { fmtUsd } from '../_shared/format'

export function AwardsTable({ rows }: { rows: AwardRow[] }) {
  const [agency, setAgency] = useState<string>('all')
  const [heldOnly, setHeldOnly] = useState(false)
  const [minM, setMinM] = useState(0)

  const agencies = useMemo(() => ['all', ...Array.from(new Set(rows.map((r) => r.agency)))], [rows])
  const filtered = rows
    .filter((r) => agency === 'all' || r.agency === agency)
    .filter((r) => !heldOnly || r.held)
    .filter((r) => r.amountUsd >= minM * 1e6)
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select
          value={agency}
          onChange={(e) => setAgency(e.target.value)}
          className="rounded-chip border border-hairline bg-surface-2 px-2 py-1 text-[12px] text-ink-2"
          aria-label="Filter by agency"
        >
          {agencies.map((a) => (
            <option key={a} value={a}>{a === 'all' ? 'All agencies' : a}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} />
          held tickers only
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          min $
          <input
            type="number"
            value={minM}
            min={0}
            onChange={(e) => setMinM(Number(e.target.value))}
            className="tnum w-16 rounded-chip border border-hairline bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink"
          />
          M
        </label>
        <span className="tnum ml-auto text-[12px] text-ink-3">{filtered.length} of {rows.length} awards</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Agency</Th>
              <Th>Vendor → ticker</Th>
              <Th>Program</Th>
              <Th align="right">Amount</Th>
              <Th>Type</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.date + r.program}
                className="border-b border-hairline last:border-0 hover:bg-surface-2"
                style={r.held ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
              >
                <Td>{r.date}</Td>
                <Td className="max-w-[22ch]"><span className="block truncate" title={r.agency}>{r.agency}</span></Td>
                <Td>
                  <span className="text-ink-3">{r.vendor}</span>
                  <span className="mx-1 text-ink-3">→</span>
                  <a href={`/portfolio?ticker=${r.ticker}`} className="font-semibold text-ink hover:text-accent">{r.ticker}</a>
                  {r.held && <span className="ml-1.5 rounded-chip bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">held</span>}
                  {!r.held && r.paper && <span className="ml-1.5 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">paper</span>}
                </Td>
                <Td className="max-w-[42ch]"><span className="block truncate" title={r.program}>{r.program}</span></Td>
                <Td align="right" className="font-medium text-ink">{fmtUsd(r.amountUsd)}</Td>
                <Td>{r.awardType}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-ink-3">
        Vendor→ticker mapping is partial today — a maintained vendor_tickers table is gap #22.
        Accent left edge = held ticker.
      </p>
    </>
  )
}
