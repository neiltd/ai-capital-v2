import type { PortfolioPosition, AssetClass } from '@/types'
import { Card, CardHeader } from './ui/Card'

interface AllocationChartProps {
  positions: PortfolioPosition[]
  usdThb: number
}

interface BucketMeta {
  label: string
  // Tailwind class names (for legend swatch)
  swatchClass: string
  // Hex color used inside SVG (donut + bar fills)
  hex: string
}

const BUCKET_ORDER: AssetClass[] = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']

const BUCKETS: Record<AssetClass, BucketMeta> = {
  us_equity: { label: 'US Equities',   swatchClass: 'bg-indigo-active', hex: '#a5b4fc' },
  th_equity: { label: 'Thai Equities', swatchClass: 'bg-green-signal',  hex: '#4ade80' },
  th_fund:   { label: 'Asian Funds',   swatchClass: 'bg-amber-signal',  hex: '#fbbf24' },
  gold:      { label: 'Gold',          swatchClass: 'bg-yellow-300',    hex: '#fde047' },
  cash:      { label: 'Cash',          swatchClass: 'bg-slate-500',     hex: '#64748b' },
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

/** Value of a position in USD. Cash uses `shares` as the THB/USD amount; others use price * shares. */
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

export function AllocationChart({ positions, usdThb }: AllocationChartProps) {
  // Aggregate USD value per bucket.
  const totals: Record<AssetClass, number> = {
    us_equity: 0, th_equity: 0, th_fund: 0, gold: 0, cash: 0,
  }
  for (const p of positions) {
    totals[classOf(p)] += positionUsdValue(p, usdThb)
  }

  const totalUsd = BUCKET_ORDER.reduce((s, k) => s + totals[k], 0)
  const fmtUsd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  // Build slices for the donut.
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
      // Avoid a full-circle slice degenerating into nothing — clamp slightly.
      const end = start + Math.min(sweep, 359.999)
      angle = end
      return { key: k, pct, start, end, value: totals[k] }
    })

  return (
    <Card>
      <CardHeader
        title="Asset Allocation"
        meta={totalUsd > 0 ? `${positions.length} positions · ${fmtUsd(totalUsd)} total` : 'no holdings'}
      />

      {totalUsd === 0 ? (
        <div className="p-6 text-[12px] text-text-inactive">
          No positions to display.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          {/* Donut */}
          <div className="flex items-center justify-center gap-5 py-2">
            <svg width="220" height="220" viewBox="0 0 220 220" className="flex-shrink-0">
              {/* Track */}
              <circle cx={cx} cy={cy} r={(rOuter + rInner) / 2} fill="none" stroke="#1c1f26" strokeWidth={rOuter - rInner} />
              {slices.map(s => (
                <path
                  key={s.key}
                  d={donutSlice(cx, cy, rOuter, rInner, s.start, s.end)}
                  fill={BUCKETS[s.key].hex}
                  opacity={0.92}
                />
              ))}
              {/* Inner separator ring */}
              <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="#0f1116" strokeWidth={1} />
              <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke="#0f1116" strokeWidth={1} />
              {/* Center label */}
              <text
                x={cx} y={cy - 6}
                textAnchor="middle"
                style={{ fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', fill: '#94a3b8' }}
              >
                Total
              </text>
              <text
                x={cx} y={cy + 14}
                textAnchor="middle"
                style={{ fontSize: '18px', fontWeight: 600, fill: '#e2e8f0' }}
              >
                {fmtUsd(totalUsd)}
              </text>
              <text
                x={cx} y={cy + 30}
                textAnchor="middle"
                style={{ fontSize: '9px', letterSpacing: '0.08em', fill: '#64748b' }}
              >
                USD
              </text>
            </svg>

            {/* Legend */}
            <div className="flex flex-col gap-2 min-w-0">
              {BUCKET_ORDER.map(k => {
                const v = totals[k]
                if (v <= 0) return null
                const pct = (v / totalUsd) * 100
                return (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: BUCKETS[k].hex }}
                    />
                    <span className="text-text-secondary tabular-nums w-10">
                      {pct.toFixed(1)}%
                    </span>
                    <span className="text-text-inactive truncate">{BUCKETS[k].label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Horizontal bars */}
          <div className="flex flex-col gap-3 py-2">
            {BUCKET_ORDER.map(k => {
              const v = totals[k]
              const pct = totalUsd > 0 ? (v / totalUsd) * 100 : 0
              const meta = BUCKETS[k]
              return (
                <div key={k}>
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: meta.hex }}
                      />
                      <span className="text-[12px] text-text-secondary truncate">{meta.label}</span>
                    </div>
                    <div className="flex items-baseline gap-3 flex-shrink-0">
                      <span className="text-[11px] text-text-inactive tabular-nums">
                        {fmtUsd(v)}
                      </span>
                      <span className="text-[11px] font-semibold text-text-primary tabular-nums w-12 text-right">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-2 bg-bg-elevated rounded-sm overflow-hidden border border-border-subtle">
                    <div
                      className="h-full rounded-sm transition-all"
                      style={{
                        width: `${Math.max(pct, v > 0 ? 1 : 0)}%`,
                        backgroundColor: meta.hex,
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}
