import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  assessDailyRun, logicalRunDate, dueAt, findRunForDate,
  STALE_AFTER_MIN, DUE_HOUR,
} from '../src/daily-run-state.js'

// Scheduler test matrix for the 2026-08-27 P1 repair.
//
// These run entirely against an IN-MEMORY database. They never touch
// data/pipeline-runs.db and never create production run history — a test that
// wrote a fake 'success' row would corrupt the very record the watchdog reads.

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
    doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
    error_message TEXT, error_stack TEXT, metadata_json TEXT)`)
})
afterEach(() => db.close())

/** Insert a daily-pipeline row whose LOCAL date is `logicalDate`. */
function insertRun(logicalDate: string, status: string, startedLocal: string, endedLocal?: string) {
  const toUtc = (local: string) => {
    const [h, m] = local.split(':').map(Number)
    const [y, mo, d] = logicalDate.split('-').map(Number)
    return new Date(y, mo - 1, d, h, m, 0, 0).toISOString()
  }
  db.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, ended_at, status)
              VALUES (?, 'daily-pipeline', ?, ?, ?)`)
    .run(`run-${logicalDate}-${status}-${startedLocal}`, toUtc(startedLocal),
         endedLocal ? toUtc(endedLocal) : null, status)
}

const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number)
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m, 0, 0)
}

const DATE = '2026-08-27'

describe('logical run date', () => {
  it('is the LOCAL calendar date, so evening runs bucket to the right day', () => {
    // started_at is stored UTC; at +07 a 21:03 local run is 14:03Z the same day,
    // but a naive UTC-date comparison mis-buckets runs after 17:00 local.
    expect(logicalRunDate(at(DATE, '21:03'))).toBe(DATE)
    expect(logicalRunDate(at(DATE, '00:30'))).toBe(DATE)
  })
  it('due time is the local due hour', () => {
    expect(dueAt(DATE).getHours()).toBe(DUE_HOUR)
  })
  it('finds a run by its LOCAL date', () => {
    insertRun(DATE, 'success', '21:03', '21:36')
    expect(findRunForDate(db, DATE)?.status).toBe('success')
  })
  it('a success anywhere in the day settles it, whatever came before', () => {
    insertRun(DATE, 'failed', '07:00', '07:05')
    insertRun(DATE, 'success', '09:00', '09:33')
    expect(findRunForDate(db, DATE)?.status).toBe('success')
  })
})

describe('Case A — machine available, daily run missing', () => {
  it('becomes eligible and starts', () => {
    const now = at(DATE, '09:00')
    // awake continuously since 07:05, now 09:00 -> available 115 min
    const a = assessDailyRun({ db, now, heartbeats: [at(DATE, '07:05'), at(DATE, '08:55')] })
    expect(a.state).toBe('missing')
    expect(a.eligibleToRun).toBe(true)
    expect(a.shouldAlert).toBe(true)   // awake 115min past due, well beyond grace
  })
})

describe('Case B — machine unavailable through the due time, then wakes', () => {
  it('catches the missed logical run up, and does NOT alert', () => {
    // This is the deployment's normal morning: asleep at 07:00, woken at 10:13.
    // Alerting here every day would train the alert to be ignored.
    const now = at(DATE, '10:13')
    const a = assessDailyRun({ db, now, heartbeats: [at(DATE, '10:13')] })
    expect(a.state).toBe('no_opportunity')
    expect(a.eligibleToRun).toBe(true)
    expect(a.shouldAlert).toBe(false)
    expect(a.reason).toMatch(/machine was unavailable|awake for/)
  })

  it('still does not alert inside the grace period', () => {
    // machine woke at 10:05; now 10:20 -> available only 15 min, inside grace
    const now = at(DATE, '10:20')
    const a = assessDailyRun({ db, now, heartbeats: [at(DATE, '10:05'), at(DATE, '10:20')] })
    expect(a.shouldAlert).toBe(false)
    expect(a.eligibleToRun).toBe(true)
  })

  it('DOES alert once the machine has been awake past the grace period', () => {
    // awake since 07:05; now 08:00 -> available 55 min, past the 30 min grace
    const a = assessDailyRun({ db, now: at(DATE, '08:00'), heartbeats: [at(DATE, '07:05')] })
    expect(a.state).toBe('missing')
    expect(a.shouldAlert).toBe(true)
  })
})

describe('Case C — daily run already succeeded', () => {
  it('a later trigger does NOT duplicate it', () => {
    insertRun(DATE, 'success', '07:00', '07:33')
    for (const t of ['07:34', '09:00', '21:03', '23:59']) {
      const a = assessDailyRun({ db, now: at(DATE, t), heartbeats: [at(DATE, t)] })
      expect(a.state, `at ${t}`).toBe('success')
      expect(a.eligibleToRun, `at ${t}`).toBe(false)
      expect(a.shouldAlert, `at ${t}`).toBe(false)
    }
  })
  it('an agent reload mid-day does not re-run it', () => {
    insertRun(DATE, 'success', '09:00', '09:31')
    // RunAtLoad fires immediately on bootstrap; eligibility must still be false.
    expect(assessDailyRun({ db, now: at(DATE, '12:00'), heartbeats: [at(DATE, '12:00')] }).eligibleToRun)
      .toBe(false)
  })
})

describe('Case D — previous run exists but FAILED', () => {
  it('is a distinct state, never conflated with "never ran"', () => {
    insertRun(DATE, 'failed', '07:00', '07:05')
    const a = assessDailyRun({ db, now: at(DATE, '09:00'), heartbeats: [at(DATE, '09:00')] })
    expect(a.state).toBe('failed')
    expect(a.state).not.toBe('missing')
    // Explicit policy: alert, do not auto-retry. Re-running risks repeating the
    // same failure at real API cost.
    expect(a.shouldAlert).toBe(true)
    expect(a.eligibleToRun).toBe(false)
  })
})

describe('Case E — run is stale / orphaned', () => {
  it('recognises an orphan separately from a healthy in-progress run', () => {
    insertRun(DATE, 'running', '07:00')
    const healthy = assessDailyRun({ db, now: at(DATE, '07:30'), heartbeats: [at(DATE, '07:30')] })
    expect(healthy.state).toBe('running')
    expect(healthy.shouldAlert).toBe(false)

    const orphan = assessDailyRun({ db, now: at(DATE, '09:00'), heartbeats: [at(DATE, '09:00')] })
    expect(orphan.state).toBe('stale')
    expect(orphan.runningForMin).toBeGreaterThanOrEqual(STALE_AFTER_MIN)
    expect(orphan.shouldAlert).toBe(true)
  })

  it('the 61-minute real-world outlier is still healthy, not stale', () => {
    // Measured: successful runs took 27-34min, one took 61. The threshold must
    // sit above the slowest HEALTHY run or it cries wolf on a slow morning.
    insertRun(DATE, 'running', '07:00')
    expect(assessDailyRun({ db, now: at(DATE, '08:01'), heartbeats: [at(DATE, '08:01')] }).state)
      .toBe('running')
  })

  it('an orphan does NOT satisfy the day the way the old logic allowed', () => {
    // The old check was `status IN ('running','success')`, so the 2026-08-26
    // orphan would have counted as a completed run for its date forever.
    insertRun(DATE, 'running', '07:00')
    const a = assessDailyRun({ db, now: at(DATE, '23:00'), heartbeats: [at(DATE, '23:00')] })
    expect(a.state).toBe('stale')
    expect(a.shouldAlert).toBe(true)
  })
})

describe('Case F — no run after a valid execution opportunity', () => {
  it('detects and alerts', () => {
    // The machine has been demonstrably awake since 08:00 and polled all day;
    // seven hours of opportunity with no run is a failure, not a slow start.
    const a = assessDailyRun({ db, now: at(DATE, '14:00'),
      heartbeats: [at(DATE, '08:00'), at(DATE, '11:00'), at(DATE, '13:55')] })
    expect(a.state).toBe('missing')
    expect(a.shouldAlert).toBe(true)
    expect(a.reason).toMatch(/Absence is a failure/)
  })

  it('absence is never reported as success', () => {
    const a = assessDailyRun({ db, now: at(DATE, '14:00'),
      heartbeats: [at(DATE, '08:00'), at(DATE, '13:55')] })
    expect(a.state).not.toBe('success')
  })
})

describe('not-due and no-heartbeat edges', () => {
  it('before the due hour, nothing is expected', () => {
    const a = assessDailyRun({ db, now: at(DATE, '06:59'), heartbeats: [at(DATE, '06:59')] })
    expect(a.state).toBe('not_due')
    expect(a.eligibleToRun).toBe(false)
    expect(a.shouldAlert).toBe(false)
  })
  it('a scheduler that has NEVER run does not alert — it has no opportunity to report', () => {
    const a = assessDailyRun({ db, now: at(DATE, '09:00'), heartbeats: [] })
    expect(a.state).toBe('no_opportunity')
    expect(a.shouldAlert).toBe(false)
    expect(a.eligibleToRun).toBe(true)
  })
  it('yesterday\'s run does not satisfy today', () => {
    insertRun('2026-08-26', 'success', '21:03', '21:36')
    const a = assessDailyRun({ db, now: at(DATE, '14:00'),
      heartbeats: [at(DATE, '08:00'), at(DATE, '13:55')] })
    expect(a.state).toBe('missing')
  })
})
