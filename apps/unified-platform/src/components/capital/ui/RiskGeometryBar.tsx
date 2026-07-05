interface Props {
  stopLoss: number
  entryLow: number
  entryHigh: number
  target: number | null
  isShort?: boolean
}

/**
 * Horizontal stop → entry → target position bar. Purely a visualization of
 * three already-existing prices (no new data) — normalizes them onto a 0-100%
 * scale so the relative distance to stop vs. target reads at a glance.
 */
export function RiskGeometryBar({ stopLoss, entryLow, entryHigh, target, isShort = false }: Props) {
  const entryMid = (entryLow + entryHigh) / 2
  const points = [stopLoss, entryLow, entryHigh, target ?? entryMid].filter((n): n is number => n != null)
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const pct = (n: number) => ((n - min) / span) * 100

  const stopPct = pct(stopLoss)
  const entryLowPct = pct(entryLow)
  const entryHighPct = pct(entryHigh)
  const targetPct = target != null ? pct(target) : null

  // Risk zone runs from stop to entry-mid; reward zone runs from entry-mid to target.
  // For shorts the color meaning flips (stop is above entry, target below).
  const riskFrom = isShort ? entryLowPct : stopPct
  const riskTo = isShort ? stopPct : entryLowPct
  const rewardFrom = isShort ? (targetPct ?? entryHighPct) : entryHighPct
  const rewardTo = isShort ? entryHighPct : (targetPct ?? entryHighPct)

  return (
    <div className="w-[140px]">
      <div className="relative h-1.5 rounded-full bg-bg-elevated overflow-hidden">
        <div
          className="absolute inset-y-0 bg-red-signal/50"
          style={{ left: `${Math.min(riskFrom, riskTo)}%`, width: `${Math.abs(riskTo - riskFrom)}%` }}
        />
        {targetPct != null && (
          <div
            className="absolute inset-y-0 bg-green-signal/50"
            style={{ left: `${Math.min(rewardFrom, rewardTo)}%`, width: `${Math.abs(rewardTo - rewardFrom)}%` }}
          />
        )}
        <div
          className="absolute inset-y-[-2px] w-0.5 bg-indigo-active"
          style={{ left: `${(entryLowPct + entryHighPct) / 2}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] tabular-nums mt-1">
        <span className="text-red-signal">{stopLoss.toFixed(2)}</span>
        <span className="text-text-inactive">↔ {entryMid.toFixed(2)}</span>
        <span className="text-green-signal">{target != null ? target.toFixed(2) : '—'}</span>
      </div>
    </div>
  )
}
