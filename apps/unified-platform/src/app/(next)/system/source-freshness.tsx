import { readSourceFreshness, PROVENANCE_MAX_AGE_HOURS } from '@/lib/data'
import type { SourceProvenance } from '@common/types'

// Read-only. Replaced the LINE stale-source alert with a pull surface: same
// detection, no delivery. ACLED was 403-broken for nine days unnoticed once, and
// on 2026-08-29 was found entitlement-restricted since July with GDELT
// unreachable — which is why this page distinguishes five states rather than
// showing a stale/current boolean.

const STYLE: Record<SourceProvenance['availability'], { label: string; cls: string }> = {
  current:     { label: 'current',     cls: 'text-neutral-500' },
  stale:       { label: 'STALE',       cls: 'text-amber-600 dark:text-amber-400 font-medium' },
  unavailable: { label: 'UNAVAILABLE', cls: 'text-red-600 dark:text-red-400 font-semibold' },
  restricted:  { label: 'RESTRICTED',  cls: 'text-red-600 dark:text-red-400 font-semibold' },
  unknown:     { label: 'unknown',     cls: 'text-neutral-400 italic' },
}

export function SourceFreshness() {
  const result = readSourceFreshness()

  if (!result.ok) {
    return (
      <section className="rounded-lg border border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20 p-4">
        <h2 className="text-sm font-semibold tracking-tight mb-1">Feed coverage — unavailable</h2>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          No provenance record could be read, so it is <strong>unknown</strong> whether any source is
          current. This is not the same as “all feeds healthy”.
        </p>
        <p className="mt-1 text-xs font-mono text-neutral-600 dark:text-neutral-400">{result.error}</p>
      </section>
    )
  }

  // Dormancy is not degradation. These come from the reader so the count, the
  // summary string and the table can never disagree.
  const { activeDegraded: degraded, dormant } = result

  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold tracking-tight">Feed coverage</h2>
        <span className="text-xs text-neutral-500 tabular-nums">
          {degraded.length} degraded · {dormant.length} dormant · {result.sources.length} sources
          {result.recordAgeHours !== null ? ` · classified ${result.recordAgeHours}h ago` : ''}
        </span>
      </header>

      {/* Scheduling shown here is THIS process's configuration, not observed
          scheduler state. The worker receives its environment from its own
          launchd job; this dashboard is started separately and reads its own.
          Nothing in the repository propagates one environment to both, so the
          honest claim is "configured here", never "the scheduler is off". */}
      {dormant.length > 0 && (
        <p className="mb-3 rounded border border-neutral-300/60 dark:border-neutral-700 px-3 py-2 text-sm text-neutral-600 dark:text-neutral-400">
          {dormant.length} source{dormant.length === 1 ? ' is' : 's are'} <strong>dormant</strong> in this
          process&rsquo;s configuration — scheduled collection is off here, so their availability below is
          the <em>last known</em> state rather than a live one. This reflects configuration visible to the
          dashboard only; the scheduler&rsquo;s runtime state is not independently verified from here.
        </p>
      )}

      {/* The classification is itself an observation with an age. Verdicts are
          recomputed per source below; what ages is the record's OBSERVED facts. */}
      {result.recordStale && (
        <p className="mb-3 rounded border border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          This provenance record is <strong>{result.recordAgeHours ?? '?'}h old</strong> (bound{' '}
          {PROVENANCE_MAX_AGE_HOURS}h), so nothing has re-checked these sources since. Each
          source&rsquo;s freshness below is recomputed against <em>its own</em> bound at read time,
          so a source may read <em>current</em> here if its bound is longer than the record&rsquo;s
          age. What an old record cannot vouch for is the <em>observed</em> facts it carries — a
          declared outage may since have been resolved.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-neutral-500">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">Source</th>
              <th className="py-1 pr-3 font-medium">Availability</th>
              <th className="py-1 pr-3 font-medium">Scheduling (configured here)</th>
              <th className="py-1 pr-3 font-medium">Last success</th>
              <th className="py-1 pr-3 font-medium">Age</th>
              <th className="py-1 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.sources.map(s => (
              <tr key={s.source} className="border-t border-neutral-100 dark:border-neutral-900 align-top">
                <td className="py-1.5 pr-3 font-medium">{s.source}</td>
                <td className={`py-1.5 pr-3 whitespace-nowrap ${STYLE[s.availability].cls}`}>
                  {STYLE[s.availability].label}
                </td>
                {/* Orthogonal to availability — not a sixth state. */}
                <td className="py-1.5 pr-3 whitespace-nowrap text-neutral-500">
                  {s.scheduling === 'dormant' ? 'dormant' : 'scheduled'}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-neutral-500 whitespace-nowrap">
                  {s.lastSuccessfulFetch ? new Date(s.lastSuccessfulFetch).toLocaleString() : 'never'}
                </td>
                <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">
                  {s.ageHours === null ? '—' : `${s.ageHours}h / ${s.maxStalenessHours}h`}
                </td>
                <td className="py-1.5 text-neutral-500">
                  {s.scheduling === 'dormant' && (
                    <span className="block text-xs mb-0.5 text-neutral-400">
                      Not scheduled in this process&rsquo;s configuration — last known state, not a live one.
                    </span>
                  )}
                  {s.reason}
                  {s.availability === 'restricted' && (
                    <span className="block text-xs mt-0.5 text-neutral-400">
                      Not fixable by retry — requires a subscription change.
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
