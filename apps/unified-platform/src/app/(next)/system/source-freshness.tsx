import { readSourceFreshness } from '@/lib/data'

// Read-only. Replaced the LINE stale-source alert with a pull surface: same
// detection, no delivery. ACLED was 403-broken for nine days without anyone
// noticing, which is why this control exists at all.

export function SourceFreshness() {
  const result = readSourceFreshness()

  if (!result.ok) {
    return (
      <section className="rounded-lg border border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20 p-4">
        <h2 className="text-sm font-semibold tracking-tight mb-1">Feed freshness — unavailable</h2>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          No freshness export could be read, so it is <strong>unknown</strong> whether any
          source is current. This is not the same as “all feeds healthy”.
        </p>
        <p className="mt-1 text-xs font-mono text-neutral-600 dark:text-neutral-400">{result.error}</p>
      </section>
    )
  }

  const stale = result.sources.filter(s => s.stale)

  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold tracking-tight">Feed freshness</h2>
        <span className="text-xs text-neutral-500 tabular-nums">
          {stale.length} stale · {result.sources.length} sources
          {result.exportedAt ? ` · as of ${new Date(result.exportedAt).toLocaleString()}` : ''}
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-neutral-500">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">Source</th>
              <th className="py-1 pr-3 font-medium">State</th>
              <th className="py-1 pr-3 font-medium">Last success</th>
              <th className="py-1 pr-3 font-medium">Age</th>
              <th className="py-1 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.sources.map(s => (
              <tr key={s.source} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="py-1.5 pr-3 font-medium">{s.source}</td>
                <td className={`py-1.5 pr-3 ${s.stale ? 'text-red-600 dark:text-red-400 font-medium' : 'text-neutral-500'}`}>
                  {s.stale ? 'STALE' : 'current'}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-neutral-500">
                  {s.lastSuccessfulFetch ? new Date(s.lastSuccessfulFetch).toLocaleString() : 'never'}
                </td>
                <td className="py-1.5 pr-3 tabular-nums">
                  {s.ageHours === null ? '—' : `${s.ageHours}h / ${s.maxStalenessHours}h`}
                </td>
                <td className="py-1.5 text-neutral-500">{s.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
