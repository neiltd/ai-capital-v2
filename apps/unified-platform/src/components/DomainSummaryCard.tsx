import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card, CardHeader } from './capital/ui/Card'
import { EmptyState } from './capital/ui/EmptyState'

export interface PreviewItem {
  key: string
  primary: ReactNode
  secondary?: ReactNode
  badge?: ReactNode
}

export interface SmallStat {
  label: string
  value: ReactNode
}

type Tone = 'neutral' | 'positive' | 'negative' | 'accent'

const TONE_VALUE: Record<Tone, string> = {
  neutral: 'text-text-primary',
  positive: 'text-green-signal',
  negative: 'text-red-signal',
  accent: 'text-indigo-active',
}

interface Props {
  eyebrow: string
  title: string
  subtitle?: string
  /** 2-3 preview rows (top signals / top events / latest videos). Omit or leave empty to skip the list. */
  preview?: PreviewItem[]
  bigStatLabel: string
  bigStatValue: ReactNode
  bigStatSub?: ReactNode
  bigStatTone?: Tone
  smallStats: SmallStat[]
  ctaHref: string
  ctaLabel: string
  /** Rendered next to the header (e.g. a follower-growth Sparkline). */
  headerAccessory?: ReactNode
  /** When set, the card renders this EmptyState instead of stats — used when the
   * domain's data source failed to load or has produced nothing yet. */
  empty?: { icon?: string; title: string; description?: string }
}

/**
 * Shared shell for the three home-page domain cards (Capital / World / Studio).
 * Each domain independently supplies preview rows + one big stat + a row of
 * small stats + a CTA. Any domain can degrade to `empty` without affecting
 * the other cards on the page.
 */
export function DomainSummaryCard({
  eyebrow,
  title,
  subtitle,
  preview,
  bigStatLabel,
  bigStatValue,
  bigStatSub,
  bigStatTone = 'accent',
  smallStats,
  ctaHref,
  ctaLabel,
  headerAccessory,
  empty,
}: Props) {
  return (
    <Card className="flex flex-col h-full">
      <CardHeader title={eyebrow} actions={headerAccessory} />

      <div className="p-5 flex flex-col flex-1 gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-text-primary leading-snug">{title}</h3>
          {subtitle && <p className="text-[12px] text-text-muted mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>

        {empty ? (
          <div className="flex-1">
            <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
          </div>
        ) : (
          <>
            {preview && preview.length > 0 && (
              <ul className="space-y-2">
                {preview.map(item => (
                  <li
                    key={item.key}
                    className="flex items-center justify-between gap-3 text-[12px] border-b border-border-subtle last:border-0 pb-2 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-text-primary truncate">{item.primary}</div>
                      {item.secondary && (
                        <div className="text-text-inactive text-[11px] truncate mt-0.5">{item.secondary}</div>
                      )}
                    </div>
                    {item.badge && <div className="flex-shrink-0">{item.badge}</div>}
                  </li>
                ))}
              </ul>
            )}

            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-inactive">
                {bigStatLabel}
              </div>
              <div className={`text-[26px] font-semibold tracking-tight tabular-nums leading-tight ${TONE_VALUE[bigStatTone]}`}>
                {bigStatValue}
              </div>
              {bigStatSub && <div className="text-[11px] text-text-muted mt-0.5">{bigStatSub}</div>}
            </div>

            {smallStats.length > 0 && (
              <div
                className="grid gap-3 pt-3 border-t border-border-subtle"
                style={{ gridTemplateColumns: `repeat(${smallStats.length}, minmax(0, 1fr))` }}
              >
                {smallStats.map(s => (
                  <div key={s.label} className="min-w-0">
                    <div className="text-[9px] uppercase tracking-wide text-text-inactive truncate">{s.label}</div>
                    <div className="text-[13px] font-semibold text-text-primary tabular-nums truncate">{s.value}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-auto pt-1">
          <Link
            href={ctaHref}
            className="text-[12px] font-medium text-indigo-active hover:text-indigo-soft transition-colors inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-accent-primary/20 bg-accent-primary/[0.06] hover:bg-accent-primary/[0.1]"
          >
            {ctaLabel} →
          </Link>
        </div>
      </div>
    </Card>
  )
}
