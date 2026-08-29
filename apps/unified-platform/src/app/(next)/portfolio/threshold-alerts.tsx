import { readThresholdAlerts, businessToday, type ThresholdAlertRecord } from '@/lib/data'

// Read-only surface for the threshold detector's authoritative records.
// Nothing here mutates; the page is observational by construction.

function fmtValue(a: ThresholdAlertRecord): string {
  return a.rule_id === 'price_drop'
    ? `${(a.observed_value * 100).toFixed(2)}% (threshold ${(a.threshold * 100).toFixed(0)}%)`
    : `${a.observed_value} articles (threshold ${a.threshold})`
}

const RULE_LABEL: Record<ThresholdAlertRecord['rule_id'], string> = {
  price_drop: 'Intraday drop',
  news_velocity: 'News velocity',
}

export function ThresholdAlerts() {
  const result = readThresholdAlerts()

  // A3 — an unreadable record is NOT a quiet day. Saying "no conditions" when
  // the store is corrupt is the same class of lie the whole retirement removed.
  if (!result.ok) {
    return (
      <section className="rounded-lg border border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20 p-4">
        <h2 className="text-sm font-semibold tracking-tight mb-1">Threshold alerts — unavailable</h2>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          The alert record could not be read, so the state of every threshold condition is
          currently unknown. This is <strong>not</strong> the same as “no alerts”.
        </p>
        <p className="mt-1 text-xs font-mono text-neutral-600 dark:text-neutral-400">{result.error}</p>
      </section>
    )
  }

  const { alerts } = result
  const today = businessToday()
  // Two DIFFERENT questions, deliberately: what is true now, and what started
  // today. An alert opened days ago and still holding is active but not today's.
  const active = alerts.filter(a => a.status === 'active')
  const openedToday = alerts.filter(a => a.business_date === today)

  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold tracking-tight">Threshold alerts</h2>
        <span className="text-xs text-neutral-500 tabular-nums">
          {active.length} active now · {openedToday.length} opened today · {alerts.length} on record
        </span>
      </header>

      {alerts.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No threshold conditions recorded. The detector writes a record whenever a condition
          holds — this is a record of conditions, not of messages sent.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-neutral-500">
              <tr className="text-left">
                <th className="py-1 pr-3 font-medium">Instrument</th>
                <th className="py-1 pr-3 font-medium">Condition</th>
                <th className="py-1 pr-3 font-medium">Observed</th>
                <th className="py-1 pr-3 font-medium">Severity</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Opened</th>
                <th className="py-1 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.alert_id} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="py-1.5 pr-3 font-medium">{a.instrument}</td>
                  <td className="py-1.5 pr-3">{RULE_LABEL[a.rule_id]}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtValue(a)}</td>
                  <td className="py-1.5 pr-3">{a.severity}</td>
                  <td className="py-1.5 pr-3">
                    {a.status === 'active'
                      ? 'active'
                      : `resolved ${a.resolved_at ? new Date(a.resolved_at).toLocaleString() : ''}`}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-neutral-500">{a.business_date}</td>
                  <td className="py-1.5 tabular-nums text-neutral-500">
                    {new Date(a.last_observed_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
