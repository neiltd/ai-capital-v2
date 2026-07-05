interface Props {
  values: number[]
  width?: number
  height?: number
  color?: string
}

/**
 * Minimal trend line — same normalize-and-path approach already used inline
 * in WaveCard, extracted here so any table/card can reuse it (e.g. a 30-day
 * price column) without re-deriving the SVG math each time.
 */
export function Sparkline({ values, width = 64, height = 24, color }: Props) {
  if (values.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center text-[9px] text-text-faint">—</div>
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const coords = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - ((v - min) / range) * height,
  }))
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')

  const trendUp = values[values.length - 1] >= values[0]
  const stroke = color ?? (trendUp ? '#22c55e' : '#ef4444')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
