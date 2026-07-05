import type { TradePosition } from '@/types'
import { Badge, signalTone } from './ui/Badge'

const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

function ProgressToTarget({ position }: { position: TradePosition }) {
  const { entryPrice, target, shares, pnl, signal } = position
  if (pnl == null || !shares || target == null) return <span className="text-text-faint text-[11px]">—</span>

  const isShort = signal === 'sell'
  const priceMove = pnl / shares
  const currentPrice = isShort ? entryPrice - priceMove : entryPrice + priceMove
  const span = target - entryPrice || 1
  const rawPct = ((currentPrice - entryPrice) / span) * 100
  const pct = Math.max(0, Math.min(100, rawPct))

  return (
    <div className="w-20">
      <div className="h-1 rounded-full bg-bg-elevated overflow-hidden">
        <div
          className={`h-full ${pct >= 100 ? 'bg-green-signal' : 'bg-indigo-active'} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[9px] text-text-inactive mt-0.5 tabular-nums">{pct.toFixed(0)}%</div>
    </div>
  )
}

export function TradePositionRow({ position }: { position: TradePosition }) {
  const pnl = position.pnl
  const pnlPos = pnl != null && pnl >= 0
  const pnlColor =
    pnl == null ? 'text-text-muted' :
    pnlPos ? 'text-green-signal' : 'text-red-signal'
  const pnlArrow = pnl == null ? '' : pnlPos ? '▲' : '▼'

  return (
    <tr className="border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors">
      <td className="px-4 py-3 text-[13px] font-semibold text-indigo-active tracking-tight">
        {position.ticker}
      </td>
      <td className="px-4 py-3">
        <Badge tone={signalTone(position.signal)} size="sm" uppercase>
          {position.signal}
        </Badge>
      </td>
      <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums">{USD(position.entryPrice)}</td>
      <td className="px-4 py-3 text-[12px] text-red-signal tabular-nums">{USD(position.stopLoss)}</td>
      <td className="px-4 py-3 text-[12px] text-blue-signal tabular-nums">{USD(position.target)}</td>
      <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums">{position.shares}</td>
      <td className={`px-4 py-3 text-[12px] font-semibold tabular-nums ${pnlColor}`}>
        {pnl == null ? (
          <span className="text-text-faint">—</span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-[9px]">{pnlArrow}</span>
            {pnlPos ? '+' : ''}{USD(pnl)}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <ProgressToTarget position={position} />
      </td>
    </tr>
  )
}
