// Loader for /system/pipeline. Real disk/DB reads (no fetch — server
// component), per docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// Backend gap #25 named GET /api/pipeline/dag + GET /api/pipeline/runs as
// needed API routes, but per this session's established convention (direct
// reads for anything non-mutating), this page reads DAILY_PIPELINE and
// getDashboardSummary() directly — no new route needed since nothing here
// mutates. Re-run buttons and the failure drawer (both real mutations, per
// the spec) are deferred; this ships as a read-only status view.

import { DAILY_PIPELINE } from '@common/queue/jobs'
import { getDashboardSummary, type PipelineRun } from '@common/pipeline-runs'

export interface StageVM {
  name: string
  dependsOn: string[]
  skippedToday: boolean
  latestRun: PipelineRun | null
  history: PipelineRun[]
  medianDurationMs: number | null
  isSlow: boolean
}

export interface PipelineViewModel {
  generatedAt: string
  stages: StageVM[]
  lastFullRunAt: string | null
  overallOk: boolean
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function loadPipeline(): PipelineViewModel {
  const summary = getDashboardSummary()
  const historyByStage = new Map(summary.stages.map((s) => [s.stage, s.latestRuns]))

  const stages: StageVM[] = DAILY_PIPELINE.map((job) => {
    const history = historyByStage.get(job.name) ?? []
    const latestRun = history[0] ?? null
    const durations = history.map((r) => r.durationMs).filter((d): d is number => d != null)
    const medianDurationMs = median(durations.slice(1)) // exclude the latest from its own baseline
    const isSlow = !!(latestRun?.durationMs != null && medianDurationMs != null && latestRun.durationMs > medianDurationMs * 2)

    return {
      name: job.name,
      dependsOn: job.dependsOn ? (Array.isArray(job.dependsOn) ? job.dependsOn : [job.dependsOn]) : [],
      skippedToday: job.skipIf ? job.skipIf() : false,
      latestRun,
      history,
      medianDurationMs,
      isSlow,
    }
  })

  const terminal = stages.find((s) => s.name === 'morning-status')
  const lastFullRunAt = terminal?.latestRun?.endedAt ?? null
  const overallOk = stages
    .filter((s) => !s.skippedToday)
    .every((s) => s.latestRun == null || s.latestRun.status === 'success' || s.latestRun.status === 'running')

  return { generatedAt: summary.generatedAt, stages, lastFullRunAt, overallOk }
}
