// Submit the daily pipeline — chains jobs so each one waits for its
// dependsOn predecessor before starting.
//
// Pattern: submit job N with dependency on job N-1's jobId. BullMQ's
// flow producer (FlowProducer.add) handles this natively, but our linear
// chain is simple enough to roll by hand: we submit each job with the
// `parent` field referencing the previous job's id.

import { FlowProducer } from 'bullmq'
import { recordStart, recordEnd } from '@common/pipeline-runs'
import { QUEUE_NAME, connectionOptions, getQueue, getQueueEvents } from './queue.js'
import { DAILY_PIPELINE } from './jobs.js'
import type { JobSpec } from './types.js'

const DEFAULT_RETRY = { attempts: 3, backoffMs: 60_000 }

interface FlowNode {
  name:      string
  queueName: string
  data:      { spec: JobSpec; parentRunId: string | null; isRoot?: boolean }
  opts: {
    attempts: number
    backoff:  { type: 'exponential'; delay: number }
    removeOnComplete: { count: number }
    removeOnFail:     { count: number }
  }
  children: FlowNode[]
}

function buildFlowNode(
  spec: JobSpec,
  parentRunId: string | null,
  children: FlowNode[] = [],
  isRoot: boolean = false,
): FlowNode {
  const retry = spec.retry ?? DEFAULT_RETRY
  return {
    name:  spec.name,
    queueName: QUEUE_NAME,
    data:  { spec, parentRunId, ...(isRoot ? { isRoot: true } : {}) },
    opts: {
      attempts: retry.attempts,
      backoff:  { type: 'exponential' as const, delay: retry.backoffMs },
      // Each retry waits backoffMs * 2^(attempt - 1) before re-running.
      removeOnComplete: { count: 100 },   // keep the last 100 completed for debugging
      removeOnFail:     { count: 100 },
    },
    children,
  }
}

/** Normalize `dependsOn` (string | string[] | undefined) into a string[]. */
function depsOf(spec: JobSpec): string[] {
  if (!spec.dependsOn) return []
  return Array.isArray(spec.dependsOn) ? spec.dependsOn : [spec.dependsOn]
}

/**
 * Filter out jobs whose `skipIf()` returns true and rewrite the remaining
 * jobs' `dependsOn` to skip over dropped ancestors. If a job depended on a
 * now-skipped job, walk that skipped job's own dependsOn transitively until
 * we hit an active ancestor (or run out).
 *
 * Example: on a weekday `scenario-discover` and `people-tweets` are both
 * skipped. `briefing-backtest.dependsOn` was `people-tweets` — after
 * resolution it becomes `scenario-simulate` (people-tweets → scenario-discover
 * → scenario-simulate is the first non-skipped ancestor).
 */
export function resolveSkips(all: JobSpec[]): JobSpec[] {
  const byName    = new Map(all.map(s => [s.name, s]))
  const isSkipped = new Map<string, boolean>(
    all.map(s => [s.name, !!(s.skipIf && s.skipIf())]),
  )

  // For a given dep name, walk up its dependsOn until we find one that isn't
  // skipped. Returns [] if every ancestor along the way is skipped.
  const resolveDep = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return []
    seen.add(name)
    if (!isSkipped.get(name)) return [name]
    const spec = byName.get(name)
    if (!spec) return []
    const out: string[] = []
    for (const parent of depsOf(spec)) {
      for (const resolved of resolveDep(parent, seen)) {
        if (!out.includes(resolved)) out.push(resolved)
      }
    }
    return out
  }

  const active = all.filter(s => !isSkipped.get(s.name))
  return active.map(spec => {
    const originalDeps = depsOf(spec)
    const resolved: string[] = []
    for (const dep of originalDeps) {
      for (const r of resolveDep(dep)) {
        if (!resolved.includes(r)) resolved.push(r)
      }
    }
    // Preserve original single-string vs array shape when possible so downstream
    // code that inspects the spec sees the natural form. Skipped-only deps
    // collapse to `undefined` (no remaining upstream — this job becomes a leaf).
    let dependsOn: string | string[] | undefined
    if (resolved.length === 0)      dependsOn = undefined
    else if (resolved.length === 1) dependsOn = resolved[0]
    else                            dependsOn = resolved
    return { ...spec, dependsOn }
  })
}

/**
 * Build a BullMQ FlowProducer tree from a set of active JobSpecs whose
 * dependsOn already points at other active jobs. BullMQ semantics: `children`
 * run BEFORE their parent — so `children` == "this job's dependencies".
 *
 * We find THE ONE root — the job that no other active job depends on — and
 * recurse downward, creating one FlowNode per active job. Throws if the DAG
 * has zero roots (cycle) or more than one (disconnected — unexpected here).
 */
export function buildDAGTree(stages: JobSpec[], parentRunId: string): FlowNode {
  const byName = new Map(stages.map(s => [s.name, s]))

  // Every job listed as a dependency has "incoming edges"; the job(s) with
  // none are roots.
  const hasDependents = new Set<string>()
  for (const s of stages) {
    for (const dep of depsOf(s)) {
      if (byName.has(dep)) hasDependents.add(dep)
    }
  }
  const roots = stages.filter(s => !hasDependents.has(s.name))
  if (roots.length === 0) {
    throw new Error('buildDAGTree: no root job found — DAG likely has a cycle')
  }
  if (roots.length > 1) {
    throw new Error(
      `buildDAGTree: expected exactly one root, got ${roots.length}: ${roots.map(r => r.name).join(', ')}`,
    )
  }
  const rootName = roots[0].name

  const visited = new Set<string>()

  const buildNode = (name: string): FlowNode => {
    if (visited.has(name)) {
      throw new Error(
        `buildDAGTree: job "${name}" reached twice — cycle or shared dependency; BullMQ flow trees cannot express diamonds`,
      )
    }
    visited.add(name)
    const spec = byName.get(name)
    if (!spec) throw new Error(`buildDAGTree: unknown job "${name}"`)
    const children = depsOf(spec)
      .filter(dep => byName.has(dep))
      .map(dep => buildNode(dep))
    return buildFlowNode(spec, parentRunId, children, name === rootName)
  }

  return buildNode(rootName)
}

/**
 * Submit the full daily pipeline as a chain. Returns the top-level
 * pipeline_runs row id so the caller can join logs back.
 */
export async function submitDailyPipeline(): Promise<{ parentRunId: string; rootJobId: string }> {
  // Apply skipIf at submit time. Function references don't survive Redis
  // serialization (BullMQ JSON-encodes job data), so a worker-side skipIf
  // check would always see `undefined`. Resolving here removes Sunday-only
  // stages on weekdays before they ever hit the queue and rewrites the deps
  // of anyone downstream so they still connect to a live ancestor.
  const active = resolveSkips(DAILY_PIPELINE)
  if (active.length === 0) {
    throw new Error('submitDailyPipeline: all stages were skipped — nothing to submit')
  }

  const activeNames = new Set(active.map(s => s.name))

  // Root row in pipeline_runs.db: represents "the daily.sh run as a whole".
  // All per-stage rows nest under this via parent_run_id.
  const parentRunId = recordStart({
    stage:    'daily-pipeline',
    source:   'queue',
    metadata: {
      stages:        active.map(s => s.name),
      skippedStages: DAILY_PIPELINE.filter(s => !activeNames.has(s.name)).map(s => s.name),
    },
  })

  const startedAt = Date.now()
  let producer: FlowProducer | null = null
  try {
    producer = new FlowProducer({ connection: connectionOptions() })

    // BullMQ FlowProducer expects: parent → children. children run BEFORE parent.
    // Our DAG uses dependsOn as "children" — a job's dependsOn IS its list of
    // BullMQ children. buildDAGTree finds the unique root (morning-status —
    // nothing depends on it), then recurses down each dependsOn edge.
    //
    //   root: morning-status
    //     child: investment-brief
    //       children: ai-analysis-engine, risk-metrics, wave-analyzer
    //         (each fans out further)
    //
    // BullMQ runs children depth-first then bubbles success up to the parent,
    // so independent subtrees (e.g. wave-analyzer vs ai-analysis-engine) can
    // execute in parallel. The root is flagged isRoot:true so the worker knows
    // to close the parent pipeline_runs row when it succeeds.
    const node = buildDAGTree(active, parentRunId)

    const flow = await producer.add(node)

    return { parentRunId, rootJobId: flow.job.id ?? '' }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    recordEnd(parentRunId, {
      status: 'failed',
      error: { message: errorMessage },
      metadata: { durationMs: Date.now() - startedAt },
    })
    throw err
  } finally {
    if (producer) await producer.close()
  }
}

/**
 * Submit the daily pipeline and block until the whole flow completes or fails.
 * Returns the final status so the caller (cron wrapper) can set its exit code.
 *
 * Closes the parent pipeline_runs row at the end so the dashboard shows the
 * overall run as success/failed rather than perpetually "running".
 */
export async function submitAndWait(): Promise<{ parentRunId: string; status: 'success' | 'failed' }> {
  const { parentRunId, rootJobId } = await submitDailyPipeline()
  const startedAt = Date.now()

  const queue        = getQueue()
  const queueEvents  = getQueueEvents()
  const rootJob      = await queue.getJob(rootJobId)
  if (!rootJob) {
    throw new Error(`submitAndWait: root job ${rootJobId} missing from queue right after submit`)
  }

  let status: 'success' | 'failed'
  let errorMessage: string | null = null
  try {
    // No timeout — the daily pipeline can legitimately take >1h on Sundays
    // (world-intel pipeline + people-tweets + scenario-discover all run).
    await rootJob.waitUntilFinished(queueEvents)
    status = 'success'
  } catch (err) {
    status       = 'failed'
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  recordEnd(parentRunId, {
    status,
    error: errorMessage ? { message: errorMessage } : null,
    metadata: { durationMs: Date.now() - startedAt, rootJobId },
  })

  return { parentRunId, status }
}
