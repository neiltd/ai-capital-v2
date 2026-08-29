// /system/pipeline — Pipeline observability.
//
// Answers "can I trust today's briefing?" in one glance: header shows the
// last full run and overall status; the stage table is grouped by
// dependency depth (world-intel → ingestion → thesis → analysis → … →
// briefing → morning-status) with a 7-run history strip per stage.
//
// Scoped down from the full spec (design-redesign-2026-07/screens/specs/
// admin-pipeline.md): no failure drawer, no re-run buttons (both real
// mutations — deferred), no DAG graph layout (a depth-grouped table
// carries the same "what fed this stage" information without the extra
// rendering complexity). The legacy /admin/pipeline page stays as-is.

export const dynamic = 'force-dynamic'

import { loadPipeline } from './data'
import type { StageVM } from './data'
import { SectionCard, StatTile, Th, Td } from '@/components/next/ui'
import { SourceFreshness } from '../source-freshness'
import { relTime } from '@/lib/next/format'

const STATUS_COLOR: Record<string, string> = {
  success: '#0ca30c',
  failed: '#d03b3b',
  killed: '#eb6834',
  timeout: '#fab219',
  running: 'var(--accent)',
}

function StatusDot({ stage }: { stage: StageVM }) {
  if (stage.skippedToday) {
    return <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">weekly</span>
  }
  if (!stage.latestRun) {
    return <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] text-ink-3">never run</span>
  }
  const color = STATUS_COLOR[stage.latestRun.status] ?? 'var(--ink-3)'
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {stage.latestRun.status}
    </span>
  )
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function HistoryStrip({ history }: { history: StageVM['history'] }) {
  const last7 = [...history].slice(0, 7).reverse()
  return (
    <div className="flex items-center gap-[3px]">
      {last7.map((r) => (
        <span
          key={r.id}
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: STATUS_COLOR[r.status] ?? 'var(--ink-3)' }}
          title={`${r.status} · ${r.startedAt.slice(0, 16)}`}
        />
      ))}
      {last7.length === 0 && <span className="text-[11px] text-ink-3">—</span>}
    </div>
  )
}

// Depth by dependency chain — columns group stages by "what fed this stage".
function computeDepths(stages: StageVM[]): Map<string, number> {
  const byName = new Map(stages.map((s) => [s.name, s]))
  const depths = new Map<string, number>()
  function depth(name: string, seen: Set<string> = new Set()): number {
    if (depths.has(name)) return depths.get(name)!
    if (seen.has(name)) return 0 // cycle guard
    const stage = byName.get(name)
    if (!stage || stage.dependsOn.length === 0) { depths.set(name, 0); return 0 }
    const d = 1 + Math.max(...stage.dependsOn.map((p) => depth(p, new Set(seen).add(name))))
    depths.set(name, d)
    return d
  }
  for (const s of stages) depth(s.name)
  return depths
}

export default function PipelinePage() {
  const p = loadPipeline()
  const depths = computeDepths(p.stages)
  const maxDepth = Math.max(...p.stages.map((s) => depths.get(s.name) ?? 0))
  const failedToday = p.stages.filter((s) => !s.skippedToday && s.latestRun?.status === 'failed')

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Pipeline</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {p.stages.length} stages · the answer to &quot;can I trust today&apos;s briefing?&quot;
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">
          {p.generatedAt ? `as of ${relTime(p.generatedAt)}` : ''}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatTile
          label="Last full run"
          value={p.lastFullRunAt ? relTime(p.lastFullRunAt) : '—'}
          footnote={p.lastFullRunAt ? new Date(p.lastFullRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'morning-status has never completed'}
        />
        <StatTile
          label="Overall status"
          value={p.overallOk ? 'Healthy' : 'Attention needed'}
          footnote={failedToday.length > 0 ? `${failedToday.length} stage${failedToday.length > 1 ? 's' : ''} failed` : undefined}
        />
        <StatTile label="Stages" value={String(p.stages.length)} footnote={`${p.stages.filter((s) => s.skippedToday).length} weekly-only, skipped today`} />
      </div>

      <SectionCard title="Stages by dependency depth" asOf={p.generatedAt}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th align="right">Depth</Th>
                <Th>Stage</Th>
                <Th>Status</Th>
                <Th align="right">Duration</Th>
                <Th>Depends on</Th>
                <Th>Last 7 runs</Th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: maxDepth + 1 }, (_, d) => d).map((d) =>
                p.stages
                  .filter((s) => depths.get(s.name) === d)
                  .map((s) => (
                    <tr key={s.name} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                      <Td align="right" className="text-ink-3">{d}</Td>
                      <Td>
                        <span className="font-semibold text-ink">{s.name}</span>
                        {s.isSlow && <span className="ml-1.5 text-status-warning" title={`Duration ${formatDuration(s.latestRun?.durationMs ?? null)} vs. median ${formatDuration(s.medianDurationMs)}`}>⏱</span>}
                      </Td>
                      <Td><StatusDot stage={s} /></Td>
                      <Td align="right">{formatDuration(s.latestRun?.durationMs ?? null)}</Td>
                      <Td className="max-w-[24ch]"><span className="block truncate text-ink-3" title={s.dependsOn.join(', ')}>{s.dependsOn.join(', ') || '—'}</span></Td>
                      <Td><HistoryStrip history={s.history} /></Td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Depth = dependency chain length (world-intel → ingestion → … → briefing → morning-status).
          ⏱ = latest run &gt;2× its own 7-run median duration. &quot;weekly&quot; stages (discovery, people-tweets,
          correlation) run Sundays only — skipped on any other day is healthy, not a failure.
        </p>
      </SectionCard>

      {/* Pull surface that replaced the LINE stale-source alert. */}
      <SourceFreshness />
    </main>
  )
}
