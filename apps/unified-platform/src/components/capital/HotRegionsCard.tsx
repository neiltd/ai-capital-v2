import { Card, CardHeader } from './ui/Card'
import { Badge } from './ui/Badge'
import { severityLabel, severityTone } from '@/lib/severity'
import type { WorldCountrySignal } from '@/types'

const TOP_N = 5

/**
 * Top countries by event count, from the real per-country rollups
 * (`countrySignals`) the world-intel export already computes —
 * eventCount and maxSeverity are precomputed there, not derived here.
 */
export function HotRegionsCard({ countries }: { countries: WorldCountrySignal[] }) {
  if (countries.length === 0) return null

  const top = [...countries]
    .sort((a, b) => b.eventCount - a.eventCount || b.maxSeverity - a.maxSeverity)
    .slice(0, TOP_N)

  return (
    <Card>
      <CardHeader title="Hot Regions" meta={`${countries.length} tracked`} />
      <div className="divide-y divide-border-subtle">
        {top.map(c => (
          <div key={c.country} className="flex items-center justify-between px-4 py-2.5 gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-indigo-active">{c.country}</div>
              <div className="text-[10px] text-text-inactive truncate">
                {c.eventCount} event{c.eventCount === 1 ? '' : 's'}
                {c.dominantEventType ? ` · ${c.dominantEventType.replace(/_/g, ' ')}` : ''}
              </div>
            </div>
            <Badge tone={severityTone(c.maxSeverity)} size="xs" className="flex-shrink-0">
              {severityLabel(c.maxSeverity)}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  )
}
