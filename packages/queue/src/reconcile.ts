import type { Job, Queue } from 'bullmq'
import { openDbReadOnly, resolveDbPath } from '@common/pipeline-runs'

/**
 * ── Terminal-event reconciliation ──────────────────────────────────────────
 *
 * THE INVARIANT:
 *
 *   If a DAG can no longer make progress, its persisted parent must eventually
 *   stop saying `running`.
 *
 * WHY THIS EXISTS. On 2026-08-26 and again on 2026-08-27 a daily pipeline died
 * with its parent row left `running` forever. `processor.ts` closes the parent
 * on exactly two paths — the root job succeeding, and a throw inside the
 * processor after exhausted attempts. BullMQ's stalled-job path takes NEITHER:
 * the stalled-checker moves the job to `failed` without the processor ever
 * running, so nothing closes the parent. On 08-27, 24 stages ran, ZERO recorded
 * `failed`, and the BullMQ failed set still grew by two.
 *
 * So reconciliation must not read the processor's control flow. It reads the
 * QUEUE, which is the authority on what can still execute.
 *
 * STALL IS NOT TERMINAL. A stall followed by legitimate redelivery is normal on
 * a laptop that suspends — that is the ordinary case here, not the exception.
 * This never concludes from a stall EVENT. It concludes from the eventual
 * queue STATE: are there descendants that can still run?
 *
 * WHEN IN DOUBT IT REPORTS `unknown` AND CHANGES NOTHING. A wrong `failed` on a
 * live run is worse than a late one on a dead run.
 */

export type TerminalAssessment =
  | 'in_progress'      // runnable descendants exist — not terminal, leave alone
  | 'terminal_success' // the root completed
  | 'terminal_failed'  // no descendant can ever run again
  | 'terminal_removed' // the flow's jobs are gone entirely
  | 'unknown'          // cannot determine — never guess

export interface FlowAssessment {
  parentRunId: string
  dbStatus: string
  dbStartedAt: string
  /** Jobs that could still execute: active + wait + delayed + prioritized. */
  runnable: number
  /** Jobs parked in waiting-children. */
  blocked: number
  failed: number
  completed: number
  rootCompleted: boolean
  assessment: TerminalAssessment
  proposedTransition: string | null
  reason: string
}

interface JobLike { id?: string | null; name: string; data?: { parentRunId?: string | null; isRoot?: boolean } }

export interface QueueSnapshot {
  active: JobLike[]
  wait: JobLike[]
  delayed: JobLike[]
  prioritized: JobLike[]
  waitingChildren: JobLike[]
  failed: JobLike[]
  completed: JobLike[]
}

/** Read every job the queue still holds, grouped by state. Pure read. */
export async function snapshotQueue(queue: Queue): Promise<QueueSnapshot> {
  const grab = async (type: string): Promise<JobLike[]> => {
    const jobs = (await queue.getJobs([type as never], 0, 5000, true)) as Job[]
    return jobs.filter(Boolean).map(j => ({ id: j.id, name: j.name, data: j.data as JobLike['data'] }))
  }
  return {
    active:          await grab('active'),
    wait:            await grab('wait'),
    delayed:         await grab('delayed'),
    prioritized:     await grab('prioritized'),
    waitingChildren: await grab('waiting-children'),
    failed:          await grab('failed'),
    completed:       await grab('completed'),
  }
}

const belongsTo = (j: JobLike, parentRunId: string) => j.data?.parentRunId === parentRunId

/**
 * Assess one open parent row against the queue.
 *
 * Deliberately conservative: anything that could still run means `in_progress`,
 * whatever else is true.
 */
export function assessFlow(
  parentRunId: string,
  dbStatus: string,
  dbStartedAt: string,
  snap: QueueSnapshot,
): FlowAssessment {
  const runnable =
    snap.active.filter(j => belongsTo(j, parentRunId)).length +
    snap.wait.filter(j => belongsTo(j, parentRunId)).length +
    snap.delayed.filter(j => belongsTo(j, parentRunId)).length +
    snap.prioritized.filter(j => belongsTo(j, parentRunId)).length

  const blocked   = snap.waitingChildren.filter(j => belongsTo(j, parentRunId)).length
  const failed    = snap.failed.filter(j => belongsTo(j, parentRunId)).length
  const completed = snap.completed.filter(j => belongsTo(j, parentRunId)).length
  const rootCompleted = snap.completed.some(j => belongsTo(j, parentRunId) && j.data?.isRoot === true)

  const base = { parentRunId, dbStatus, dbStartedAt, runnable, blocked, failed, completed, rootCompleted }

  // 1. Anything runnable wins. A job in `delayed` is a pending RETRY — the
  //    normal shape of a stall followed by legitimate redelivery — and must
  //    never be read as terminal.
  if (runnable > 0) {
    return { ...base, assessment: 'in_progress', proposedTransition: null,
      reason: `${runnable} descendant(s) still runnable (active/wait/delayed/prioritized) — not terminal` }
  }

  // 2. The root finished. Whatever else happened, the DAG achieved its purpose.
  if (rootCompleted) {
    return { ...base, assessment: 'terminal_success', proposedTransition: 'running -> success',
      reason: 'root job completed' }
  }

  // 3. Nothing can run and descendants are parked forever. This is 08-26/08-27.
  if (blocked > 0) {
    return { ...base, assessment: 'terminal_failed', proposedTransition: 'running -> failed',
      reason: `no runnable descendants and ${blocked} parked in waiting-children with ` +
              `${failed} permanently failed — the chain can never be released` }
  }

  // 4. No trace of the flow at all.
  if (failed === 0 && completed === 0 && blocked === 0) {
    return { ...base, assessment: 'terminal_removed', proposedTransition: 'running -> failed',
      reason: 'no jobs for this parentRunId remain in the queue — flow removed or retention-expired ' +
              'before completion' }
  }

  // 5. Jobs failed, none parked, none runnable, root never completed. Almost
  //    certainly terminal, but the shape is not one we have observed, so it is
  //    reported rather than acted on.
  return { ...base, assessment: 'unknown', proposedTransition: null,
    reason: `${failed} failed, ${completed} completed, none runnable, none parked, root did not complete — ` +
            'shape not recognised; refusing to guess' }
}

/** Every `daily-pipeline` row still claiming to run. */
export function openParents(dbPath = resolveDbPath()): Array<{ id: string; started_at: string; status: string }> {
  const db = openDbReadOnly(dbPath)
  return db.prepare(
    `SELECT id, started_at, status FROM pipeline_runs
      WHERE stage = 'daily-pipeline' AND status = 'running'
      ORDER BY started_at`,
  ).all() as Array<{ id: string; started_at: string; status: string }>
}
