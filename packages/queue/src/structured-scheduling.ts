// Optional, independent scheduling for structured-event + energy/macro
// ingestion.
//
// This job is deliberately NOT part of the daily article flow. Between
// 2026-05 and 2026-08 it sat at the head of that flow and, across 83 runs,
// failed 32 times — 22 of them SIGTERM against its own 30-minute timeout — and
// on 14 days the article `collect` stage never ran at all because BullMQ
// dependency semantics blocked it behind a terminally failed parent. Nothing
// consumes the structured artifacts, so the article pipeline was being taken
// down by a producer with no reader.
//
// The flag governs SUBMISSION of this independent job. It is deliberately not a
// `skipIf` on a stage inside the daily flow: that would mean re-enabling
// structured ingestion silently restored the structured -> article dependency.
// Re-enabling here changes scheduling only; article topology is untouched.
//
// ACTIVATION: enabling the flag is step TWO. The structured worker must be
// installed and verified first (bin/structured-worker.ts + the unregistered
// definition in ops/launchd-proposed/); otherwise submissions accumulate with
// no consumer. Source state today is DORMANT / ACTIVATION-READY.
//
// EXECUTION ISOLATION: this submits to the structured queue, not the daily one.
// Graph independence alone was insufficient — both workloads shared one queue
// whose worker runs at concurrency 1, so a stalled structured job could occupy
// the only slot and delay runnable article jobs. Separate queue, separate
// worker process, separate slot.
import { recordEnd, recordStart } from '@common/pipeline-runs'
import type { RecordEndInput, RecordStartInput } from '@common/pipeline-runs'
import { STRUCTURED_INGESTION_SCHEDULE_ENV, structuredIngestionScheduled } from '@common/types'
import { STRUCTURED_INGESTION_JOB } from './jobs.js'
import { getStructuredQueue } from './queue.js'
import type { JobSpec } from './types.js'

export { STRUCTURED_INGESTION_SCHEDULE_ENV, structuredIngestionScheduled }

type SchedulingEnv = Record<string, string | undefined>

/** The structured job when scheduling is enabled, otherwise nothing to submit. */
export function plannedStructuredIngestion(env: SchedulingEnv = process.env): JobSpec | null {
  return structuredIngestionScheduled(env) ? STRUCTURED_INGESTION_JOB : null
}

interface StructuredSubmissionDeps {
  add: (
    name: string,
    data: { spec: JobSpec; parentRunId: string; isRoot: true },
    opts: Record<string, unknown>,
  ) => Promise<{ id?: string | null }>
  recordStart: (input: RecordStartInput) => string
  recordEnd: (runId: string, input: RecordEndInput) => void
}

const defaultDeps = (): StructuredSubmissionDeps => ({
  add: (name, data, opts) => getStructuredQueue().add(name, data, opts),
  recordStart,
  recordEnd,
})

/**
 * Parent-run stage for an independently scheduled structured submission.
 * Declared in reconcile.ts beside DAILY_PARENT_STAGE — stage-based routing needs
 * both in one place — and re-exported here for submission call sites.
 */
export { STRUCTURED_PARENT_STAGE } from './reconcile.js'
import { STRUCTURED_PARENT_STAGE as STRUCTURED_STAGE } from './reconcile.js'

export interface StructuredSubmission {
  parentRunId: string
  jobId: string
}

/**
 * Submit the optional structured job under its own run authority. It is not a
 * child of the daily flow, so its failure cannot block or close that flow.
 */
export async function submitScheduledStructuredIngestion(
  env: SchedulingEnv = process.env,
  deps: StructuredSubmissionDeps = defaultDeps(),
): Promise<StructuredSubmission | null> {
  const spec = plannedStructuredIngestion(env)
  if (!spec) return null

  const parentRunId = deps.recordStart({
    stage: STRUCTURED_STAGE,
    source: 'queue',
    metadata: { scheduling: 'scheduled', independent: true, stage: spec.name },
  })

  try {
    const retry = spec.retry ?? { attempts: 3, backoffMs: 60_000 }
    const job = await deps.add(spec.name, { spec, parentRunId, isRoot: true }, {
      attempts: retry.attempts,
      backoff: { type: 'exponential', delay: retry.backoffMs },
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    })
    return { parentRunId, jobId: String(job.id ?? '') }
  } catch (err) {
    deps.recordEnd(parentRunId, {
      status: 'failed',
      error: { message: err instanceof Error ? err.message : String(err) },
      metadata: { failedBeforeExecution: true },
    })
    throw err
  }
}
