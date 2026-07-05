'use client'

import { useState } from 'react'
import type { PortfolioPosition, SimulationScenario, ScenarioAction, AssetClass } from '@/types'
import { Card, CardHeader } from './ui/Card'
import { Badge, type BadgeTone } from './ui/Badge'

interface Props {
  positions: PortfolioPosition[]
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
  /** USD/THB rate (THB per 1 USD). Used for portfolio % normalization. */
  usdThb?: number | null
}

type SortCol = 'ticker' | 'shares' | 'avgCost' | 'currentPrice' | 'holdingValue' | 'portPct' | 'pnl' | 'pnlPct' | 'recommendation'
type SortDir = 'asc' | 'desc'

const ACTION_META: Record<string, { tone: BadgeTone; label: string }> = {
  buy:  { tone: 'success', label: 'Buy'  },
  hold: { tone: 'warning', label: 'Hold' },
  trim: { tone: 'warning', label: 'Trim' },
  exit: { tone: 'danger',  label: 'Exit' },
}

const CONVICTION_LABEL: Record<string, string> = {
  high: 'High conviction', medium: 'Medium conviction', low: 'Low conviction',
}

const ACTION_SORT_ORDER: Record<string, number> = { buy: 0, hold: 1, trim: 2, exit: 3 }

// Section ordering and metadata.
const SECTION_ORDER: AssetClass[] = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']

const SECTION_META: Record<AssetClass, { title: string; subtitle: string; estimate?: boolean }> = {
  us_equity: { title: 'US Equities',  subtitle: 'Priced in USD'                                                  },
  th_equity: { title: 'Thai Equities', subtitle: 'Priced in THB (SET)'                                           },
  th_fund:   { title: 'Asian Funds',   subtitle: 'NAV in THB · est. via index proxy',                estimate: true },
  gold:      { title: 'Gold',          subtitle: 'THB per baht-weight · directional proxy via GC=F', estimate: true },
  cash:      { title: 'Cash',          subtitle: 'No price fetch'                                              },
}

function getClass(p: PortfolioPosition): AssetClass {
  return p.assetClass ?? 'us_equity'
}

function currencyOf(p: PortfolioPosition): 'USD' | 'THB' {
  return p.currency ?? 'USD'
}

function fmtMoney(amount: number, currency: 'USD' | 'THB', opts: { decimals?: number } = {}): string {
  const d = opts.decimals ?? 2
  const symbol = currency === 'THB' ? '฿' : '$'
  const sign = amount < 0 ? '-' : ''
  return `${sign}${symbol}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}

/** Convert a position's amount in its native currency into USD. Returns 0 if FX missing. */
function toUsd(amount: number, currency: 'USD' | 'THB', usdThb: number | null): number {
  if (currency === 'USD') return amount
  if (!usdThb || usdThb <= 0) return 0
  return amount / usdThb
}

export function PortfolioTable({ positions, scenarios, actions, usdThb = null }: Props) {
  const [sortCol, setSortCol] = useState<SortCol>('ticker')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [tooltipTicker, setTooltipTicker] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<AssetClass, boolean>>({
    us_equity: false, th_equity: false, th_fund: false, gold: false, cash: false,
  })

  const baseScenario = scenarios.find(s => s.scenarioType === 'base')
  const baseActions: Record<string, ScenarioAction> = {}
  if (baseScenario) {
    for (const a of actions) {
      if (a.scenarioId === baseScenario.id) baseActions[a.ticker] = a
    }
  }

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  function sortPositions(list: PortfolioPosition[]): PortfolioPosition[] {
    return [...list].sort((a, b) => {
      const pnlA = (a.currentPrice - a.avgCost) * a.shares
      const pnlB = (b.currentPrice - b.avgCost) * b.shares
      const pnlPctA = a.avgCost === 0 ? 0 : ((a.currentPrice - a.avgCost) / a.avgCost) * 100
      const pnlPctB = b.avgCost === 0 ? 0 : ((b.currentPrice - b.avgCost) / b.avgCost) * 100

      let cmp = 0
      switch (sortCol) {
        case 'ticker':         cmp = a.ticker.localeCompare(b.ticker); break
        case 'shares':         cmp = a.shares - b.shares; break
        case 'avgCost':        cmp = a.avgCost - b.avgCost; break
        case 'currentPrice':   cmp = a.currentPrice - b.currentPrice; break
        case 'holdingValue':   cmp = a.currentPrice * a.shares - b.currentPrice * b.shares; break
        case 'portPct':        cmp = a.currentPrice * a.shares - b.currentPrice * b.shares; break
        case 'pnl':            cmp = pnlA - pnlB; break
        case 'pnlPct':         cmp = pnlPctA - pnlPctB; break
        case 'recommendation': {
          const orderA = ACTION_SORT_ORDER[baseActions[a.ticker]?.action ?? 'hold'] ?? 1
          const orderB = ACTION_SORT_ORDER[baseActions[b.ticker]?.action ?? 'hold'] ?? 1
          cmp = orderA - orderB; break
        }
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="text-text-faint ml-1 text-[9px]">↕</span>
    return <span className="text-indigo-active ml-1 text-[9px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function Th({ col, children, right }: { col: SortCol; children: React.ReactNode; right?: boolean }) {
    return (
      <th
        className={`px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive cursor-pointer select-none hover:text-text-secondary transition-colors whitespace-nowrap ${
          right ? 'text-right' : 'text-left'
        }`}
        onClick={() => handleSort(col)}
      >
        {children}<SortIcon col={col} />
      </th>
    )
  }

  // Group positions by asset class.
  const grouped: Record<AssetClass, PortfolioPosition[]> = {
    us_equity: [], th_equity: [], th_fund: [], gold: [], cash: [],
  }
  for (const p of positions) grouped[getClass(p)].push(p)

  // Portfolio-wide total in USD for the % port calculation.
  const totalValueUsd = positions.reduce((sum, p) => {
    const price = p.currentPrice > 0 ? p.currentPrice : 0
    return sum + toUsd(price * p.shares, currencyOf(p), usdThb)
  }, 0)

  const totalPnlUsd = positions.reduce((sum, p) => {
    if (p.currentPrice <= 0) return sum
    return sum + toUsd((p.currentPrice - p.avgCost) * p.shares, currencyOf(p), usdThb)
  }, 0)
  const totalCostUsd = positions.reduce((sum, p) =>
    sum + toUsd(p.avgCost * p.shares, currencyOf(p), usdThb), 0)
  const totalPnlPct = totalCostUsd === 0 ? 0 : (totalPnlUsd / totalCostUsd) * 100
  const pnlTone: BadgeTone = totalPnlUsd >= 0 ? 'success' : 'danger'

  return (
    <Card>
      <CardHeader
        title="Positions"
        meta={`${positions.length} held across ${SECTION_ORDER.filter(c => grouped[c].length > 0).length} class${SECTION_ORDER.filter(c => grouped[c].length > 0).length === 1 ? '' : 'es'}`}
        actions={
          positions.length > 0 ? (
            <Badge tone={pnlTone} size="sm">
              <span className="text-[10px]">{totalPnlUsd >= 0 ? '▲' : '▼'}</span>
              {totalPnlUsd >= 0 ? '+' : ''}${Math.abs(totalPnlUsd).toFixed(2)}
              <span className="opacity-70 ml-1">
                ({totalPnlUsd >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%)
              </span>
            </Badge>
          ) : null
        }
      />

      {SECTION_ORDER.map(cls => {
        const rows = grouped[cls]
        if (rows.length === 0) return null
        const meta = SECTION_META[cls]
        const sorted = sortPositions(rows)
        const isCollapsed = collapsed[cls]

        // Section subtotal in the section's native currency (THB or USD).
        // Cash, gold, th_equity, th_fund are THB; us_equity is USD.
        const sectionCurrency: 'USD' | 'THB' = cls === 'us_equity'
          ? 'USD'
          : sorted[0] ? currencyOf(sorted[0]) : 'THB'

        const sectionValue = sorted.reduce((s, p) => {
          const price = p.currentPrice > 0 ? p.currentPrice : 0
          return s + price * p.shares
        }, 0)
        const sectionCost = sorted.reduce((s, p) => s + p.avgCost * p.shares, 0)
        const sectionPnl  = sorted.reduce((s, p) => {
          if (p.currentPrice <= 0) return s
          return s + (p.currentPrice - p.avgCost) * p.shares
        }, 0)
        const sectionValueUsd = toUsd(sectionValue, sectionCurrency, usdThb)
        const portPct = totalValueUsd > 0 ? (sectionValueUsd / totalValueUsd) * 100 : 0

        return (
          <div key={cls} className="border-t border-border-subtle first:border-t-0">
            <button
              type="button"
              onClick={() => setCollapsed(c => ({ ...c, [cls]: !c[cls] }))}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-card-hover/40 transition-colors text-left"
            >
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-text-faint">
                  {isCollapsed ? '▸' : '▾'}
                </span>
                <span className="text-[13px] font-semibold text-text-primary">{meta.title}</span>
                <span className="text-[11px] text-text-inactive">{rows.length} held</span>
                {meta.estimate && (
                  <Badge tone="warning" size="sm">est.</Badge>
                )}
                <span className="text-[10px] text-text-faint">{meta.subtitle}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[11px] text-text-inactive tabular-nums">
                  {fmtMoney(sectionValue, sectionCurrency, { decimals: 0 })}
                  {sectionCurrency === 'THB' && usdThb !== null && (
                    <span className="text-text-faint ml-1">
                      (≈${sectionValueUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })})
                    </span>
                  )}
                </span>
                {totalValueUsd > 0 && (
                  <span className="text-[10px] text-text-faint tabular-nums w-12 text-right">
                    {portPct.toFixed(1)}%
                  </span>
                )}
                <span className={`text-[11px] tabular-nums font-semibold w-24 text-right ${
                  sectionPnl >= 0 ? 'text-green-signal' : 'text-red-signal'
                }`}>
                  {sectionPnl >= 0 ? '+' : ''}{fmtMoney(sectionPnl, sectionCurrency, { decimals: 0 })}
                </span>
              </div>
            </button>

            {!isCollapsed && (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-bg-subtle border-y border-border-subtle">
                      <Th col="ticker">Ticker</Th>
                      <Th col="shares" right>{cls === 'cash' ? 'Amount' : 'Shares'}</Th>
                      <Th col="avgCost" right>Avg Cost</Th>
                      <Th col="currentPrice" right>Price</Th>
                      <Th col="holdingValue" right>Holding</Th>
                      <Th col="portPct" right>% Port</Th>
                      <Th col="pnl" right>P&L</Th>
                      <Th col="pnlPct" right>P&L %</Th>
                      <Th col="recommendation" right>Signal</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p, idx) => {
                      const cur = currencyOf(p)
                      const holding = p.currentPrice * p.shares
                      const pnl = (p.currentPrice - p.avgCost) * p.shares
                      const pnlPct = p.avgCost === 0 ? 0 : ((p.currentPrice - p.avgCost) / p.avgCost) * 100
                      const isPos = pnl >= 0
                      const arrow = isPos ? '▲' : '▼'
                      const baseAction = baseActions[p.ticker]
                      const actionMeta = baseAction ? ACTION_META[baseAction.action] : null
                      const holdingUsd = toUsd(holding, cur, usdThb)
                      const portPctRow = totalValueUsd > 0 && p.currentPrice > 0
                        ? (holdingUsd / totalValueUsd) * 100
                        : null
                      const noPrice = p.currentPrice === 0 || cls === 'cash'

                      return (
                        <tr
                          key={p.ticker}
                          className={`border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors ${
                            idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''
                          }`}
                        >
                          <td className="px-4 py-3 text-[13px] font-semibold text-indigo-active tracking-tight">
                            {p.ticker}
                            {p.priceSymbol && p.priceSymbol !== p.ticker && cls !== 'cash' && (
                              <span className="ml-2 text-[10px] text-text-faint font-normal">via {p.priceSymbol}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                            {cls === 'cash' ? fmtMoney(p.shares, cur, { decimals: 0 }) : p.shares}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                            {cls === 'cash' ? '—' : fmtMoney(p.avgCost, cur)}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                            {p.currentPrice === 0 ? (
                              <span className="text-text-faint">—</span>
                            ) : cls === 'cash' ? (
                              '1.00'
                            ) : (
                              <span className="inline-flex items-center justify-end gap-1.5">
                                {fmtMoney(p.currentPrice, cur)}
                                {cls === 'th_fund' && p.currentPrice === p.avgCost && (
                                  <Badge tone="warning" size="xs">est.</Badge>
                                )}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums font-medium">
                            {noPrice && cls !== 'cash'
                              ? <span className="text-text-faint">—</span>
                              : (
                                <>
                                  {fmtMoney(cls === 'cash' ? p.shares : holding, cur, { decimals: 0 })}
                                  {cur === 'THB' && usdThb !== null && (
                                    <div className="text-[10px] text-text-faint font-normal">
                                      ≈ ${(cls === 'cash' ? toUsd(p.shares, cur, usdThb) : holdingUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                    </div>
                                  )}
                                </>
                              )}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-text-faint text-right tabular-nums">
                            {portPctRow === null ? '—' : `${portPctRow.toFixed(1)}%`}
                          </td>
                          <td className={`px-4 py-3 text-[12px] text-right font-semibold tabular-nums ${isPos ? 'text-green-signal' : 'text-red-signal'}`}>
                            {noPrice ? (
                              <span className="text-text-faint">—</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 justify-end">
                                <span className="text-[9px]">{arrow}</span>
                                {isPos ? '+' : ''}{fmtMoney(pnl, cur)}
                              </span>
                            )}
                          </td>
                          <td className={`px-4 py-3 text-[12px] text-right font-semibold tabular-nums ${isPos ? 'text-green-signal' : 'text-red-signal'}`}>
                            {noPrice
                              ? <span className="text-text-faint">—</span>
                              : `${isPos ? '+' : ''}${pnlPct.toFixed(1)}%`}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {actionMeta && baseAction ? (
                              <div className="relative inline-block">
                                <button
                                  className="cursor-help"
                                  onMouseEnter={() => { setTooltip(baseAction.rationale); setTooltipTicker(p.ticker) }}
                                  onMouseLeave={() => { setTooltip(null); setTooltipTicker(null) }}
                                >
                                  <Badge tone={actionMeta.tone} size="sm">
                                    {actionMeta.label}
                                    <span className="opacity-70 ml-0.5">· {baseAction.conviction}</span>
                                  </Badge>
                                </button>
                                {tooltipTicker === p.ticker && tooltip && (
                                  <div className="absolute right-0 bottom-full mb-2 w-72 bg-bg-elevated border border-border-default rounded-lg p-3 text-[11px] text-text-secondary z-10 text-left shadow-card-hover">
                                    <div className="text-[10px] font-semibold text-indigo-active mb-1.5 uppercase tracking-wider">
                                      Base scenario · {baseAction.conviction ? CONVICTION_LABEL[baseAction.conviction] ?? baseAction.conviction : ''}
                                    </div>
                                    <div className="leading-relaxed">{tooltip}</div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-text-faint text-[10px]">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}
