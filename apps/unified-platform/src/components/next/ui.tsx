// Core reusable primitives — design-system.md §5.
// Server-component friendly (no client hooks); interactive pieces that need
// state live in the screens that use them.

import type { ReactNode } from 'react'
import { fmtSignedUsd, fmtSignedPct, relTime } from '@/lib/next/format'

const cx = (...c: Array<string | false | undefined | null>) => c.filter(Boolean).join(' ')

/* ---------------------------------- text --------------------------------- */

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3', className)}>
      {children}
    </div>
  )
}

export function AsOf({ iso }: { iso: string }) {
  return (
    <span className="text-[11px] text-ink-3 tnum" title={iso}>
      as of {relTime(iso)}
    </span>
  )
}

/* --------------------------------- layout -------------------------------- */

export function SectionCard({
  title,
  asOf,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  asOf?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('rounded-card border border-hairline bg-surface', className)}>
      {(title || asOf || actions) && (
        <header className="flex items-center justify-between gap-3 px-card-px pt-3 pb-2">
          <h2 className="text-[15px] font-semibold leading-[22px] text-ink">{title}</h2>
          <div className="flex items-center gap-3">
            {asOf && <AsOf iso={asOf} />}
            {actions}
          </div>
        </header>
      )}
      <div className="px-card-px pb-card-py">{children}</div>
    </section>
  )
}

/* ------------------------------- stat tiles ------------------------------ */

export function StatTile({
  label,
  value,
  delta,
  footnote,
  hero = false,
  children,
}: {
  label: string
  value: string
  delta?: ReactNode
  footnote?: string
  hero?: boolean
  children?: ReactNode // e.g. a sparkline
}) {
  return (
    <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
      <Label>{label}</Label>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cx(
            'tnum font-semibold text-ink',
            hero ? 'text-stat-hero' : 'text-stat-value',
          )}
        >
          {value}
        </span>
        {delta}
      </div>
      {children}
      {footnote && <div className="mt-1 text-[11px] leading-4 text-ink-3">{footnote}</div>}
    </div>
  )
}

export function Delta({
  usd,
  pct,
  className,
}: {
  usd?: number
  pct?: number
  className?: string
}) {
  const v = usd ?? pct ?? 0
  const tone = v > 0 ? 'text-gain' : v < 0 ? 'text-loss' : 'text-ink-3'
  const glyph = v > 0 ? '▲' : v < 0 ? '▼' : ''
  const parts = [
    usd !== undefined ? fmtSignedUsd(usd) : null,
    pct !== undefined ? fmtSignedPct(pct) : null,
  ].filter(Boolean)
  return (
    <span className={cx('tnum text-[13px] font-medium', tone, className)}>
      {glyph && <span className="mr-0.5 text-[10px] align-[1px]">{glyph}</span>}
      {parts.join(' · ')}
    </span>
  )
}

/* ------------------------------ badges/chips ------------------------------ */

const ACTION_STYLES: Record<string, string> = {
  buy: 'bg-accent text-white border-transparent',
  trim: 'border-status-warning text-status-warning',
  exit: 'border-status-critical text-status-critical',
  hold: 'border-hairline text-ink-2',
  dca: 'border-cat-4 text-cat-4',
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-chip border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        ACTION_STYLES[action] ?? ACTION_STYLES.hold,
      )}
    >
      {action}
    </span>
  )
}

/**
 * Conviction with calibrated accuracy — the system's self-knowledge belongs
 * next to every recommendation ("TRIM · 76.5% 7d"), not in a footnote.
 */
export function ConvictionBadge({
  conviction,
  accuracy,
  downgraded,
}: {
  conviction: 'high' | 'medium' | 'low'
  accuracy?: { pct: number; horizon: string }
  downgraded?: boolean
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] text-ink-2"
      title={downgraded ? 'Downgraded one level by the calibration rule' : undefined}
    >
      <span className="font-semibold uppercase">{conviction}</span>
      {downgraded && <span aria-label="downgraded by calibration">↓</span>}
      {accuracy && (
        <span className="tnum text-ink-3">
          {accuracy.pct.toFixed(1)}% {accuracy.horizon}
        </span>
      )}
    </span>
  )
}

export function StrategyTag({ strategy }: { strategy: string }) {
  if (strategy === 'tax_locked')
    return (
      <span className="inline-flex items-center gap-1 rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] text-ink-3">
        <span aria-hidden>🔒</span> locked
      </span>
    )
  if (strategy === 'dca')
    return (
      <span className="rounded-chip border border-cat-4 px-1.5 py-0.5 text-[11px] text-cat-4">dca</span>
    )
  return null // 'tactical' is the default and stays unlabeled — less chrome
}

export function JurisdictionTag({ j }: { j: string }) {
  const label =
    j === 'thai-exempt' ? 'TH exempt' : j === 'thai-taxable' ? 'TH taxable' : j === 'us-taxable' ? 'US taxable' : 'locked'
  return (
    <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">{label}</span>
  )
}

export function ScoreBadge({ score, bear }: { score: number; bear?: number }) {
  // Sequential-blue steps by band (validated ordinal range, ≥250 light / ≤600 dark).
  const bg = score >= 85 ? '#1c5cab' : score >= 75 ? '#2a78d6' : score >= 65 ? '#5598e7' : '#86b6ef'
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="tnum inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-[12px] font-semibold text-white"
        style={{ backgroundColor: bg }}
        title={`Bull score ${score}/100`}
      >
        {score}
      </span>
      {bear !== undefined && (
        <span className="tnum text-[11px] text-ink-3" title="Adversarial (bear) reviewer score — higher is worse">
          / {bear} bear
        </span>
      )}
    </span>
  )
}

/* --------------------------------- alerts -------------------------------- */

const BANNER: Record<string, { color: string; icon: string }> = {
  info: { color: 'var(--accent)', icon: 'ℹ' },
  warning: { color: '#fab219', icon: '⚠' },
  serious: { color: '#ec835a', icon: '⚠' },
  critical: { color: '#d03b3b', icon: '⛔' },
}

export function AlertBanner({
  level,
  title,
  detail,
  trailing,
}: {
  level: 'info' | 'warning' | 'serious' | 'critical'
  title: string
  detail?: string
  trailing?: ReactNode
}) {
  const s = BANNER[level]
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-card border px-3 py-2"
      style={{ borderColor: s.color }}
    >
      <span aria-hidden style={{ color: s.color }}>{s.icon}</span>
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        {detail && <span className="ml-2 text-[13px] text-ink-2">{detail}</span>}
      </div>
      {trailing}
    </div>
  )
}

export function FreshnessDot({ iso, staleAfterH = 24 }: { iso: string; staleAfterH?: number }) {
  const ageH = (Date.now() - new Date(iso).getTime()) / 3.6e6
  const color = ageH < staleAfterH ? '#0ca30c' : ageH < staleAfterH * 3 ? '#fab219' : '#d03b3b'
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-3" title={iso}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {relTime(iso)}
    </span>
  )
}

/* --------------------------------- empty state -------------------------------- */

export function Empty({
  title,
  hint,
  action,
}: {
  title: string
  hint: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      <div className="max-w-[420px] text-[12px] leading-5 text-ink-3">{hint}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/* --------------------------------- tables -------------------------------- */

export function Th({
  children,
  align = 'left',
  sticky = false,
  className,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  sticky?: boolean
  className?: string
}) {
  return (
    <th
      className={cx(
        'whitespace-nowrap border-b border-hairline px-3 py-cell-py text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3',
        align === 'right' ? 'text-right' : 'text-left',
        sticky && 'sticky top-0 z-10 bg-surface',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <td
      className={cx(
        'tnum whitespace-nowrap px-3 py-cell-py text-[13px] leading-5 text-ink-2',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  )
}
