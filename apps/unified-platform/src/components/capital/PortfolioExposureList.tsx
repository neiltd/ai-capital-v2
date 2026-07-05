import { Card, CardHeader } from './ui/Card'
import { Badge } from './ui/Badge'
import { severityLabel, severityTone } from '@/lib/severity'
import type { StockSectorExposure } from '@/types'

/**
 * Groups market events by sector rather than by ticker: the underlying
 * event data (world-intelligence-data-hub exports) tags events with
 * countries and event types, but never with individual tickers — there is
 * no per-event ticker field anywhere in stock-project/intelligence.json or
 * world-map/intelligence.json. `sectorExposure` is the closest real
 * "portfolio exposure" signal the pipeline actually produces: sector,
 * how many events hit it, the worst severity among them, and a precomputed
 * exposure level. No sentiment/direction field exists either, so (per the
 * brief) that tag is simply not rendered.
 */
export function PortfolioExposureList({ rows }: { rows: StockSectorExposure[] }) {
  if (rows.length === 0) return null

  const sorted = [...rows].sort((a, b) => b.maxSeverity - a.maxSeverity || b.eventCount - a.eventCount)

  return (
    <Card>
      <CardHeader title="Sector Exposure" meta={`${rows.length} flagged`} />
      <div className="divide-y divide-border-subtle">
        {sorted.map(r => (
          <div key={r.sector} className="flex items-center justify-between px-4 py-2.5 gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-text-primary capitalize truncate">{r.sector}</div>
              <div className="text-[10px] text-text-inactive truncate">
                {r.eventCount} event{r.eventCount === 1 ? '' : 's'} · {r.exposure} exposure
              </div>
            </div>
            <Badge tone={severityTone(r.maxSeverity)} size="xs" className="flex-shrink-0">
              {severityLabel(r.maxSeverity)}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  )
}
