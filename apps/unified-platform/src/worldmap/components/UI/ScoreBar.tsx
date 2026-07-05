import type { Indicator } from '../../types/country'

interface Props {
  label: string
  indicator: Indicator
}

const trendSymbol: Record<string, string> = {
  rising:    '↑',
  improving: '↑',
  stable:    '→',
  declining: '↓',
}

const trendColor: Record<string, string> = {
  rising:    'text-red-400',
  declining: 'text-red-400',
  improving: 'text-emerald-400',
  stable:    'text-text-muted',
}

const confidenceColor: Record<string, string> = {
  high:   'text-emerald-500',
  medium: 'text-amber-500',
  low:    'text-red-500',
}

// Score colour: red (1-3), amber (4-6), green (7-10)
function scoreColor(score: number) {
  if (score >= 7) return 'bg-emerald-500'
  if (score >= 4) return 'bg-amber-500'
  return 'bg-red-500'
}

export default function ScoreBar({ label, indicator }: Props) {
  const { score, trend, confidence, note } = indicator
  const pct = (score / 10) * 100

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-secondary font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${trendColor[trend]}`}>
            {trendSymbol[trend]} {trend}
          </span>
          <span className={`text-xs ${confidenceColor[confidence]}`}>
            {confidence}
          </span>
          <span className="text-xs font-bold text-white w-4 text-right">{score}</span>
        </div>
      </div>
      <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${scoreColor(score)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {note && (
        <p className="text-xs text-text-muted mt-1 leading-snug">{note}</p>
      )}
    </div>
  )
}
