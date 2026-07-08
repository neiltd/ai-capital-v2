// /markets/gov — Government contract flow.
//
// Layout:
//   ┌ StatTiles: awards 30d ($) · count · top agency · held-ticker $ ──────┐
//   ├ Awards table (per-ticker, real aggregation)  │ Legislation watch     ┤
//   └─────────────────────────────────────────────────────────────────────┘
//
// Design intents (design-redesign-2026-07/screens/gov), adapted to real
// govflow.json shape — see data.ts for the specific adaptations (per-ticker
// aggregation instead of per-award rows, dropped monthly bars, real bill
// status text instead of a fabricated stepper).

export const dynamic = 'force-dynamic'

import { loadGov } from './data'
import { StatTile, SectionCard, AsOf, AlertBanner, Th, Td } from '@/components/next/ui'
import { fmtUsd } from '@/lib/next/format'

export default function GovPage() {
  const g = loadGov()

  if (!g) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="Gov flow data unavailable" detail="govflow.json not found — has today's pipeline run?" />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Government flow</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            USASpending.gov AI-contract awards to watchlist vendors + the bills that fund them.
          </p>
        </div>
        <AsOf iso={g.exportedAt} />
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Awards 30d" value={fmtUsd(g.awards30d.totalUsd)} footnote="watchlist vendors only" />
        <StatTile label="Award count 30d" value={String(g.awards30d.count)} />
        <StatTile label="Top agency" value={g.awards30d.topAgency} />
        <StatTile
          label="→ held tickers"
          value={fmtUsd(g.awards30d.heldUsd)}
          footnote={g.awards30d.totalUsd > 0 ? `${((g.awards30d.heldUsd / g.awards30d.totalUsd) * 100).toFixed(0)}% of 30d flow lands on names you own` : undefined}
        />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* ------------------------------ awards table ----------------------------- */}
        <SectionCard title="Awards by vendor — 30d" asOf={g.exportedAt} className="col-span-12 xl:col-span-8">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Vendor → ticker</Th>
                  <Th>Top agency</Th>
                  <Th align="right">Awards</Th>
                  <Th align="right">Total 30d</Th>
                  <Th>Contracts</Th>
                </tr>
              </thead>
              <tbody>
                {[...g.awards].sort((a, b) => b.total30d - a.total30d).map((a) => (
                  <tr
                    key={a.ticker}
                    className="border-b border-hairline last:border-0 hover:bg-surface-2"
                    style={a.held ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                  >
                    <Td>
                      <span className="text-ink-3">{a.company}</span>
                      <span className="mx-1 text-ink-3">→</span>
                      <a href={`/portfolio?ticker=${a.ticker}`} className="font-semibold text-ink hover:text-accent">{a.ticker}</a>
                      {a.held && <span className="ml-1.5 rounded-chip bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">held</span>}
                    </Td>
                    <Td className="max-w-[22ch]"><span className="block truncate" title={a.topAgency}>{a.topAgency}</span></Td>
                    <Td align="right">{a.awardCount}</Td>
                    <Td align="right" className="font-medium text-ink">{fmtUsd(a.total30d)}</Td>
                    <Td className="max-w-[36ch]"><span className="block truncate" title={a.contracts.join('; ')}>{a.contracts.join('; ')}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-ink-3">
            Aggregated per vendor over a rolling 30d window — individual award dates/amounts don't
            survive the aggregation today (a vendor→ticker + per-award table is gap #22). Accent
            left edge = held ticker.
          </p>
        </SectionCard>

        {/* --------------------------- legislation watch --------------------------- */}
        <SectionCard title="Legislation watch" className="col-span-12 xl:col-span-4">
          <ul className="space-y-4">
            {g.bills.map((b) => (
              <li key={b.billNumber} className={b.relevantToHeld ? 'border-l-2 border-accent pl-2.5' : undefined}>
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-ink">{b.title}</span>
                  <span className="tnum shrink-0 text-[11px] text-ink-3">Bill {b.billNumber}</span>
                </div>
                <p className="mt-1 text-[12px] leading-4 text-ink-2">{b.status}</p>
                {b.relevantTickers.length > 0 && (
                  <p className="mt-1 tnum text-[11px] text-ink-3">{b.relevantTickers.join(' · ')}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-hairline pt-2 text-[11px] leading-4 text-ink-3">
            Raw congress.gov status text — a stage stepper needs a bill-status fetcher mapping this
            to discrete stages (gap #22). Blue left edge = names you hold.
          </p>
        </SectionCard>
      </div>
    </main>
  )
}
