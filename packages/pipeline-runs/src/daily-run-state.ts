import type { Database } from 'better-sqlite3'

/**
 * ── Scheduler semantics for the daily pipeline ─────────────────────────────
 *
 * THE CONTRACT:
 *
 *   Exactly one daily-pipeline run is expected per LOGICAL RUN DATE. The
 *   logical date is a business concept; the physical execution time is not.
 *   A laptop that is asleep at the due hour executes late, and that is normal
 *   for this deployment — it is not a failure.
 *
 *   The failure is: the machine became available, and the expected run still
 *   did not start within a grace period.
 *
 * WHY THIS EXISTS. Between 2026-07-06 and 2026-08-22 the 07:00 calendar
 * trigger fired on time every single day. From 2026-08-23 it fired at ~21:00
 * on four days and not at all on 2026-08-27 — launchd defers a missed
 * StartCalendarInterval to "the next wake", and that deferral proved
 * unreliable. Binding the job to ONE calendar instant makes the whole pipeline
 * depend on the machine being awake at that instant.
 *
 * So eligibility is decided HERE, from recorded state, and the scheduler
 * merely supplies frequent execution opportunities. Correctness does not
 * depend on launchd catching anything up.
 *
 * NO PARALLEL TRUTH SOURCE. Every judgement below reads `pipeline_runs`, the
 * observability layer that already exists. The only new state is a heartbeat
 * file, which records something pipeline_runs cannot: whether the machine was
 * ever AWAKE to run at all.
 */

export const DAILY_STAGE = 'daily-pipeline'

/** Hour (local) at which a logical run becomes due. */
export const DUE_HOUR = 7

/**
 * A run still in `running` after this long is an orphan, not progress.
 *
 * Derived from measurement, not chosen: successful daily-pipeline runs over
 * 2026-08-17..2026-08-25 took 27, 30, 31, 31, 33, 34 and 61 minutes. The three
 * pathological ones took 83, 1463 and 2860 minutes. 90 minutes sits above every
 * healthy run (including the 61-minute outlier) and far below every stuck one.
 */
export const STALE_AFTER_MIN = 90

/**
 * How long after the machine is demonstrably awake before a missing run counts
 * as a failure rather than as "hasn't got to it yet".
 *
 * Derived: the trigger-to-submission latency measured on 2026-08-26 was ~1
 * second (fire 21:03:32 -> submit 21:03:33). The scheduler polls every 15
 * minutes, so a missed opportunity is retried within one interval. 30 minutes
 * is two full intervals — long enough that a single skipped poll is not an
 * alert, short enough to catch a genuinely dead scheduler the same morning.
 */
export const OPPORTUNITY_GRACE_MIN = 30

export type DailyRunState =
  | 'not_due'          // the logical date's due hour has not arrived
  | 'no_opportunity'   // due, but the machine has not been awake since — NOT a failure
  | 'missing'          // due, machine was awake past the grace period, still no run
  | 'running'          // in progress, within the healthy window
  | 'stale'            // in `running` past STALE_AFTER_MIN — orphaned
  | 'failed'           // ran and failed; explicitly NOT the same as never having run
  | 'success'

export interface DailyRunAssessment {
  logicalDate: string
  state: DailyRunState
  runId: string | null
  startedAt: string | null
  endedAt: string | null
  /** Minutes the run has been in `running`, when applicable. */
  runningForMin: number | null
  /** Last time the scheduler demonstrated the machine was awake. */
  lastHeartbeat: string | null
  /** True when this execution opportunity should start the run. */
  eligibleToRun: boolean
  /** True when a human should be told. */
  shouldAlert: boolean
  reason: string
}

/** The logical run date for a given instant: the local calendar date. */
export function logicalRunDate(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The instant a logical date's run becomes due, in local time. */
export function dueAt(logicalDate: string, dueHour = DUE_HOUR): Date {
  const [y, m, d] = logicalDate.split('-').map(Number)
  return new Date(y, m - 1, d, dueHour, 0, 0, 0)
}

interface RunRow {
  id: string
  started_at: string
  ended_at: string | null
  status: string
}

/**
 * The daily-pipeline row for a logical date, if any.
 *
 * Matched on the LOCAL date of started_at, because started_at is stored as UTC
 * ISO and the logical date is a local business date — comparing them naively
 * mis-buckets every run between 17:00 and midnight local (+07).
 */
export function findRunForDate(db: Database, logicalDate: string): RunRow | null {
  const rows = db.prepare(
    `SELECT id, started_at, ended_at, status
       FROM pipeline_runs
      WHERE stage = ?
        AND date(started_at, 'localtime') = ?
      ORDER BY started_at DESC`,
  ).all(DAILY_STAGE, logicalDate) as RunRow[]
  if (rows.length === 0) return null
  // A success anywhere in the day settles it, whatever came before.
  return rows.find(r => r.status === 'success') ?? rows[0]
}

export interface AssessInput {
  db: Database
  now: Date
  /**
   * Every scheduler heartbeat available (most recent window is enough).
   *
   * The LAST heartbeat alone is not sufficient, and getting this wrong was a
   * real bug in the first draft: a machine that wakes at 10:13 and a machine
   * that has been awake since 07:00 doing nothing both have a "last heartbeat"
   * of 10:13. Only the FIRST heartbeat after the due time says how long the
   * machine has actually been available to run.
   */
  heartbeats: Date[]
  dueHour?: number
  staleAfterMin?: number
  graceMin?: number
}

/**
 * Decide what state the current logical day is in, and what should happen.
 *
 * Deliberately returns a STATE, not a boolean. Absence, failure, orphaning and
 * success are four different things and the previous logic collapsed them:
 * `status IN ('running','success')` treated a 24-hour-old orphan as a completed
 * run, and an absent run produced no signal at all because the only alert was
 * gated on a failure row existing.
 */
export function assessDailyRun(input: AssessInput): DailyRunAssessment {
  const { db, now } = input
  const heartbeats = [...input.heartbeats].sort((a, b) => a.getTime() - b.getTime())
  const lastHeartbeat = heartbeats.length ? heartbeats[heartbeats.length - 1] : null
  const dueHour = input.dueHour ?? DUE_HOUR
  const staleAfterMin = input.staleAfterMin ?? STALE_AFTER_MIN
  const graceMin = input.graceMin ?? OPPORTUNITY_GRACE_MIN

  const logicalDate = logicalRunDate(now)
  const due = dueAt(logicalDate, dueHour)
  const run = findRunForDate(db, logicalDate)

  const base = {
    logicalDate,
    runId: run?.id ?? null,
    startedAt: run?.started_at ?? null,
    endedAt: run?.ended_at ?? null,
    runningForMin: null as number | null,
    lastHeartbeat: lastHeartbeat?.toISOString() ?? null,
  }

  if (run?.status === 'success') {
    return { ...base, state: 'success', eligibleToRun: false, shouldAlert: false,
      reason: `daily-pipeline succeeded for ${logicalDate}` }
  }

  if (run?.status === 'running') {
    const min = Math.floor((now.getTime() - new Date(run.started_at).getTime()) / 60_000)
    if (min >= staleAfterMin) {
      // An orphan must not look like progress, and must not block the day
      // forever either — but re-running is a production mutation, so this
      // reports rather than acts.
      return { ...base, state: 'stale', runningForMin: min, eligibleToRun: false, shouldAlert: true,
        reason: `daily-pipeline has been 'running' for ${min}min (>= ${staleAfterMin}) — orphaned, never received recordEnd` }
    }
    return { ...base, state: 'running', runningForMin: min, eligibleToRun: false, shouldAlert: false,
      reason: `daily-pipeline in progress for ${min}min` }
  }

  if (run?.status === 'failed') {
    // Explicit policy: a failed run is NOT treated as "never ran". Auto-retry
    // risks repeating the same failure at real API cost, so this alerts and
    // leaves the decision to a human.
    return { ...base, state: 'failed', eligibleToRun: false, shouldAlert: true,
      reason: `daily-pipeline failed for ${logicalDate} — not auto-retried` }
  }

  // No run row for this logical date.
  if (now < due) {
    return { ...base, state: 'not_due', eligibleToRun: false, shouldAlert: false,
      reason: `not due until ${due.toISOString()}` }
  }

  // Due, and nothing has run. Was the machine even awake to try — and if so,
  // for how long? Availability is measured from the FIRST heartbeat after the
  // due time, not the most recent one.
  const firstSinceDue = heartbeats.find(h => h >= due) ?? null
  if (!firstSinceDue) {
    return { ...base, state: 'no_opportunity', eligibleToRun: true, shouldAlert: false,
      reason: 'due, but the scheduler has not run since the due time — machine was unavailable. ' +
              'Not a failure; this opportunity should start it.' }
  }

  const awakeMin = Math.floor((now.getTime() - firstSinceDue.getTime()) / 60_000)
  if (awakeMin < graceMin) {
    return { ...base, state: 'no_opportunity', eligibleToRun: true, shouldAlert: false,
      reason: `due, machine awake for ${awakeMin}min (< ${graceMin}min grace) — starting, not alerting yet` }
  }

  return { ...base, state: 'missing', eligibleToRun: true, shouldAlert: true,
    reason: `no daily-pipeline run for ${logicalDate}; the machine has been available for ` +
            `${awakeMin}min past the ${dueHour}:00 due time (grace ${graceMin}min). ` +
            'Absence is a failure, not a healthy state.' }
}
