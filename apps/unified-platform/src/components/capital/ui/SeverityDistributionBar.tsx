import { Card, CardHeader } from './Card'
import { severityLabel } from '@/lib/severity'

const BAND_ORDER = ['Critical', 'High', 'Medium', 'Low'] as const

const BAND_COLOR: Record<(typeof BAND_ORDER)[number], string> = {
  Critical: 'bg-red-signal',
  High: 'bg-amber-signal',
  Medium: 'bg-indigo-active',
  Low: 'bg-text-muted',
}

/**
 * Small sidebar chart: total event count per severity band, as horizontal
 * mini bars. Bands and thresholds come from lib/severity's severityLabel,
 * the same classifier already used on the individual event cards.
 */
export function SeverityDistributionBar({ events }: { events: Array<{ severity: number }> }) {
  if (events.length === 0) return null

  const counts: Record<(typeof BAND_ORDER)[number], number> = { Critical: 0, High: 0, Medium: 0, Low: 0 }
  for (const e of events) {
    const band = severityLabel(e.severity) as (typeof BAND_ORDER)[number]
    counts[band] += 1
  }
  const max = Math.max(1, ...Object.values(counts))

  return (
    <Card>
      <CardHeader title="Severity Mix" meta={`${events.length} events`} />
      <div className="p-4 space-y-2.5">
        {BAND_ORDER.map(band => (
          <div key={band} className="flex items-center gap-2">
            <span className="w-14 text-[10px] text-text-muted flex-shrink-0">{band}</span>
            <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${BAND_COLOR[band]}`}
                style={{ width: `${(counts[band] / max) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-[10px] text-text-secondary tabular-nums flex-shrink-0">
              {counts[band]}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}
