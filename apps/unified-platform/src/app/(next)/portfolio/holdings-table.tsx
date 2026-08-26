'use client'

// Holdings table, grouped by asset class, USD-normalized with native-currency
// sublines. Expandable rows (thesis one-liner + risk snapshot + trade-log
// link) — expansion state is the only client concern here.

import { Fragment, useState } from 'react'
import type { Position } from '@/lib/next/types'
import { fmtUsd, fmtThb, fmtThbPrice, fmtQty, toUsd, pnlUsd, costUsd } from '@/lib/next/format'
import { Th, Td, StrategyTag, Delta } from '@/components/next/ui'
import { CLASS_META, CLASS_ORDER } from './class-meta'

export function HoldingsTable({ positions, usdThb }: { positions: Position[]; usdThb: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const totalUsd = positions.reduce((s, p) => s + toUsd(p, usdThb), 0)

  return (
    <div className="overflow-x-auto xl:overflow-visible">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th className="w-6" sticky />
            <Th sticky>Ticker</Th>
            <Th align="right" sticky>Shares</Th>
            <Th align="right" sticky>Avg cost</Th>
            <Th align="right" sticky>Price</Th>
            <Th align="right" sticky>Value (USD)</Th>
            <Th align="right" sticky>Weight</Th>
            <Th align="right" sticky>Unrealized P&L</Th>
          </tr>
        </thead>
        {CLASS_ORDER.map((cls) => {
          const rows = positions.filter((p) => p.assetClass === cls)
          if (rows.length === 0) return null
          const clsUsd = rows.reduce((s, p) => s + toUsd(p, usdThb), 0)
          const meta = CLASS_META[cls]
          return (
            <tbody key={cls}>
              {/* group header row */}
              <tr className="bg-surface-2/60">
                <td className="px-3 py-1" colSpan={5}>
                  <span className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: meta.color }} />
                    {meta.label}
                  </span>
                </td>
                <td className="tnum px-3 py-1 text-right text-[12px] font-semibold text-ink">{fmtUsd(clsUsd)}</td>
                <td className="tnum px-3 py-1 text-right text-[12px] text-ink-3">
                  {((clsUsd / totalUsd) * 100).toFixed(1)}%
                </td>
                <td />
              </tr>
              {rows.map((p) => {
                const usd = toUsd(p, usdThb)
                const pnl = pnlUsd(p, usdThb)
                const cost = costUsd(p, usdThb)
                const isCash = p.assetClass === 'cash'
                const expanded = open === p.ticker
                return (
                  <Fragment key={p.ticker}>
                    <tr
                      className="cursor-pointer border-b border-hairline hover:bg-surface-2"
                      onClick={() => !isCash && setOpen(expanded ? null : p.ticker)}
                      aria-expanded={expanded}
                    >
                      <Td className="text-ink-3">{!isCash && (expanded ? '▾' : '▸')}</Td>
                      <Td>
                        <span className="font-semibold text-ink">{p.ticker}</span>
                        <span className="ml-2 hidden text-ink-3 lg:inline">{p.company}</span>
                        <span className="ml-2 inline-flex gap-1"><StrategyTag strategy={p.strategy} /></span>
                      </Td>
                      <Td align="right">{isCash ? '—' : fmtQty(p.shares)}</Td>
                      <Td align="right">{isCash ? '—' : localMoney(p.avgCost, p.currency)}</Td>
                      <Td align="right">{isCash ? '—' : localMoney(p.currentPrice, p.currency)}</Td>
                      <Td align="right">
                        <span className="font-medium text-ink">{fmtUsd(usd)}</span>
                        {p.currency === 'THB' && (
                          <span className="ml-1.5 text-[11px] text-ink-3" title={`Converted at ${usdThb} THB/USD`}>
                            {fmtThb(p.currentValue)}
                          </span>
                        )}
                      </Td>
                      <Td align="right">{((usd / totalUsd) * 100).toFixed(1)}%</Td>
                      <Td align="right">
                        {isCash ? (
                          <span className="text-ink-3">—</span>
                        ) : (
                          <Delta usd={pnl} pct={cost !== 0 ? pnl / cost : undefined} />
                        )}
                      </Td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-hairline bg-surface-2/40">
                        <td />
                        <td colSpan={7} className="px-3 py-3">
                          <div className="grid grid-cols-1 gap-4 text-[13px] leading-5 md:grid-cols-3">
                            <div>
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Thesis</div>
                              {/* GAP #7: thesis-memory needs an export/API; today this text
                                  only exists inside the briefing markdown + SQLite. */}
                              <p className="text-ink-2">Thesis summary from thesis-memory…</p>
                              <a href={`/portfolio/theses?ticker=${p.ticker}`} className="text-accent">Full thesis history →</a>
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Risk</div>
                              <p className="text-ink-2">Weight, vol, β, correlation from risk.json.</p>
                              <a href={`/portfolio/risk?ticker=${p.ticker}`} className="text-accent">Risk detail →</a>
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Activity</div>
                              <p className="text-ink-2">Recent trades from the trade log; wash-sale window if active.</p>
                              <span className="tnum text-ink-3">updated {p.updatedAt.slice(0, 10)}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          )
        })}
        <tfoot>
          <tr>
            <td colSpan={5} className="px-3 py-2 text-[13px] font-semibold text-ink">Total</td>
            <td className="tnum px-3 py-2 text-right text-[14px] font-semibold text-ink">{fmtUsd(totalUsd)}</td>
            <td className="tnum px-3 py-2 text-right text-[12px] text-ink-3">100%</td>
            <td className="tnum px-3 py-2 text-right">
              <Delta usd={positions.reduce((s, p) => s + pnlUsd(p, usdThb), 0)} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// Avg cost / price are per-share unit prices, so precision scales with the
// currency's nominal range: whole dollars read cleanly for high-nominal US
// names (design intent — $1,805, not $1,805.00), while THB names need
// decimals to stay meaningful (SCB ฿131.22, HMPRO ฿6.66).
const localMoney = (v: number, ccy: 'USD' | 'THB') =>
  ccy === 'THB' ? fmtThbPrice(v) : fmtUsd(v, { cents: v < 100 })
