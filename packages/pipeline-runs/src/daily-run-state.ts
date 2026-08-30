import type { Database } from 'better-sqlite3'
import { hasScheduledIdentity } from './store.js'

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
  | 'timeout'          // exceeded its SLA; terminal, never auto-retried
  | 'killed'           // SIGTERM/SIGKILL; terminal, never auto-retried
  | 'unknown'          // a persisted status this version does not recognise
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

/**
 * The canonical business timezone. Logical dates and the due hour are defined
 * here and nowhere else.
 *
 * Previously both were computed from the HOST's timezone (`now.getFullYear()`,
 * `new Date(y, m-1, d, 7)`, and SQLite `date(started_at,'localtime')`), so the
 * same database read on a machine in Asia/Bangkok and one in Los Angeles
 * disagreed about which day a run belonged to — and a laptop that travels
 * silently changes the schedule. The business day must not depend on where the
 * machine is.
 */
export const BUSINESS_TIMEZONE = 'America/Los_Angeles'

/**
 * Offset of `tz` from UTC at a given instant, in milliseconds.
 * Derived from Intl rather than a table, so DST is whatever the platform's
 * tzdata says it is — no timezone dependency is added.
 */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value
    return acc
  }, {})
  // `hour` can be "24" at midnight in some ICU versions; %24 normalises it.
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return asIfUtc - at.getTime()
}

/**
 * The UTC instant of a wall-clock time in `tz`.
 *
 * Two passes: guess with the offset at the naive instant, then re-measure the
 * offset AT that guess. One pass is wrong across a DST boundary, which is
 * exactly the day this has to be right on.
 */
function zonedWallClockToUtc(
  y: number, m: number, d: number, hour: number, tz: string,
): Date {
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0, 0)
  const firstGuess = naive - tzOffsetMs(new Date(naive), tz)
  const corrected  = naive - tzOffsetMs(new Date(firstGuess), tz)
  return new Date(corrected)
}

/** The logical run date for an instant: the calendar date in the BUSINESS timezone. */
/**
 * Is this a real calendar date in `YYYY-MM-DD` form?
 *
 * The canonical check for the whole logical-date vocabulary. `packages/queue`
 * re-exports it rather than keeping a second copy, so the scheduler, the queue
 * bin and the status CLI cannot drift on what they will accept.
 */
export function isValidLogicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

export function logicalRunDate(now: Date, tz: string = BUSINESS_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** The instant a logical date's run becomes due, in the BUSINESS timezone. */
export function dueAt(logicalDate: string, dueHour = DUE_HOUR, tz: string = BUSINESS_TIMEZONE): Date {
  const [y, m, d] = logicalDate.split('-').map(Number)
  return zonedWallClockToUtc(y, m, d, dueHour, tz)
}

/**
 * The UTC instant of a `HH:MM` wall-clock time on a business logical date.
 * Exported so callers and tests can express business time directly instead of
 * reconstructing the conversion (and getting DST wrong).
 */
export function businessInstant(
  logicalDate: string, hhmm: string, tz: string = BUSINESS_TIMEZONE,
): Date {
  const [y, m, d] = logicalDate.split('-').map(Number)
  const [h, min] = hhmm.split(':').map(Number)
  const base = zonedWallClockToUtc(y, m, d, h, tz)
  return new Date(base.getTime() + (min ?? 0) * 60_000)
}

/** [start, end) of a logical date in the business timezone, as UTC instants. */
export function businessDayBounds(logicalDate: string, tz: string = BUSINESS_TIMEZONE): { start: Date; end: Date } {
  const [y, m, d] = logicalDate.split('-').map(Number)
  const start = zonedWallClockToUtc(y, m, d, 0, tz)
  // Next calendar date, then its local midnight — correct across DST, where the
  // day is 23 or 25 hours long rather than 24.
  const nextUtc = new Date(Date.UTC(y, m - 1, d + 1))
  const end = zonedWallClockToUtc(
    nextUtc.getUTCFullYear(), nextUtc.getUTCMonth() + 1, nextUtc.getUTCDate(), 0, tz,
  )
  return { start, end }
}

interface RunRow {
  id: string
  started_at: string
  ended_at: string | null
  status: string
  /** Present only on the identity-aware path; the legacy query cannot select it. */
  logical_date?: string | null
}

/**
 * The daily-pipeline row for a logical date, if any.
 *
 * Matched on the LOCAL date of started_at, because started_at is stored as UTC
 * ISO and the logical date is a local business date — comparing them naively
 * mis-buckets every run between 17:00 and midnight local (+07).
 */
export function findRunForDate(db: Database, logicalDate: string, tz: string = BUSINESS_TIMEZONE): RunRow | null {
  // TWO REGIMES, AND THE SCHEMA DECIDES WHICH.
  //
  // Once the store carries scheduled-run identity, `logical_date` IS the day a
  // run belongs to: the scheduler stamps the date it APPROVED, so the row says
  // what it is for rather than being inferred from when it happened to start.
  // Inference by `started_at` cannot survive activation — a submission approved
  // for 2026-08-29 that begins at 00:02 Los Angeles time starts inside the
  // 08-30 window, so 08-30 reads as already satisfied and its real run is never
  // submitted, while 08-29 shows as missing. Both days are then wrong from one
  // late start.
  //
  // Before migration there is no such column, so status tooling falls back to
  // business-time attribution. That fallback is for READING a legacy store, not
  // a second source of truth: after migration it is never consulted.
  if (hasScheduledIdentity(db)) {
    const rows = db.prepare(
      `SELECT id, started_at, ended_at, status, logical_date
         FROM pipeline_runs
        WHERE stage = ?
          AND logical_date = ?
          AND superseded_at IS NULL
        ORDER BY started_at DESC`,
    ).all(DAILY_STAGE, logicalDate) as RunRow[]
    //  - logical_date IS NULL never matches `= ?` in SQL, so a manual or ad-hoc
    //    run cannot satisfy a scheduled day. That is deliberate: an operator
    //    running the pipeline by hand must not silently discharge the schedule.
    //  - superseded_at IS NOT NULL is excluded, so a replaced run does not keep
    //    answering for its date.
    return rows.length === 0 ? null : (rows.find(r => r.status === 'success') ?? rows[0])
  }

  // LEGACY FALLBACK ONLY.
  // Bounds are computed in the BUSINESS timezone and compared as UTC ISO
  // strings. SQLite's `localtime` was the host's timezone, so a run at 23:30
  // Los Angeles was filed under the wrong day on a +07 machine — and a run
  // that starts before LA midnight and ends after it stays attributed to
  // the business date it started in.
  const { start, end } = businessDayBounds(logicalDate, tz)
  const rows = db.prepare(
    `SELECT id, started_at, ended_at, status
       FROM pipeline_runs
      WHERE stage = ?
        AND started_at >= ?
        AND started_at <  ?
      ORDER BY started_at DESC`,
  ).all(DAILY_STAGE, start.toISOString(), end.toISOString()) as RunRow[]
  if (rows.length === 0) return null
  // A success anywhere in the day settles it, whatever came before.
  return rows.find(r => r.status === 'success') ?? rows[0]
}

export interface AssessInput {
  db: Database
  now: Date
  /**
   * Assess THIS logical date instead of the one `now` falls in.
   *
   * The scheduler approves a date, then re-checks eligibility under the lock
   * before submitting. Both evaluations must be about the SAME day. Without
   * this, the recheck recomputed the date from its own clock, so a fire that
   * crossed Los Angeles midnight between the two evaluations re-checked the
   * NEXT day — found it (correctly) missing or not due, and discarded a run
   * that had been properly approved for the previous one.
   *
   * `now` is still the real current instant: this narrows WHICH DAY is being
   * asked about, never what time it is. It is not a clock override.
   */
  logicalDate?: string
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

  // An explicitly requested day wins; otherwise the day `now` falls in.
  const logicalDate = input.logicalDate ?? logicalRunDate(now)
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

  // ── Terminal outcomes: recorded, never auto-retried ─────────────────────
  //
  // The assessment must be TOTAL over persisted statuses. Previously only
  // success/running/failed were handled, so a row with `timeout` or `killed`
  // fell through to the "no run row" path below and came back `missing` with
  // eligibleToRun: true — the scheduler would have resubmitted a day that had
  // already run and been killed. A status we do not recognise is the same
  // hazard, so it is named rather than ignored.
  const TERMINAL: Record<string, string> = {
    failed:  'failed',
    timeout: 'exceeded its SLA',
    killed:  'was killed (SIGTERM/SIGKILL)',
  }
  if (run && run.status !== 'success' && run.status !== 'running') {
    const known = TERMINAL[run.status]
    if (known) {
      return {
        ...base,
        state: run.status as DailyRunState,
        eligibleToRun: false, shouldAlert: true,
        reason: `daily-pipeline ${known} for ${logicalDate} — terminal, not auto-retried. ` +
                'A rerun must explicitly supersede this scheduled run.',
      }
    }
    return {
      ...base, state: 'unknown', eligibleToRun: false, shouldAlert: true,
      reason: `daily-pipeline for ${logicalDate} has unrecognised status "${run.status}" — ` +
              'refusing to treat it as absent, and refusing to auto-retry.',
    }
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
