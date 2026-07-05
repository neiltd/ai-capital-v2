import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  meta?: ReactNode
  actions?: ReactNode
}

/**
 * Premium page header with title, optional subtitle, metadata line, and a
 * subtle horizontal rule. Used at the top of every capital page.
 */
export function PageHeader({ title, subtitle, meta, actions }: Props) {
  return (
    <header className="pb-5 mb-6 border-b border-border-subtle">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-tight text-text-primary leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13px] text-text-muted mt-1 leading-snug">{subtitle}</p>
          )}
          {meta && (
            <div className="text-[11px] text-text-inactive mt-2 flex items-center gap-2 flex-wrap">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>
        )}
      </div>
    </header>
  )
}

/**
 * A small dot separator for the meta line. Visual breathing room
 * between e.g. "as of 2026-05-29" · "12 assets".
 */
export function MetaDot() {
  return <span className="text-text-faint">·</span>
}

/**
 * Uppercase section title used above card grids and tables.
 */
export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode
  count?: number
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted flex items-center gap-2">
        <span className="inline-block w-1 h-3 bg-accent-primary/70 rounded-full" />
        {children}
        {count != null && (
          <span className="text-text-faint font-normal normal-case tracking-normal">
            ({count})
          </span>
        )}
      </h2>
      {action}
    </div>
  )
}
