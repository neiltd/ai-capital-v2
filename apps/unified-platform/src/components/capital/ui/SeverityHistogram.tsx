import { Card, CardHeader } from './Card'

const BUCKET_COUNT = 24 // hourly buckets over a 24h window

interface HistogramEvent {
  firstSeenAt?: string
  severity: number
}

interface Bucket {
  count: number
  maxSeverity: number
}

/**
 * Buckets events by hour into a fixed 24h window ending at the most recent
 * `firstSeenAt` timestamp found in the data (rather than wall-clock "now" —
 * this dataset is a periodic export and can lag real time by days, so
 * anchoring to its own latest event keeps the chart populated with the
 * real spread of activity instead of collapsing to a single empty bucket).
 * Returns null when there is no usable timestamp to anchor on.
 */
export function buildHourlyBuckets(events: HistogramEvent[]): Bucket[] | null {
  const timed = events
    .map(e => ({ severity: e.severity, t: e.firstSeenAt ? Date.parse(e.firstSeenAt) : NaN }))
    .filter((e): e is { severity: number; t: number } => !Number.isNaN(e.t))

  if (timed.length === 0) return null

  const referenceNow = Math.max(...timed.map(e => e.t))
  const buckets: Bucket[] = Array.from({ length: BUCKET_COUNT }, () => ({ count: 0, maxSeverity: 0 }))

  for (const e of timed) {
    const hoursAgo = (referenceNow - e.t) / 3_600_000
    if (hoursAgo < 0 || hoursAgo >= BUCKET_COUNT) continue
    const idx = BUCKET_COUNT - 1 - Math.floor(hoursAgo)
    if (idx < 0 || idx >= BUCKET_COUNT) continue
    buckets[idx].count += 1
    buckets[idx].maxSeverity = Math.max(buckets[idx].maxSeverity, e.severity)
  }

  return buckets
}

function barColor(maxSeverity: number): string {
  if (maxSeverity >= 5) return 'bg-red-signal'
  if (maxSeverity >= 4) return 'bg-amber-signal'
  if (maxSeverity > 0) return 'bg-border-strong'
  return 'bg-border-subtle'
}

/**
 * Hourly event-volume histogram over the most recent 24h of the dataset.
 * Bar height = event count in that hour; bar color = the highest severity
 * band present in that hour (red = critical, amber = high, gray = lower).
 */
export function SeverityHistogram({ events }: { events: HistogramEvent[] }) {
  const buckets = buildHourlyBuckets(events)
  if (!buckets) return null

  const maxCount = Math.max(1, ...buckets.map(b => b.count))

  return (
    <Card>
      <CardHeader title="Event Volume" meta="24h · hourly" />
      <div className="p-4">
        <div className="flex items-end gap-[3px] h-20">
          {buckets.map((b, i) => {
            const heightPct = b.count === 0 ? 0 : Math.max(12, (b.count / maxCount) * 100)
            return (
              <div
                key={i}
                className="flex-1 flex flex-col justify-end h-full"
                title={`${b.count} event${b.count === 1 ? '' : 's'}${b.maxSeverity > 0 ? ` · max severity ${b.maxSeverity}` : ''}`}
              >
                <div
                  className={`w-full rounded-[1px] ${barColor(b.maxSeverity)}`}
                  style={{ height: `${heightPct}%`, minHeight: b.count === 0 ? '2px' : undefined }}
                />
              </div>
            )
          })}
        </div>
        <div className="flex justify-between mt-2 text-[9px] text-text-inactive">
          <span>-24h</span>
          <span>latest</span>
        </div>
      </div>
    </Card>
  )
}
