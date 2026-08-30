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
/**
 * How to read a flow whose only remaining trace is a failed root.
 *
 * The daily DAG keeps `unknown` for that shape: it is a multi-stage tree, a
 * failed-only snapshot there can mean several things, and guessing would
 * transition a parent we do not understand.
 *
 * The structured flow is a SINGLE job submitted with `removeOnFail: false`, so a
 * retained failed root with nothing runnable is not ambiguous — it is the
 * terminal state, and leaving it `unknown` left the parent row `running`
 * forever. The policy is passed explicitly from the structured call site;
 * structured identity is never inferred from a job name.
 */
export interface FlowPolicy {
  /** True only for single-root flows where a retained failed root is terminal. */
  retainedFailedRootIsTerminal: boolean
}
export const DAILY_FLOW_POLICY: FlowPolicy = { retainedFailedRootIsTerminal: false }
export const STRUCTURED_FLOW_POLICY: FlowPolicy = { retainedFailedRootIsTerminal: true }

export function assessFlow(
  parentRunId: string,
  dbStatus: string,
  dbStartedAt: string,
  snap: QueueSnapshot,
  policy: FlowPolicy = DAILY_FLOW_POLICY,
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
  const rootFailed    = snap.failed.some(j => belongsTo(j, parentRunId) && j.data?.isRoot === true)

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

  // 4b. A retained failed ROOT with nothing runnable and nothing parked. For a
  //     single-root flow submitted with removeOnFail: false this is exactly the
  //     terminal shape — the job is finished, failed, and kept for inspection.
  //     Retries are already excluded by branch 1 (delayed counts as runnable),
  //     so reaching here means no attempt remains.
  if (policy.retainedFailedRootIsTerminal && rootFailed) {
    return { ...base, assessment: 'terminal_failed', proposedTransition: 'running -> failed',
      reason: `root job failed and is retained (${failed} failed, none runnable, none parked) — ` +
              'terminal for a single-root flow' }
  }

  // 5. Jobs failed, none parked, none runnable, root never completed. Almost
  //    certainly terminal, but the shape is not one we have observed, so it is
  //    reported rather than acted on.
  return { ...base, assessment: 'unknown', proposedTransition: null,
    reason: `${failed} failed, ${completed} completed, none runnable, none parked, root did not complete — ` +
            'shape not recognised; refusing to guess' }
}

/** The parent stage of the main daily flow. */
export const DAILY_PARENT_STAGE = 'daily-pipeline'

/**
 * The parent stage of an independently scheduled structured run. Declared here
 * beside its daily counterpart so routing can be decided from stage alone,
 * without importing the submission module.
 */
export const STRUCTURED_PARENT_STAGE = 'structured-ingestion-scheduled'

/**
 * Every parent row of one stage still claiming to run.
 *
 * The stage is a parameter because independently scheduled structured
 * ingestion opens its own parent rows under a DIFFERENT stage. Those rows were
 * previously invisible here, so a structured job that died outside the normal
 * processor failure path left its parent `running` forever.
 *
 * Each stage is queried and assessed separately against its OWN queue snapshot,
 * so reconciling one can never transition a row belonging to the other.
 */
export function openParents(
  dbPath = resolveDbPath(),
  stage: string = DAILY_PARENT_STAGE,
): Array<{ id: string; started_at: string; status: string }> {
  const db = openDbReadOnly(dbPath)
  return db.prepare(
    `SELECT id, started_at, status FROM pipeline_runs
      WHERE stage = ? AND status = 'running'
      ORDER BY started_at`,
  ).all(stage) as Array<{ id: string; started_at: string; status: string }>
}

// ── Applying transitions ─────────────────────────────────────────────────────

/** Minimal surface of a writable better-sqlite3 handle, so tests can inject one. */
export interface WritableRunStore {
  /** better-sqlite3's RunResult: `changes` is the number of rows actually written. */
  prepare(sql: string): { run(...params: unknown[]): { changes?: number } }
}

/**
 * Write the terminal transitions an assessment set proposes.
 *
 * The database handle is INJECTED. The CLI previously opened the store with
 * openDbReadOnly() and then issued UPDATEs under --apply, so the advertised
 * transition could never succeed. Dry-run must never obtain a writable handle,
 * which is only expressible if the caller owns the connection.
 *
 * Only unambiguous assessments are written; `unknown` and `in_progress` are
 * skipped. The WHERE clause keeps `status = 'running'`, so a row closed by
 * anything else in the meantime is left alone.
 */
export function applyTransitions(results: FlowAssessment[], db: WritableRunStore): number {
  let changed = 0
  for (const r of results) {
    if (r.assessment !== 'terminal_success' && r.assessment !== 'terminal_failed' && r.assessment !== 'terminal_removed') {
      continue
    }
    const status = r.assessment === 'terminal_success' ? 'success' : 'failed'
    // Compare-and-set: `status = 'running'` keeps another process's close from
    // being overwritten. It also means the UPDATE can legitimately match zero
    // rows, so the applied count must come from what SQLite actually wrote —
    // counting attempts reported transitions that never happened.
    const result = db.prepare(
      `UPDATE pipeline_runs
          SET status = ?, ended_at = ?,
              error_message = COALESCE(error_message, ?)
        WHERE id = ? AND status = 'running'`,
    ).run(status, new Date().toISOString(), `reconciled: ${r.reason}`, r.parentRunId)
    changed += result?.changes ?? 0
  }
  return changed
}

// ── Explicit-parent routing ──────────────────────────────────────────────────

export interface ParentRowWithStage extends ParentRow { stage: string }

/** One snapshot per execution lane. */
export interface LaneSnapshots { main: QueueSnapshot; structured: QueueSnapshot }

export type RoutedAssessment =
  | { ok: true;  stage: string; assessment: FlowAssessment }
  | { ok: false; stage: string; error: string }

/**
 * Choose the queue snapshot and policy for ONE explicitly selected parent, from
 * its stage.
 *
 * `--parent` previously selected a row without its stage, dropped it into the
 * daily collection and assessed it against the MAIN snapshot under the daily
 * policy. A structured parent has no job in that snapshot, so a perfectly live
 * structured run assessed as `terminal_removed` — and with `--apply` the CLI
 * would have closed it as failed.
 *
 * An unrecognised stage is refused rather than defaulted: guessing a lane is
 * exactly the failure being fixed.
 */
export function routeParentAssessment(row: ParentRowWithStage, lanes: LaneSnapshots): RoutedAssessment {
  if (row.stage === DAILY_PARENT_STAGE) {
    return { ok: true, stage: row.stage,
      assessment: assessFlow(row.id, row.status, row.started_at, lanes.main, DAILY_FLOW_POLICY) }
  }
  if (row.stage === STRUCTURED_PARENT_STAGE) {
    return { ok: true, stage: row.stage,
      assessment: assessFlow(row.id, row.status, row.started_at, lanes.structured, STRUCTURED_FLOW_POLICY) }
  }
  return {
    ok: false, stage: row.stage,
    error: `parent ${row.id} has stage "${row.stage}", which is not a reconcilable flow parent ` +
           `(expected "${DAILY_PARENT_STAGE}" or "${STRUCTURED_PARENT_STAGE}") — refusing to guess a queue or policy`,
  }
}

// ── Queue health ─────────────────────────────────────────────────────────────

export interface ParentRow { id: string; started_at: string; status: string }

export interface QueueHealthInput {
  main:       { snap: QueueSnapshot; parents: ParentRow[] }
  structured: { snap: QueueSnapshot; parents: ParentRow[] }
}

export interface QueueHealthReport {
  healthy:         boolean
  problems:        string[]
  dailyStuck:      FlowAssessment[]
  structuredStuck: FlowAssessment[]
}

const isDead = (a: FlowAssessment) => a.assessment === 'terminal_failed' || a.assessment === 'terminal_removed'

/**
 * Assess each lane against ITS OWN snapshot.
 *
 * Health previously counted open structured parents without assessing them, so
 * a terminally stuck structured run could sit behind a HEALTHY verdict. The two
 * lanes are evaluated separately and their problems reported separately: a
 * structured assessment can never be produced from the main snapshot, so
 * structured state cannot contaminate daily health.
 */
export function classifyQueueHealth(input: QueueHealthInput): QueueHealthReport {
  const dailyStuck = input.main.parents
    .map(p => assessFlow(p.id, p.status, p.started_at, input.main.snap, DAILY_FLOW_POLICY))
    .filter(isDead)

  const structuredStuck = input.structured.parents
    .map(p => assessFlow(p.id, p.status, p.started_at, input.structured.snap, STRUCTURED_FLOW_POLICY))
    .filter(isDead)

  const problems: string[] = []
  if (dailyStuck.length > 0) {
    problems.push(`${dailyStuck.length} daily parent row(s) still 'running' with a dead DAG`)
  }
  if (structuredStuck.length > 0) {
    problems.push(`${structuredStuck.length} structured run(s) terminally failed or removed while still 'running'`)
  }
  return { healthy: problems.length === 0, problems, dailyStuck, structuredStuck }
}
