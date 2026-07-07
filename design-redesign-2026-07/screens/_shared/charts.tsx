// Lightweight SVG chart primitives — zero dependencies, follow the dataviz
// mark specs (thin marks, 4px rounded data-ends, 2px surface gaps, direct
// labels, one axis, recessive grid). For anything heavier (risk scatter with
// zoom, correlation heatmap) see the per-screen specs.

import type { ReactNode } from 'react'

/* -------------------------------- Sparkline ------------------------------- */

export function Sparkline({
  points,
  width = 96,
  height = 28,
  stroke = 'var(--ink-3)',
}: {
  points: number[]
  width?: number
  height?: number
  stroke?: string
}) {
  if (points.length < 2) return <span className="text-[11px] text-ink-3">—</span>
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = (width - 4) / (points.length - 1)
  const y = (v: number) => 2 + (height - 4) * (1 - (v - min) / span)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(2 + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastX = 2 + (points.length - 1) * step
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={y(points[points.length - 1])} r={2.5} fill={stroke} />
    </svg>
  )
}

/* ------------------------------ Donut (ring) ------------------------------ */

export interface DonutSegment {
  label: string
  value: number // USD
  color: string
}

/**
 * Allocation ring: thin 14px ring, 2px surface gaps, DIRECT labels beside the
 * ring (relief rule — required in light mode), center shows the total.
 * Legend is the label list itself; text stays in ink tokens.
 */
export function AllocationDonut({
  segments,
  center,
  centerLabel,
  size = 168,
  formatValue,
}: {
  segments: DonutSegment[]
  center: string
  centerLabel: string
  size?: number
  formatValue: (v: number) => string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  const r = size / 2 - 10
  const c = 2 * Math.PI * r
  const gap = 2 // px surface gap between segments
  let offset = -c / 4 // start at 12 o'clock
  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} role="img" aria-label={`Allocation: ${segments.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`}>
        {segments.map((s) => {
          const len = Math.max(0, (s.value / total) * c - gap)
          const el = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={14}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            >
              <title>{`${s.label}: ${formatValue(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`}</title>
            </circle>
          )
          offset += (s.value / total) * c
          return el
        })}
        <text x="50%" y="47%" textAnchor="middle" className="tnum" fill="var(--ink)" fontSize={20} fontWeight={600}>
          {center}
        </text>
        <text x="50%" y="59%" textAnchor="middle" fill="var(--ink-3)" fontSize={11}>
          {centerLabel}
        </text>
      </svg>
      {/* direct labels — the accessibility channel, never omit */}
      <ul className="space-y-1.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[13px]">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: s.color }} />
            <span className="w-24 text-ink-2">{s.label}</span>
            <span className="tnum w-20 text-right font-medium text-ink">{formatValue(s.value)}</span>
            <span className="tnum w-12 text-right text-ink-3">{((s.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------- Horizontal weight bars ------------------------- */

export function HBar({
  label,
  value, // 0..1
  display,
  color = 'var(--accent)',
  threshold, // optional 0..1 marker (e.g. 30% concentration line)
  trailing,
}: {
  label: ReactNode
  value: number
  display: string
  color?: string
  threshold?: number
  trailing?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-20 shrink-0 text-[13px] font-medium text-ink">{label}</div>
      <div className="relative h-[6px] flex-1 overflow-visible rounded-full bg-surface-2">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, value * 100)}%`, backgroundColor: color }}
        />
        {threshold !== undefined && (
          <div
            className="absolute -top-[3px] h-3 w-[2px] bg-status-critical"
            style={{ left: `${threshold * 100}%` }}
            title={`${Math.round(threshold * 100)}% threshold`}
          />
        )}
      </div>
      <div className="tnum w-14 shrink-0 text-right text-[13px] text-ink">{display}</div>
      {trailing}
    </div>
  )
}

/* --------------------------- Probability bar ----------------------------- */

export function ProbBar({
  title,
  probability, // 0..1
  horizon,
  icon,
}: {
  title: string
  probability: number
  horizon: string
  icon?: string
}) {
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] text-ink-2">
          {icon && <span className="mr-1.5" aria-hidden>{icon}</span>}
          {title}
        </span>
        <span className="tnum shrink-0 text-[13px] font-semibold text-ink">
          {Math.round(probability * 100)}%
          <span className="ml-1.5 font-normal text-ink-3">{horizon}</span>
        </span>
      </div>
      <div className="h-[6px] rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${probability * 100}%` }} />
      </div>
    </div>
  )
}
