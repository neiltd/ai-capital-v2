import Link from 'next/link'
import type { WaveAsset } from '@/types'
import { Badge } from './ui/Badge'

function waveTone(w: string | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (['1', '3', '5'].includes(w ?? '')) return 'success'
  if (['2', '4'].includes(w ?? '')) return 'warning'
  if (w) return 'danger'
  return 'neutral'
}

function confTone(c: number): 'success' | 'warning' | 'danger' {
  if (c >= 75) return 'success'
  if (c >= 50) return 'warning'
  return 'danger'
}

function confBarColor(c: number): string {
  if (c >= 75) return 'bg-green-signal'
  if (c >= 50) return 'bg-amber-signal'
  return 'bg-red-signal'
}

/**
 * Maps Elliott Wave number → "progress" through the 5-wave cycle.
 * Visual aid: shows where the asset is in its current impulse/corrective.
 */
function waveProgress(currentWave: string | null): { stop: number; total: number } {
  const num = Number(currentWave)
  if (Number.isFinite(num) && num >= 1 && num <= 5) {
    return { stop: num, total: 5 }
  }
  return { stop: 0, total: 5 }
}

export function WaveCard({ asset }: { asset: WaveAsset }) {
  const { ticker, label, source, wavePivots, currentWave, waveDirection, confidence } = asset

  // Build sparkline from wave pivots
  let sparkPath: string | null = null
  let sparkFill: string | null = null
  if (wavePivots.length >= 2) {
    const prices = wavePivots.map(p => p.price)
    const minP = Math.min(...prices), maxP = Math.max(...prices)
    const range = maxP - minP || 1
    const W = 100, H = 36
    const coords = wavePivots.map((p, i) => {
      const x = (i / (wavePivots.length - 1)) * W
      const y = H - ((p.price - minP) / range) * H
      return { x, y }
    })
    sparkPath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
    sparkFill = `${sparkPath} L${W},${H} L0,${H} Z`
  }

  const wLabel = currentWave
    ? `Wave ${currentWave}`
    : 'No count'
  const dirArrow = currentWave ? (waveDirection === 'up' ? '↑' : '↓') : ''

  const progress = waveProgress(currentWave)

  return (
    <Link
      href={`/capital/waves/${encodeURIComponent(ticker)}`}
      className="group block bg-bg-card bg-gradient-card border border-border-subtle rounded-xl p-3 transition-all hover:border-border-default hover:shadow-card-hover"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[14px] font-semibold text-text-primary tracking-tight">{ticker}</span>
            {dirArrow && (
              <span className={`text-[12px] font-bold ${waveDirection === 'up' ? 'text-green-signal' : 'text-red-signal'}`}>
                {dirArrow}
              </span>
            )}
          </div>
          {label !== ticker && (
            <div className="text-[10px] text-text-inactive truncate max-w-[140px]">{label}</div>
          )}
        </div>
        <span className="text-[9px] font-medium uppercase tracking-wider text-text-faint border border-border-subtle rounded px-1.5 py-0.5 bg-bg-elevated">
          {source}
        </span>
      </div>

      {/* Sparkline */}
      {sparkPath ? (
        <svg viewBox="0 0 100 36" className="w-full h-9 mb-2" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`wave-${ticker}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#818cf8" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={sparkFill!} fill={`url(#wave-${ticker})`} />
          <path d={sparkPath} fill="none" stroke="#a5b4fc" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      ) : (
        <div className="w-full h-9 mb-2 flex items-center justify-center text-[10px] text-text-faint">
          no pivot data
        </div>
      )}

      {/* Wave progress dots: 1 - 2 - 3 - 4 - 5 */}
      <div className="flex items-center gap-1 mb-2">
        {[1, 2, 3, 4, 5].map(n => {
          const reached = n <= progress.stop
          const isCurrent = n === progress.stop
          return (
            <div
              key={n}
              className={`flex-1 h-1 rounded-full transition-colors ${
                isCurrent
                  ? waveTone(String(n)) === 'success'
                    ? 'bg-green-signal'
                    : waveTone(String(n)) === 'warning'
                      ? 'bg-amber-signal'
                      : 'bg-accent-primary'
                  : reached
                    ? 'bg-border-strong'
                    : 'bg-border-subtle'
              }`}
            />
          )
        })}
      </div>

      {/* Footer badges */}
      <div className="flex items-center justify-between gap-1.5">
        <Badge tone={waveTone(currentWave)} size="xs">
          {wLabel}
        </Badge>
        {confidence > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-1 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className={`h-full ${confBarColor(confidence)} transition-all`}
                style={{ width: `${Math.min(confidence, 100)}%` }}
              />
            </div>
            <span className={`text-[10px] font-semibold tabular-nums ${
              confTone(confidence) === 'success' ? 'text-green-signal' :
              confTone(confidence) === 'warning' ? 'text-amber-signal' : 'text-red-signal'
            }`}>
              {confidence}%
            </span>
          </div>
        )}
      </div>
    </Link>
  )
}
