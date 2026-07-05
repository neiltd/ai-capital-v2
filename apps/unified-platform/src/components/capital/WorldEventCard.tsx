import { severityLabel, escalationLabel } from '@/lib/severity'

const SEVERITY_STYLES: Record<string, string> = {
  Critical: 'bg-red-signal/10 text-red-signal border-red-signal/20',
  High: 'bg-amber-signal/10 text-amber-signal border-amber-signal/20',
  Medium: 'bg-indigo-active/10 text-indigo-active border-indigo-active/20',
  Low: 'bg-text-muted/10 text-text-muted border-text-muted/20',
}

interface StockCardProps {
  title: string
  summary: string
  severity: number
  eventType?: string
  marketDirection?: string
  countries?: string[]
}

interface WorldCardProps {
  title: string
  summary: string
  severity: number
  countries?: string[]
  escalationPotential?: number
}

export function StockEventCard({ title, summary, severity, eventType, marketDirection, countries }: StockCardProps) {
  const label = severityLabel(severity)
  const badgeClass = SEVERITY_STYLES[label] ?? SEVERITY_STYLES.Low
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-text-primary leading-tight">{title}</div>
        <span className={`border text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${badgeClass}`}>
          {label}
        </span>
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">{summary}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {eventType && (
          <span className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{eventType}</span>
        )}
        {marketDirection && (
          <span className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{marketDirection}</span>
        )}
        {countries?.map(c => (
          <span key={c} className="text-indigo-active text-[10px] font-medium">{c}</span>
        ))}
      </div>
    </div>
  )
}

export function WorldEventCard({ title, summary, severity, countries, escalationPotential }: WorldCardProps) {
  const label = severityLabel(severity)
  const badgeClass = SEVERITY_STYLES[label] ?? SEVERITY_STYLES.Low
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-text-primary leading-tight">{title}</div>
        <span className={`border text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${badgeClass}`}>
          {label}
        </span>
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">{summary}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {countries?.map(c => (
          <span key={c} className="bg-border-subtle text-text-muted text-[10px] px-1.5 py-0.5 rounded">{c}</span>
        ))}
        {escalationPotential !== undefined && (
          <span className="text-amber-signal text-[10px]">{escalationLabel(escalationPotential)}</span>
        )}
      </div>
    </div>
  )
}
