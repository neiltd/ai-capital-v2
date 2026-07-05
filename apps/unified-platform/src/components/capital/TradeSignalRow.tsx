import type { TradeAction } from '@/types'
import { Badge, signalTone } from './ui/Badge'
import { RiskGeometryBar } from './ui/RiskGeometryBar'
import { Sparkline } from './ui/Sparkline'

const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

function confColor(c: number): string {
  if (c >= 75) return 'text-green-signal'
  if (c >= 50) return 'text-amber-signal'
  return 'text-red-signal'
}

function confBarColor(c: number): string {
  if (c >= 75) return 'bg-green-signal'
  if (c >= 50) return 'bg-amber-signal'
  return 'bg-red-signal'
}

export function TradeSignalRow({ action, sparkValues }: { action: TradeAction; sparkValues?: number[] }) {
  return (
    <tr className="border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors">
      <td className="px-4 py-3 text-[13px] font-semibold text-indigo-active tracking-tight">
        {action.ticker}
      </td>
      <td className="px-4 py-3">
        <Badge tone={signalTone(action.signal)} size="sm" uppercase>
          {action.signal}
        </Badge>
      </td>
      <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums">
        Wave {action.currentWave ?? '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-12 h-1 rounded-full bg-bg-elevated overflow-hidden">
            <div
              className={`h-full ${confBarColor(action.confidence)} transition-all`}
              style={{ width: `${Math.min(action.confidence, 100)}%` }}
            />
          </div>
          <span className={`text-[11px] font-semibold tabular-nums ${confColor(action.confidence)}`}>
            {action.confidence}%
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums">
        {action.riskReward != null ? `${action.riskReward.toFixed(1)}×` : <span className="text-text-faint">—</span>}
      </td>
      <td className="px-4 py-3">
        {action.entryZone && action.stopLoss != null ? (
          <RiskGeometryBar
            stopLoss={action.stopLoss}
            entryLow={action.entryZone.low}
            entryHigh={action.entryZone.high}
            target={action.target}
            isShort={action.signal === 'sell'}
          />
        ) : (
          <span className="text-text-faint text-[11px]">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-[11px] text-text-muted tabular-nums whitespace-nowrap">
        {action.entryZone
          ? `${USD(action.entryZone.low)} – ${USD(action.entryZone.high)}`
          : <span className="text-text-faint">—</span>}
      </td>
      <td className="px-4 py-3 text-[11px] tabular-nums">
        {action.stopLoss != null
          ? <span className="text-red-signal">{USD(action.stopLoss)}</span>
          : <span className="text-text-faint">—</span>}
      </td>
      <td className="px-4 py-3 text-[11px] tabular-nums">
        {action.target != null
          ? <span className="text-blue-signal">{USD(action.target)}</span>
          : <span className="text-text-faint">—</span>}
      </td>
      <td className="px-4 py-3">
        {sparkValues && sparkValues.length >= 2 ? (
          <Sparkline values={sparkValues} width={64} height={22} />
        ) : (
          <span className="text-text-faint text-[11px]">—</span>
        )}
      </td>
    </tr>
  )
}
