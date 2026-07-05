import type { TradeAction } from '@/types'

export function TradePlanCard({ action }: { action: TradeAction }) {
  if (action.signal === 'no-signal') return null

  const signalColor =
    action.signal === 'buy'   ? '#22c55e' :
    action.signal === 'sell'  ? '#ef4444' : '#f59e0b'

  const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-2">Trade Plan</h2>
      <div className="bg-[#111318] border border-[#23252a] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-wide rounded px-2 py-0.5"
            style={{ background: signalColor + '22', color: signalColor }}>
            {action.signal.toUpperCase()}
          </span>
          {action.riskReward != null && (
            <span className="text-[11px] rounded px-2 py-0.5"
              style={{ background: '#f59e0b22', color: '#f59e0b' }}>
              R:R {action.riskReward.toFixed(1)}×
            </span>
          )}
          <span className="text-[11px] text-[#8a8f98]">
            Wave {action.currentWave} · {action.confidence}% confidence
          </span>
        </div>

        {action.signal !== 'watch' && action.entryZone != null && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="border border-[#22c55e33] rounded p-2" style={{ background: '#22c55e0a' }}>
              <div className="text-[10px] text-[#8a8f98] uppercase">Entry Zone</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: '#22c55e' }}>
                {USD(action.entryZone.low)} – {USD(action.entryZone.high)}
              </div>
            </div>
            <div className="border border-[#ef444433] rounded p-2" style={{ background: '#ef44440a' }}>
              <div className="text-[10px] text-[#8a8f98] uppercase">Stop Loss</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: '#ef4444' }}>
                {action.stopLoss != null ? USD(action.stopLoss) : '—'}
              </div>
            </div>
            <div className="border border-[#3b82f633] rounded p-2" style={{ background: '#3b82f60a' }}>
              <div className="text-[10px] text-[#8a8f98] uppercase">Target</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: '#3b82f6' }}>
                {action.target != null ? USD(action.target) : '—'}
              </div>
            </div>
          </div>
        )}

        {action.narrative && (
          <p className="text-xs text-[#8a8f98] leading-relaxed">{action.narrative}</p>
        )}
      </div>
    </div>
  )
}
