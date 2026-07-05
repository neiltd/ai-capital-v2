interface Props {
  score: number
  size?: number
  label?: string
}

/**
 * Circular score gauge — green ≥80, amber ≥60, red below.
 * Matches the StatCard/Badge tone convention used elsewhere in capital/ui.
 */
export function ScoreRing({ score, size = 64, label }: Props) {
  const stroke = 5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const pct = Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - pct / 100)

  const color =
    score >= 80 ? 'stroke-green-signal' :
    score >= 60 ? 'stroke-amber-signal' :
    'stroke-red-signal'
  const textColor =
    score >= 80 ? 'text-green-signal' :
    score >= 60 ? 'text-amber-signal' :
    'text-red-signal'

  return (
    <div className="relative inline-flex flex-col items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          strokeWidth={stroke} fill="none"
          className="stroke-border-subtle"
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          strokeWidth={stroke} fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={`${color} transition-[stroke-dashoffset] duration-500`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-bold tabular-nums ${textColor}`} style={{ fontSize: size * 0.3 }}>
          {score}
        </span>
        {label && <span className="text-[8px] text-text-inactive uppercase tracking-wide -mt-0.5">{label}</span>}
      </div>
    </div>
  )
}
