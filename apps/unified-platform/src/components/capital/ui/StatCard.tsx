import type { ReactNode } from 'react'

type Tone = 'neutral' | 'positive' | 'negative' | 'accent'

interface Props {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: Tone
  delta?: number | null
  icon?: ReactNode
}

const TONE_VALUE: Record<Tone, string> = {
  neutral:  'text-text-primary',
  positive: 'text-green-signal',
  negative: 'text-red-signal',
  accent:   'text-indigo-active',
}

const TONE_RING: Record<Tone, string> = {
  neutral:  'before:bg-gradient-to-r before:from-border-subtle before:via-border-default before:to-border-subtle',
  positive: 'before:bg-gradient-to-r before:from-border-subtle before:via-green-signal/40 before:to-border-subtle',
  negative: 'before:bg-gradient-to-r before:from-border-subtle before:via-red-signal/40 before:to-border-subtle',
  accent:   'before:bg-gradient-to-r before:from-border-subtle before:via-accent-primary/40 before:to-border-subtle',
}

/**
 * Premium stat card used in the top row of every capital page.
 *
 * Layout: small uppercase label, large value, optional subtext + delta.
 * A 1px gradient top-border conveys subtle tone (success / danger / neutral).
 */
export function StatCard({ label, value, sub, tone = 'neutral', delta, icon }: Props) {
  const valueClass = TONE_VALUE[tone]

  const arrow = delta == null ? null : delta > 0 ? '▲' : delta < 0 ? '▼' : '◆'
  const deltaColor =
    delta == null ? 'text-text-muted' :
    delta > 0 ? 'text-green-signal' :
    delta < 0 ? 'text-red-signal' : 'text-text-muted'

  return (
    <div
      className={`relative bg-bg-card bg-gradient-card border border-border-subtle rounded-xl px-4 py-3.5 overflow-hidden
        before:absolute before:inset-x-3 before:top-0 before:h-px before:content-[''] ${TONE_RING[tone]}
        shadow-card transition-colors hover:border-border-default`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-inactive">
          {label}
        </div>
        {icon && <div className="text-text-faint">{icon}</div>}
      </div>
      <div className={`text-[22px] font-semibold tracking-tight leading-none tabular-nums ${valueClass}`}>
        {value}
      </div>
      {(sub || delta != null) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums">
          {delta != null && (
            <span className={`${deltaColor} font-medium`}>
              {arrow} {Math.abs(delta).toFixed(1)}%
            </span>
          )}
          {sub && <span className="text-text-muted">{sub}</span>}
        </div>
      )}
    </div>
  )
}
