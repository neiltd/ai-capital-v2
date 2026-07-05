import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  padded?: boolean
  hoverable?: boolean
}

/**
 * Base card surface used across pages. Centralizes border/background tokens.
 */
export function Card({ children, className = '', padded = false, hoverable = false }: CardProps) {
  return (
    <div
      className={[
        'bg-bg-card bg-gradient-card border border-border-subtle rounded-xl shadow-card overflow-hidden',
        hoverable ? 'transition-colors hover:border-border-default' : '',
        padded ? 'p-4' : '',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

/**
 * Sticky card header with a left accent stripe and aligned actions.
 */
export function CardHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="inline-block w-1 h-3.5 bg-accent-primary/70 rounded-full flex-shrink-0" />
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary truncate">
          {title}
        </h3>
        {meta && <span className="text-[11px] text-text-inactive">{meta}</span>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}
