import type { PortfolioPosition, AssetClass } from '@/types'
import { Card, CardHeader } from './ui/Card'

interface PortfolioOverviewProps {
  positions: PortfolioPosition[]
  usdThb: number
}

interface BucketMeta {
  label: string
  hex: string
}

const BUCKET_ORDER: AssetClass[] = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']

const BUCKETS: Record<AssetClass, BucketMeta> = {
  us_equity: { label: 'US Equities',   hex: '#a5b4fc' },
  th_equity: { label: 'Thai Equities', hex: '#4ade80' },
  th_fund:   { label: 'Asian Funds',   hex: '#fbbf24' },
  gold:      { label: 'Gold',          hex: '#fde047' },
  cash:      { label: 'Cash',          hex: '#64748b' },
}

function classOf(p: PortfolioPosition): AssetClass {
  return p.assetClass ?? 'us_equity'
}

function currencyOf(p: PortfolioPosition): 'USD' | 'THB' {
  return p.currency ?? 'USD'
}

/** Convert an amount in the position's native currency into USD. */
function toUsd(amount: number, currency: 'USD' | 'THB', usdThb: number): number {
  if (currency === 'USD') return amount
  if (!usdThb || usdThb <= 0) return 0
  return amount / usdThb
}

/** Value of a position in USD. Cash uses `shares` as the cash amount; others use price * shares. */
function positionUsdValue(p: PortfolioPosition, usdThb: number): number {
  const cls = classOf(p)
  const cur = currencyOf(p)
  if (cls === 'cash') return toUsd(p.shares, cur, usdThb)
  const price = p.currentPrice > 0 ? p.currentPrice : p.avgCost
  return toUsd(price * p.shares, cur, usdThb)
}

/**
 * Calculate the SVG arc path for a donut slice.
 * cx, cy: center · rOuter, rInner: radii · startAngle, endAngle: degrees from 12 o'clock (clockwise).
 */
function donutSlice(
  cx: number, cy: number,
  rOuter: number, rInner: number,
  startAngle: number, endAngle: number,
): string {
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const x1 = cx + rOuter * Math.cos(toRad(startAngle))
  const y1 = cy + rOuter * Math.sin(toRad(startAngle))
  const x2 = cx + rOuter * Math.cos(toRad(endAngle))
  const y2 = cy + rOuter * Math.sin(toRad(endAngle))
  const x3 = cx + rInner * Math.cos(toRad(endAngle))
  const y3 = cy + rInner * Math.sin(toRad(endAngle))
  const x4 = cx + rInner * Math.cos(toRad(startAngle))
  const y4 = cy + rInner * Math.sin(toRad(startAngle))
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ')
}

/** True if a position has no meaningful live P&L (cash, or funds where current == cost). */
function hasNoLivePnl(p: PortfolioPosition): boolean {
  const cls = classOf(p)
  if (cls === 'cash') return true
  if (p.currentPrice <= 0) return true
  if (p.currentPrice === p.avgCost) return true
  return false
}

export function PortfolioOverview({ positions, usdThb }: PortfolioOverviewProps) {
  // ---- Aggregate USD value per bucket. ----
  const totals: Record<AssetClass, number> = {
    us_equity: 0, th_equity: 0, th_fund: 0, gold: 0, cash: 0,
  }
  for (const p of positions) {
    totals[classOf(p)] += positionUsdValue(p, usdThb)
  }
  const totalUsd = BUCKET_ORDER.reduce((s, k) => s + totals[k], 0)
  const fmtUsd = (v: number) =>
    `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  // ---- Build donut slices. ----
  const cx = 110
  const cy = 110
  const rOuter = 95
  const rInner = 62
  let angle = 0
  const slices = BUCKET_ORDER
    .filter(k => totals[k] > 0)
    .map(k => {
      const pct = totalUsd > 0 ? (totals[k] / totalUsd) * 100 : 0
      const start = angle
      const sweep = (pct / 100) * 360
      const end = start + Math.min(sweep, 359.999)
      angle = end
      return { key: k, pct, start, end, value: totals[k] }
    })

  // ---- Build ranked holdings list (descending by USD value). ----
  interface Row {
    p: PortfolioPosition
    usd: number
    cls: AssetClass
    pct: number
    pnlPct: number | null
  }
  const rows: Row[] = positions
    .map(p => {
      const cls = classOf(p)
      const usd = positionUsdValue(p, usdThb)
      const pct = totalUsd > 0 ? (usd / totalUsd) * 100 : 0
      const pnlPct = hasNoLivePnl(p)
        ? null
        : ((p.currentPrice - p.avgCost) / p.avgCost) * 100
      return { p, usd, cls, pct, pnlPct }
    })
    .filter(r => r.usd > 0)
    .sort((a, b) => b.usd - a.usd)

  if (totalUsd === 0) {
    return (
      <Card>
        <CardHeader title="Portfolio Overview" meta="no holdings" />
        <div className="p-6 text-[12px] text-text-inactive">
          No positions to display.
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Portfolio Overview"
        meta={`${positions.length} positions · ${fmtUsd(totalUsd)} total`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 p-4">
        {/* Left column: Donut + legend (40% on lg) */}
        <div className="lg:col-span-2 flex flex-col items-center gap-4 py-2">
          <svg width="220" height="220" viewBox="0 0 220 220" className="flex-shrink-0">
            {/* Track */}
            <circle
              cx={cx}
              cy={cy}
              r={(rOuter + rInner) / 2}
              fill="none"
              stroke="#1c1f26"
              strokeWidth={rOuter - rInner}
            />
            {slices.map(s => (
              <path
                key={s.key}
                d={donutSlice(cx, cy, rOuter, rInner, s.start, s.end)}
                fill={BUCKETS[s.key].hex}
                opacity={0.92}
              />
            ))}
            {/* Separator rings */}
            <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="#0f1116" strokeWidth={1} />
            <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke="#0f1116" strokeWidth={1} />
            {/* Center label */}
            <text
              x={cx}
              y={cy - 6}
              textAnchor="middle"
              style={{ fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', fill: '#94a3b8' }}
            >
              Total
            </text>
            <text
              x={cx}
              y={cy + 14}
              textAnchor="middle"
              style={{ fontSize: '18px', fontWeight: 600, fill: '#e2e8f0' }}
            >
              {fmtUsd(totalUsd)}
            </text>
            <text
              x={cx}
              y={cy + 30}
              textAnchor="middle"
              style={{ fontSize: '9px', letterSpacing: '0.08em', fill: '#64748b' }}
            >
              USD
            </text>
          </svg>

          {/* Legend: swatch | label | value | percent */}
          <div className="w-full flex flex-col gap-1.5">
            {BUCKET_ORDER.map(k => {
              const v = totals[k]
              const pct = totalUsd > 0 ? (v / totalUsd) * 100 : 0
              const meta = BUCKETS[k]
              return (
                <div
                  key={k}
                  className="flex items-center gap-2 text-[11px] px-1"
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: meta.hex }}
                  />
                  <span className="text-text-secondary truncate flex-1">
                    {meta.label}
                  </span>
                  <span className="text-text-inactive tabular-nums">
                    {fmtUsd(v)}
                  </span>
                  <span className="text-text-primary font-semibold tabular-nums w-12 text-right">
                    {pct.toFixed(1)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right column: Ranked holdings table (60% on lg) */}
        <div className="lg:col-span-3 min-w-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.12em] text-text-muted border-b border-border-subtle">
                  <th className="text-left font-medium py-2 px-2">Ticker</th>
                  <th className="text-right font-medium py-2 px-2">Value (USD)</th>
                  <th className="text-right font-medium py-2 px-2">% Port</th>
                  <th className="text-right font-medium py-2 px-2">P&amp;L %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const color = BUCKETS[r.cls].hex
                  const pnlNode =
                    r.pnlPct === null ? (
                      <span className="text-text-muted">—</span>
                    ) : (
                      <span
                        className={
                          r.pnlPct >= 0 ? 'text-green-signal' : 'text-red-signal'
                        }
                      >
                        {r.pnlPct >= 0 ? '+' : ''}
                        {r.pnlPct.toFixed(1)}%
                      </span>
                    )
                  return (
                    <tr
                      key={r.p.ticker}
                      className="border-b border-border-subtle/60 last:border-b-0"
                      style={{ height: '34px' }}
                    >
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-text-secondary truncate">
                            {r.p.ticker}
                          </span>
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-right text-text-primary">
                        {fmtUsd(r.usd)}
                      </td>
                      <td className="py-1.5 px-2 text-right text-text-secondary">
                        {r.pct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-2 text-right font-medium">
                        {pnlNode}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  )
}
