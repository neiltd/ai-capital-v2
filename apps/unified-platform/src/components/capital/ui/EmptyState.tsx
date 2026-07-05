import type { ReactNode } from 'react'

interface Props {
  icon?: ReactNode
  title: string
  description?: ReactNode
  hint?: ReactNode
  tone?: 'neutral' | 'warning' | 'error'
}

const TONE_BORDER: Record<NonNullable<Props['tone']>, string> = {
  neutral: 'border-border-subtle bg-bg-card',
  warning: 'border-amber-signal/30 bg-amber-signal/[0.04]',
  error:   'border-red-signal/30 bg-red-signal/[0.04]',
}

const TONE_ICON: Record<NonNullable<Props['tone']>, string> = {
  neutral: 'text-text-faint bg-bg-elevated border-border-subtle',
  warning: 'text-amber-signal bg-amber-signal/10 border-amber-signal/20',
  error:   'text-red-signal bg-red-signal/10 border-red-signal/20',
}

/**
 * Consistent empty state component. Replaces ad-hoc "no data" messages
 * scattered across pages. Optional tone signals severity (warning, error).
 */
export function EmptyState({ icon, title, description, hint, tone = 'neutral' }: Props) {
  return (
    <div className={`rounded-xl border ${TONE_BORDER[tone]} px-6 py-10`}>
      <div className="max-w-sm mx-auto text-center flex flex-col items-center gap-3">
        <div className={`w-12 h-12 rounded-xl border flex items-center justify-center text-xl ${TONE_ICON[tone]}`}>
          {icon ?? '✦'}
        </div>
        <div>
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          {description && (
            <div className="text-[12px] text-text-muted mt-1 leading-relaxed">{description}</div>
          )}
        </div>
        {hint && (
          <div className="text-[11px] text-text-inactive bg-bg-elevated border border-border-subtle rounded-md px-3 py-1.5 mt-1">
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}
