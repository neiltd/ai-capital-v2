// /markets/waves/trade — Trade agent (paper) acting ONLY on wave signals.
//
// trades.db is empty today (cli-trade.ts has never opened a position) and
// there is no sizing-policy config anywhere in the CLI (gap #21b — --shares
// is still manual). The design mockup's sizing-policy banner and per-position
// risk math ("why this size") both need a real config source that doesn't
// exist yet, so this ships as a read-only, honest empty state rather than
// inventing budget/risk-% numbers. Revisit once cli-trade.ts gets used or
// gap #21b lands.

export const dynamic = 'force-dynamic'

import { loadTrade } from './data'
import { SectionCard, AlertBanner, Th, Td } from '@/components/next/ui'
import { fmtUsd, fmtSignedUsd } from '@/lib/next/format'

export default function TradePage() {
  const t = loadTrade()

  if (!t) {
    return (
      <main className="mx-auto max-w-[1520px] p-page-pad">
        <AlertBanner level="warning" title="Trade data unavailable" detail="wave-analyzer/data/trades.db not found." />
      </main>
    )
  }

  const realized = t.closed.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const hits = t.closed.filter((p) => (p.pnl ?? 0) > 0).length

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Trade agent</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Paper trader that acts only on <a href="/markets/waves" className="text-accent">wave signals</a> —
            no news, no fundamentals, no scenario input.
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">trades.db via `npm run trade`</span>
      </header>

      <AlertBanner
        level="info"
        title="No sizing policy configured yet"
        detail="cli-trade.ts still takes --shares as a manual flag (gap #21b) — there is no automatic risk-per-trade % or trade budget to display honestly."
      />

      {/* ----------------------------- open positions ---------------------------- */}
      <SectionCard title={`Open positions (${t.open.length})`}>
        {t.open.length === 0 ? (
          <p className="text-[13px] text-ink-3">No open paper trades — cli-trade.ts has not opened a position yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Ticker</Th>
                  <Th>Signal</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Stop</Th>
                  <Th align="right">Target</Th>
                  <Th align="right">Shares</Th>
                  <Th>Opened</Th>
                </tr>
              </thead>
              <tbody>
                {t.open.map((p) => (
                  <tr key={p.id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                    <Td><span className="font-semibold text-ink">{p.ticker}</span></Td>
                    <Td className="uppercase">{p.signal}</Td>
                    <Td align="right">{fmtUsd(p.entryPrice, { cents: p.entryPrice < 100 })}</Td>
                    <Td align="right">{fmtUsd(p.stopLoss, { cents: p.stopLoss < 100 })}</Td>
                    <Td align="right">{fmtUsd(p.target, { cents: p.target < 100 })}</Td>
                    <Td align="right">{p.shares}</Td>
                    <Td>{p.openedAt.slice(0, 10)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ------------------------------ closed trades ----------------------------- */}
      <SectionCard title={`Closed trades (${t.closed.length})`}>
        {t.closed.length === 0 ? (
          <p className="text-[13px] text-ink-3">No closed paper trades yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Ticker</Th>
                    <Th>Signal</Th>
                    <Th align="right">Entry</Th>
                    <Th align="right">Exit</Th>
                    <Th>Status</Th>
                    <Th align="right">P&L</Th>
                  </tr>
                </thead>
                <tbody>
                  {t.closed.map((p) => (
                    <tr key={p.id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                      <Td><span className="font-semibold text-ink">{p.ticker}</span></Td>
                      <Td className="uppercase">{p.signal}</Td>
                      <Td align="right">{fmtUsd(p.entryPrice, { cents: p.entryPrice < 100 })}</Td>
                      <Td align="right">{p.closePrice != null ? fmtUsd(p.closePrice, { cents: p.closePrice < 100 }) : '—'}</Td>
                      <Td className="uppercase">{p.status}</Td>
                      <Td align="right">
                        <span className={`font-medium ${(p.pnl ?? 0) > 0 ? 'text-gain' : (p.pnl ?? 0) < 0 ? 'text-loss' : 'text-ink-3'}`}>
                          {p.pnl != null ? fmtSignedUsd(p.pnl) : '—'}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-3">
              Realized: {fmtSignedUsd(realized)} · {hits}/{t.closed.length} profitable — too small an n to draw a keep-or-kill conclusion (hit-rate aggregation is gap #21).
            </p>
          </>
        )}
      </SectionCard>
    </main>
  )
}
