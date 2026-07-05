// Phase 3.2 pipeline-observability dashboard.
// Reads from pipeline_runs.db (path resolved via PIPELINE_RUNS_DB env or
// DATA_ROOT fallback). Server component — re-renders on every request so
// the grid always reflects current state.

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { getDashboardSummary, reapOrphans, type PipelineRun, type PipelineRunStatus } from '@common/pipeline-runs'
import { PageHeader } from '@/components/capital/ui/PageHeader'
import { StatCard } from '@/components/capital/ui/StatCard'

// Mark anything stuck running > 6 hours as 'timeout'. The daily pipeline
// itself is ~20-60 min end-to-end, so 6h is a generous SLA.
const ORPHAN_REAP_MS = 6 * 60 * 60 * 1000

// NOTE: tailwind.config.ts has no distinct "orange" signal token — the palette
// only defines green/amber/red/blue signals (each with a `-soft` variant).
// 'killed' borrows amber-soft (the more orange-leaning of the two ambers) so
// it stays visually distinct from 'timeout' (amber-signal, more yellow) while
// preserving the original red→orange→amber→blue hue ordering.
function statusColor(status: PipelineRunStatus): string {
  switch (status) {
    case 'success':  return 'bg-green-signal/15 text-green-signal border-green-signal/30'
    case 'failed':   return 'bg-red-signal/15   text-red-signal   border-red-signal/30'
    case 'killed':   return 'bg-amber-soft/15   text-amber-soft   border-amber-soft/30'
    case 'timeout':  return 'bg-amber-signal/15 text-amber-signal border-amber-signal/30'
    case 'running':  return 'bg-blue-signal/15  text-blue-signal  border-blue-signal/30 animate-pulse'
    default:         return 'bg-bg-elevated     text-text-muted   border-border-default'
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000)       return `${ms}ms`
  if (ms < 60_000)     return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000)  return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000)      return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000)   return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000)  return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Cell({ run }: { run: PipelineRun }) {
  const cls = statusColor(run.status)
  const title = [
    `${run.stage}${run.source ? ` / ${run.source}` : ''}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    run.endedAt   ? `Ended:   ${run.endedAt}`     : null,
    run.durationMs !== null ? `Duration: ${formatDuration(run.durationMs)}` : null,
    run.docCount   !== null ? `Docs:     ${run.docCount}`    : null,
    run.chunkCount !== null ? `Chunks:   ${run.chunkCount}`  : null,
    run.errorMessage ? `Error: ${run.errorMessage}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div className={`rounded border ${cls} px-2 py-1 text-xs font-mono`} title={title}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">
          {run.status === 'running' ? '…' : formatDuration(run.durationMs)}
        </span>
        <span className="opacity-60">{shortDate(run.startedAt)}</span>
      </div>
      {run.errorMessage && (
        <div className="mt-0.5 truncate text-[10px] opacity-80" title={run.errorMessage}>
          {run.errorMessage}
        </div>
      )}
      {(run.docCount !== null || run.chunkCount !== null) && (
        <div className="mt-0.5 text-[10px] opacity-70">
          {run.docCount   !== null && <span>{run.docCount} docs </span>}
          {run.chunkCount !== null && <span>{run.chunkCount} chunks</span>}
        </div>
      )}
    </div>
  )
}

function EmptyCell() {
  return <div className="rounded border border-border-subtle bg-bg-elevated h-[36px]" />
}

export default async function PipelineDashboardPage() {
  // Reap any orphan runs older than the SLA before we read — so dead "running"
  // rows from killed pipelines don't pollute the grid.
  let reaped = 0
  try {
    reaped = reapOrphans(ORPHAN_REAP_MS).length
  } catch {
    /* DB not initialised yet — first request before daily.sh ever ran */
  }

  let summary
  try {
    summary = getDashboardSummary()
  } catch (err) {
    return (
      <main className="min-h-screen bg-bg-base text-text-primary p-8">
        <h1 className="text-2xl font-bold">Pipeline Observability</h1>
        <p className="mt-4 text-red-signal">
          Could not read pipeline_runs.db: {(err as Error).message}
        </p>
        <p className="mt-2 text-text-muted text-sm">
          Either the file doesn&apos;t exist yet (run <code>./daily.sh</code> at least once),
          or <code>PIPELINE_RUNS_DB</code> / <code>DATA_ROOT</code> env vars aren&apos;t set correctly.
        </p>
      </main>
    )
  }

  const successCount = summary.stages.reduce(
    (acc, s) => acc + s.latestRuns.filter(r => r.status === 'success').length,
    0,
  )
  const failedCount = summary.stages.reduce(
    (acc, s) => acc + s.latestRuns.filter(r => r.status === 'failed' || r.status === 'killed' || r.status === 'timeout').length,
    0,
  )
  const lastAcrossAll = summary.stages
    .flatMap(s => s.latestRuns)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]

  return (
    <main className="min-h-screen bg-bg-base text-text-primary p-6 lg:p-8">
      <PageHeader
        title="Pipeline Observability"
        meta={
          <span className="font-mono">
            Generated {new Date(summary.generatedAt).toLocaleString()}
          </span>
        }
      />

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Stages tracked" value={summary.stages.length} tone="neutral" />
        <StatCard
          label="In-flight"
          value={summary.inFlight.length}
          tone={summary.inFlight.length > 0 ? 'accent' : 'neutral'}
        />
        <StatCard label="Success (last 7/stage)" value={successCount} tone="positive" />
        <StatCard
          label="Failed / killed"
          value={failedCount}
          tone={failedCount > 0 ? 'negative' : 'neutral'}
        />
      </section>

      {/* ── Last activity ────────────────────────────────────────────────── */}
      {lastAcrossAll && (
        <section className="mb-6 rounded-lg border border-border-subtle bg-bg-card p-3 text-sm">
          <span className="text-text-muted">Last activity: </span>
          <span className="font-mono text-text-primary">{lastAcrossAll.stage}</span>
          <span className="text-text-muted"> — </span>
          <span className={`font-semibold ${lastAcrossAll.status === 'success' ? 'text-green-signal' : lastAcrossAll.status === 'failed' ? 'text-red-signal' : 'text-text-secondary'}`}>
            {lastAcrossAll.status}
          </span>
          <span className="text-text-muted"> ({timeAgo(lastAcrossAll.startedAt)})</span>
          {reaped > 0 && (
            <span className="ml-3 text-amber-signal">
              · {reaped} orphan run{reaped > 1 ? 's' : ''} reaped this load
            </span>
          )}
        </section>
      )}

      {/* ── In-flight runs ──────────────────────────────────────────────── */}
      {summary.inFlight.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-text-muted mb-2">Currently running</h2>
          <div className="space-y-1">
            {summary.inFlight.map(r => (
              <div key={r.id} className="rounded border border-blue-signal/30 bg-blue-signal/10 px-3 py-2 text-sm font-mono">
                <span className="text-blue-signal">{r.stage}</span>
                {r.source && <span className="text-text-muted"> / {r.source}</span>}
                <span className="ml-3 text-text-muted">started {timeAgo(r.startedAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Stage grid ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-text-muted mb-3">Last 7 runs per stage (newest left)</h2>
        {summary.stages.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-bg-elevated p-6 text-center text-text-muted">
            No pipeline runs recorded yet. Run <code className="text-text-secondary">./daily.sh</code> to populate.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-text-inactive bg-bg-subtle">
                  <th className="py-2 pr-4">Stage</th>
                  {Array.from({ length: 7 }).map((_, i) => (
                    <th key={i} className="px-1 py-2 text-center font-normal w-32">
                      {i === 0 ? 'Newest' : `−${i}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.stages.map(s => (
                  <tr key={s.stage} className="border-t border-border-subtle">
                    <td className="py-2 pr-4 font-mono text-text-primary">{s.stage}</td>
                    {Array.from({ length: 7 }).map((_, i) => {
                      const run = s.latestRuns[i]
                      return (
                        <td key={i} className="px-1 py-1">
                          {run ? <Cell run={run} /> : <EmptyCell />}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="mt-8 text-[10px] text-text-faint">
        Path: <code>{process.env.PIPELINE_RUNS_DB ?? `${process.env.DATA_ROOT}/../data/pipeline-runs.db`}</code>
        {' · '}
        Orphan reap SLA: 6h
      </footer>
    </main>
  )
}
