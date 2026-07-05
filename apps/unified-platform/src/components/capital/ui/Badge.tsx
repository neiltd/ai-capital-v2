import type { ReactNode } from 'react'

export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'

interface Props {
  children: ReactNode
  tone?: BadgeTone
  size?: 'xs' | 'sm'
  uppercase?: boolean
  className?: string
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-bg-elevated text-text-secondary border-border-default',
  accent:  'bg-accent-primary/[0.12] text-indigo-active border-accent-primary/25',
  success: 'bg-green-signal/[0.12] text-green-signal border-green-signal/25',
  warning: 'bg-amber-signal/[0.12] text-amber-signal border-amber-signal/25',
  danger:  'bg-red-signal/[0.12] text-red-signal border-red-signal/25',
  info:    'bg-blue-signal/[0.12] text-blue-signal border-blue-signal/25',
}

/**
 * Pill / chip component for signals, tags, and statuses.
 * Single source of truth — replaces dozens of ad-hoc inline-styled spans.
 */
export function Badge({
  children,
  tone = 'neutral',
  size = 'xs',
  uppercase = false,
  className = '',
}: Props) {
  const sizeCls = size === 'sm'
    ? 'text-[11px] px-2 py-0.5'
    : 'text-[10px] px-1.5 py-0.5'
  const caseCls = uppercase ? 'uppercase tracking-[0.08em]' : ''

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border font-semibold tabular-nums ${sizeCls} ${caseCls} ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

/**
 * Map a buy/sell/hold/watch/exit/trim/etc. signal to a badge tone.
 */
export function signalTone(signal: string | undefined | null): BadgeTone {
  switch ((signal ?? '').toLowerCase()) {
    case 'buy':
    case 'long':
    case 'strengthening':
    case 'injecting':
    case 'rising':
      return 'success'
    case 'sell':
    case 'short':
    case 'exit':
    case 'broken':
    case 'falling':
    case 'draining':
      return 'danger'
    case 'hold':
    case 'watch':
    case 'trim':
    case 'weakening':
      return 'warning'
    case 'stable':
    case 'neutral':
    case 'no-signal':
      return 'neutral'
    default:
      return 'accent'
  }
}
