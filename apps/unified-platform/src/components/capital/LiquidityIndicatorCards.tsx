import type { LiquidityIndicator } from '@/types'
import { Card, CardHeader } from './ui/Card'
import { Badge, signalTone } from './ui/Badge'

function fmt(n: number | null, suffix = ''): { text: string; arrow: string; color: string } {
  if (n == null) return { text: '—', arrow: '', color: 'text-text-faint' }
  const sign = n >= 0 ? '+' : ''
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '◆'
  const color = n > 0 ? 'text-green-signal' : n < 0 ? 'text-red-signal' : 'text-text-muted'
  return { text: `${sign}${n.toFixed(1)}${suffix}`, arrow, color }
}

function DeltaStat({ label, delta }: { label: string; delta: { text: string; arrow: string; color: string } }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] text-text-faint uppercase tracking-wide">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums inline-flex items-center gap-0.5 ${delta.color}`}>
        {delta.arrow && <span className="text-[8px]">{delta.arrow}</span>}
        {delta.text}
      </span>
    </div>
  )
}

function LiquidityTile({ ind }: { ind: LiquidityIndicator }) {
  const c4w = fmt(ind.change4w, '%')
  const cYoY = fmt(ind.changeYoY, '%')

  return (
    <div className="bg-bg-elevated border border-border-subtle rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium text-text-secondary leading-tight">{ind.label}</span>
        <Badge tone={signalTone(ind.signal)} size="xs" uppercase>{ind.signal}</Badge>
      </div>
      <div className="text-[15px] font-bold text-text-primary tabular-nums leading-none">
        {ind.value.toLocaleString('en-US', { maximumFractionDigits: 1 })}
        <span className="text-text-inactive text-[10px] font-normal ml-1">{ind.unit}</span>
      </div>
      <div className="flex justify-between gap-2">
        <DeltaStat label="4-Week" delta={c4w} />
        <DeltaStat label="YoY" delta={cYoY} />
      </div>
      <div className="text-[9px] text-text-inactive tabular-nums">released {ind.releaseDate}</div>
    </div>
  )
}

export function LiquidityIndicatorCards({ indicators }: { indicators: LiquidityIndicator[] }) {
  if (!indicators?.length) return null

  return (
    <Card>
      <CardHeader title="Liquidity" meta={`${indicators.length} series`} />
      <div className="p-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {indicators.map(ind => (
          <LiquidityTile key={ind.seriesId} ind={ind} />
        ))}
      </div>
    </Card>
  )
}
