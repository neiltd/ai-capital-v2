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
import { openDb, resolveDbPath } from '../src/store.js'
import { assessDailyRun } from '../src/daily-run-state.js'
import { readHeartbeats } from '../src/heartbeat.js'

const HEARTBEAT = process.env.SCHEDULER_HEARTBEAT_FILE
  ?? `${process.env.HOME}/Desktop/Projects.nosync/data/scheduler-heartbeat.log`

const db = openDb(resolveDbPath())
const a = assessDailyRun({ db, now: new Date(), heartbeats: readHeartbeats(HEARTBEAT) })

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
}
if (process.argv.includes('--exit-code')) process.exit(a.shouldAlert ? 1 : 0)
