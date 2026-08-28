import { readThresholdAlerts, type ThresholdAlertRecord } from '@/lib/data'

// Read-only surface for the threshold detector's authoritative records.
// Renders nothing that mutates; the page is observational by construction.

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
  const alerts = readThresholdAlerts()
  const active = alerts.filter(a => a.status === 'active')

  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold tracking-tight">Threshold alerts</h2>
        <span className="text-xs text-neutral-500 tabular-nums">
          {active.length} active · {alerts.length} today
        </span>
      </header>

      {alerts.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No threshold conditions recorded. The detector runs on a schedule and writes
          a record whenever a condition holds — this is a record of conditions, not of
          messages sent.
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
                <th className="py-1 font-medium">Detected</th>
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
                      : `resolved ${a.resolved_at ? new Date(a.resolved_at).toLocaleTimeString() : ''}`}
                  </td>
                  <td className="py-1.5 tabular-nums text-neutral-500">
                    {new Date(a.detected_at).toLocaleString()}
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
