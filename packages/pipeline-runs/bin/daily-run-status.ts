#!/usr/bin/env tsx
/**
 * Evaluate the daily pipeline's logical state. READ-ONLY — never starts,
 * repairs or records anything.
 *
 * Used by BOTH the scheduler (to decide eligibility) and the watchdog (to
 * decide whether to alert), so the two can never disagree about what state the
 * day is in.
 *
 *   --json     machine-readable
 *   --exit-code  0 healthy/expected, 1 needs attention
 */
// READ-ONLY BY CONTRACT. This is a diagnostic the scheduler consults twice per
// opportunity; it must never create, migrate, or write the store it reports on.
// openDb() would have created the database, set WAL, and applied SCHEMA — so a
// status check against a wrong or missing path produced an empty database that
// reads as "healthy".
import { openDbReadOnly, resolveDbPath } from '../src/store.js'
import { assessDailyRun, isValidLogicalDate } from '../src/daily-run-state.js'
import { readHeartbeats } from '../src/heartbeat.js'

const HEARTBEAT = process.env.SCHEDULER_HEARTBEAT_FILE
  ?? `${process.env.HOME}/Desktop/Projects.nosync/data/scheduler-heartbeat.log`

// TEST CLOCK. Every interesting state — due, not_due, running, stale — is a
// function of the wall clock, so without an injectable `now` the scheduler's
// branches can only be exercised at the time of day that happens to produce
// them, and `--dry-run` cannot be verified as inert on the branch that matters.
//
// FAIL CLOSED, TWO WAYS. The override is rejected unless it parses as a real
// instant, and its presence is REPORTED in the output (`clockOverride`) so no
// consumer can act on an overridden verdict without seeing it. `daily-scheduler.sh`
// refuses to submit when it is set — a test clock can never cause a real run.
const nowRaw = process.env.SCHEDULER_TEST_NOW?.trim()
let now = new Date()
if (nowRaw) {
  const parsed = new Date(nowRaw)
  if (Number.isNaN(parsed.getTime())) {
    console.error(`[daily-run-status] SCHEDULER_TEST_NOW is not a valid instant: ${nowRaw}`)
    process.exit(2)
  }
  now = parsed
  console.error(`[daily-run-status] CLOCK OVERRIDDEN via SCHEDULER_TEST_NOW=${now.toISOString()} — not a real verdict`)
}

// --logical-date <YYYY-MM-DD>: assess THIS day against the REAL current
// instant. The scheduler's under-lock recheck must ask about the day it
// approved, not the day its own clock has since rolled into. This narrows the
// question; it is emphatically not a clock override, and it is safe in
// production for exactly that reason.
let requestedDate: string | undefined
{
  const i = process.argv.indexOf('--logical-date')
  if (i !== -1) {
    const value = process.argv[i + 1]
    if (value === undefined || value.startsWith('-')) {
      console.error('[daily-run-status] --logical-date requires a YYYY-MM-DD value')
      process.exit(2)
    }
    if (!isValidLogicalDate(value)) {
      console.error(`[daily-run-status] --logical-date must be YYYY-MM-DD, got '${value}'`)
      process.exit(2)
    }
    requestedDate = value
  }
}

const db = openDbReadOnly(resolveDbPath())
const a = {
  ...assessDailyRun({ db, now, logicalDate: requestedDate, heartbeats: readHeartbeats(HEARTBEAT) }),
  clockOverride: Boolean(nowRaw),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(a, null, 2))
} else {
  console.log(`logical date : ${a.logicalDate}`)
  console.log(`state        : ${a.state.toUpperCase()}`)
  console.log(`run          : ${a.runId ?? '(none)'}`)
  console.log(`started      : ${a.startedAt ?? '-'}`)
  console.log(`ended        : ${a.endedAt ?? '-'}`)
  if (a.runningForMin !== null) console.log(`running for  : ${a.runningForMin} min`)
  console.log(`heartbeat    : ${a.lastHeartbeat ?? '(scheduler has never run)'}`)
  console.log(`eligible     : ${a.eligibleToRun}`)
  console.log(`alert        : ${a.shouldAlert}`)
  console.log(`reason       : ${a.reason}`)
  if (a.clockOverride) console.log('clock        : OVERRIDDEN (SCHEDULER_TEST_NOW) — not a real verdict')
}
if (process.argv.includes('--exit-code')) process.exit(a.shouldAlert ? 1 : 0)
