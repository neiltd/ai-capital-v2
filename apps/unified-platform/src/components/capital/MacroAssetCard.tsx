import type { MarketAsset } from '@/types'

function formatValue(asset: MarketAsset): string {
  const isRate = asset.category === 'rates'
  if (isRate) return `${asset.close.toFixed(2)}%`
  if (asset.ticker === '^VIX') return asset.close.toFixed(2)
  if (asset.close > 100) return `${asset.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return asset.close.toFixed(4)
}

function formatChange(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function changeColor(pct: number): string {
  if (pct > 0.05)  return 'text-green-signal'
  if (pct < -0.05) return 'text-red-signal'
  return 'text-text-muted'
}

const TREND_META: Record<string, { arrow: string; color: string; bg: string; gradient: string }> = {
  rising:  { arrow: '↑', color: 'text-green-signal', bg: 'bg-green-signal/10', gradient: 'bg-gradient-card-up' },
  falling: { arrow: '↓', color: 'text-red-signal',   bg: 'bg-red-signal/10',   gradient: 'bg-gradient-card-dn' },
  stable:  { arrow: '→', color: 'text-text-muted',   bg: 'bg-bg-elevated',     gradient: '' },
}

/**
 * Tiny sparkline derived from the three change points (-30d → -5d → -1d → now).
 * Pure SVG, no library. Color follows trend direction.
 */
function Sparkline({ asset }: { asset: MarketAsset }) {
  // Reconstruct relative price path from the change percentages.
  // close = base * (1 + ch_now); -1d ≈ base * (1 + ch_now - ch_1d), etc.
  const c1 = asset.changePct1d / 100
  const c5 = asset.changePct5d / 100
  const c30 = asset.changePct30d / 100
  // Pseudo-prices (anchored at 1.0 then scaled — only the shape matters)
  const points = [
    1 - c30,
    1 - c5,
    1 - c1,
    1,
  ]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const W = 100
  const H = 28
  const path = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W
    const y = H - ((p - min) / range) * H
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const overallChange = asset.changePct30d
  const stroke =
    overallChange > 0.05 ? '#4ade80' :
    overallChange < -0.05 ? '#f87171' : '#94a3b8'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-7" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`spark-${asset.ticker}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${W},${H} L0,${H} Z`} fill={`url(#spark-${asset.ticker})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function MacroAssetCard({ asset }: { asset: MarketAsset }) {
  const trend = TREND_META[asset.trend] ?? TREND_META.stable

  return (
    <div className={`relative bg-bg-card ${trend.gradient} border border-border-subtle rounded-xl p-3 flex flex-col gap-2 transition-all hover:border-border-default hover:shadow-card-hover`}>
      {/* Header row: category + trend pill */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-text-inactive">
          {asset.category}
        </span>
        <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-[11px] font-bold ${trend.bg} ${trend.color}`}>
          {trend.arrow}
        </span>
      </div>

      {/* Ticker + label */}
      <div>
        <div className="text-[12px] font-semibold text-text-primary leading-tight tracking-tight">
          {asset.label}
        </div>
        <div className="text-[15px] font-bold text-text-primary mt-0.5 tabular-nums leading-none">
          {formatValue(asset)}
        </div>
      </div>

      {/* Sparkline */}
      <Sparkline asset={asset} />

      {/* Multi-horizon changes */}
      <div className="flex justify-between gap-1 text-[10px] tabular-nums">
        <div className="flex flex-col items-start">
          <span className="text-text-faint">1d</span>
          <span className={`font-medium ${changeColor(asset.changePct1d)}`}>{formatChange(asset.changePct1d)}</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-text-faint">5d</span>
          <span className={`font-medium ${changeColor(asset.changePct5d)}`}>{formatChange(asset.changePct5d)}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-text-faint">30d</span>
          <span className={`font-medium ${changeColor(asset.changePct30d)}`}>{formatChange(asset.changePct30d)}</span>
        </div>
      </div>
    </div>
  )
}
