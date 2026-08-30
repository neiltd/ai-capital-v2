import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assessDailyRun, logicalRunDate, dueAt, businessInstant, businessDayBounds,
  findRunForDate, BUSINESS_TIMEZONE, DUE_HOUR, STALE_AFTER_MIN,
} from '../src/daily-run-state.js'
import { openDb, openDbReadOnly, migrateScheduledRunIdentity } from '../src/store.js'
import { recordStart, supersedeScheduledRun } from '../src/api.js'

// Everything here runs against in-memory or temporary databases and a temporary
// filesystem. Nothing reaches data/pipeline-runs.db, Redis, or any queue.

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
    doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
    error_message TEXT, error_stack TEXT, metadata_json TEXT,
    logical_date TEXT, superseded_at TEXT)`)
})
afterEach(() => db.close())

// Rows carry the logical date they belong to, exactly as `recordStart` now
// persists it. Deriving it from the start instant keeps these fixtures honest:
// it is the same business-time attribution the scheduler applies when it
// approves the day.
const insert = (id: string, status: string, startedIso: string, logicalDate?: string | null) =>
  db.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status, logical_date)
              VALUES (?, 'daily-pipeline', ?, ?, ?)`)
    .run(id, startedIso, status,
         logicalDate === undefined ? logicalRunDate(new Date(startedIso)) : logicalDate)

// ── A. business time, independent of the host ──────────────────────────────

describe('A. canonical business time', () => {
  it('is America/Los_Angeles', () => {
    expect(BUSINESS_TIMEZONE).toBe('America/Los_Angeles')
  })

  it('resolves 07:00 to a fixed UTC instant in DAYLIGHT time (PDT, UTC-7)', () => {
    // 2026-08-27 is PDT. This assertion is an absolute fact about UTC and
    // cannot pass by accident on a host in another timezone.
    expect(dueAt('2026-08-27').toISOString()).toBe('2026-08-27T14:00:00.000Z')
  })

  it('resolves 07:00 to a fixed UTC instant in STANDARD time (PST, UTC-8)', () => {
    expect(dueAt('2026-01-15').toISOString()).toBe('2026-01-15T15:00:00.000Z')
  })

  it('handles the spring-forward and fall-back days without drifting', () => {
    // 2026: DST begins Mar 8, ends Nov 1. 07:00 exists on both days.
    expect(dueAt('2026-03-08').toISOString()).toBe('2026-03-08T14:00:00.000Z')
    expect(dueAt('2026-11-01').toISOString()).toBe('2026-11-01T15:00:00.000Z')
  })

  it('the host timezone (this runner is +07) does not change the result', () => {
    // Host offset, proven present so the assertion above is meaningful.
    expect(new Date('2026-08-27T14:00:00.000Z').getTimezoneOffset()).not.toBe(0)
    expect(logicalRunDate(new Date('2026-08-27T14:00:00.000Z'))).toBe('2026-08-27')
  })

  it('buckets instants either side of Los Angeles midnight correctly', () => {
    expect(logicalRunDate(businessInstant('2026-08-27', '23:59'))).toBe('2026-08-27')
    expect(logicalRunDate(businessInstant('2026-08-28', '00:01'))).toBe('2026-08-28')
    // 23:59 PDT is already the NEXT day in UTC — the case the old code got wrong.
    expect(businessInstant('2026-08-27', '23:59').toISOString().slice(0, 10)).toBe('2026-08-28')
  })

  it('due-time boundaries are exact', () => {
    const due = dueAt('2026-08-27')
    expect(businessInstant('2026-08-27', '06:59').getTime()).toBeLessThan(due.getTime())
    expect(businessInstant('2026-08-27', '07:00').getTime()).toBe(due.getTime())
    expect(businessInstant('2026-08-27', '07:01').getTime()).toBeGreaterThan(due.getTime())
  })

  it('LEGACY schema: a run starting before LA midnight stays on its start date', () => {
    // Business-time attribution is the fallback for a store that predates
    // scheduled-run identity. On a migrated store the row's own logical_date
    // decides instead — see the identity tests in F.
    const legacy = new Database(':memory:')
    legacy.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, status TEXT NOT NULL)`)
    legacy.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status)
                    VALUES ('cross', 'daily-pipeline', ?, 'success')`)
      .run(businessInstant('2026-08-27', '23:30').toISOString())
    expect(findRunForDate(legacy, '2026-08-27')?.id).toBe('cross')
    expect(findRunForDate(legacy, '2026-08-28')).toBeNull()
    legacy.close()
  })

  it('business day bounds are half-open and cover exactly one LA day', () => {
    const { start, end } = businessDayBounds('2026-08-27')
    expect(start.toISOString()).toBe('2026-08-27T07:00:00.000Z')   // LA midnight PDT
    expect(end.toISOString()).toBe('2026-08-28T07:00:00.000Z')
  })

  it('no live SQL depends on SQLite localtime', () => {
    // Comments still DESCRIBE the old `date(started_at,'localtime')` behaviour;
    // what must be gone is any executable use of it.
    const code = readFileSync(resolve(__dirname, '..', 'src', 'daily-run-state.ts'), 'utf-8')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/'localtime'/)
  })
})

// ── B. total state model ───────────────────────────────────────────────────

describe('B. the state model is total over persisted statuses', () => {
  const DATE = '2026-08-27'
  const assess = (status: string | null) => {
    if (status) insert(`r-${status}`, status, businessInstant(DATE, '07:05').toISOString())
    return assessDailyRun({
      db, now: businessInstant(DATE, '12:00'),
      heartbeats: [businessInstant(DATE, '07:10'), businessInstant(DATE, '11:55')],
    })
  }

  it.each([
    ['success', 'success', false, false],
    ['failed',  'failed',  false, true],
    ['timeout', 'timeout', false, true],
    ['killed',  'killed',  false, true],
  ])('%s → state %s, eligible=%s, alert=%s', (status, state, eligible, alert) => {
    const a = assess(status)
    expect(a.state).toBe(state)
    expect(a.eligibleToRun).toBe(eligible)
    expect(a.shouldAlert).toBe(alert)
  })

  it('an unrecognised persisted status becomes explicit `unknown`, never absence', () => {
    const a = assess('bamboozled')
    expect(a.state).toBe('unknown')
    expect(a.eligibleToRun).toBe(false)
    expect(a.shouldAlert).toBe(true)
    expect(a.reason).toMatch(/unrecognised status "bamboozled"/)
  })

  it.each(['timeout', 'killed', 'bamboozled'])(
    'CRITICAL: %s can never trigger automatic resubmission', (status) => {
      // Before this, these fell through to the "no run row" branch and returned
      // missing/eligibleToRun:true — the scheduler would have re-run a day that
      // had already executed and been killed.
      expect(assess(status).eligibleToRun).toBe(false)
    })

  it('healthy running is not eligible; stale running is stale and alerts', () => {
    const now = businessInstant(DATE, '08:00')
    insert('run-healthy', 'running', businessInstant(DATE, '07:40').toISOString())
    const healthy = assessDailyRun({ db, now, heartbeats: [businessInstant(DATE, '07:10')] })
    expect(healthy.state).toBe('running')
    expect(healthy.eligibleToRun).toBe(false)

    db.prepare('DELETE FROM pipeline_runs').run()
    insert('run-stale', 'running',
      new Date(now.getTime() - (STALE_AFTER_MIN + 5) * 60_000).toISOString())
    const stale = assessDailyRun({ db, now, heartbeats: [businessInstant(DATE, '07:10')] })
    expect(stale.state).toBe('stale')
    expect(stale.eligibleToRun).toBe(false)
    expect(stale.shouldAlert).toBe(true)
  })

  it('only genuine ABSENCE may become missing or no_opportunity', () => {
    const now = businessInstant(DATE, '12:00')
    const missing = assessDailyRun({ db, now, heartbeats: [businessInstant(DATE, '07:10')] })
    expect(missing.state).toBe('missing')
    expect(missing.eligibleToRun).toBe(true)

    const noOpp = assessDailyRun({ db, now, heartbeats: [] })
    expect(noOpp.state).toBe('no_opportunity')
    expect(noOpp.shouldAlert).toBe(false)
  })
})

// ── H. liveness evidence semantics ─────────────────────────────────────────

describe('H. machine-opportunity evidence', () => {
  const DATE = '2026-08-27'

  it('scheduler dead + watchdog alive → missing once the grace period passes', () => {
    // Heartbeats exist (written by the watchdog) but no run row: the machine was
    // demonstrably awake and nothing ran.
    const a = assessDailyRun({
      db, now: businessInstant(DATE, '09:00'),
      heartbeats: [businessInstant(DATE, '07:05'), businessInstant(DATE, '08:55')],
    })
    expect(a.state).toBe('missing')
    expect(a.shouldAlert).toBe(true)
  })

  it('machine unavailable → no_opportunity, never an alert', () => {
    const a = assessDailyRun({ db, now: businessInstant(DATE, '09:00'), heartbeats: [] })
    expect(a.state).toBe('no_opportunity')
    expect(a.shouldAlert).toBe(false)
  })

  it('awake but inside the grace period is not yet an alert', () => {
    const a = assessDailyRun({
      db, now: businessInstant(DATE, '07:20'),
      heartbeats: [businessInstant(DATE, '07:05')],
    })
    expect(a.state).toBe('no_opportunity')
    expect(a.shouldAlert).toBe(false)
  })
})

// ── C. read-only status evaluation ─────────────────────────────────────────

describe('C. status evaluation cannot create or migrate a store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ro-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses a missing database instead of creating one', () => {
    const missing = join(dir, 'nope.db')
    expect(() => openDbReadOnly(missing)).toThrow(/refusing to open a database that does not exist/)
    expect(existsSync(missing)).toBe(false)
  })

  it('cannot write data, and cannot migrate the schema it reads', () => {
    // NOTE: SQLite builds the -shm/-wal shared-memory index even for a
    // read-only open of a WAL database and cannot remove it on close, so their
    // presence is not evidence of a write. The invariants that matter are that
    // no ROW can be written and no SCHEMA can be applied.
    const p = join(dir, 'runs.db')
    openDb(p).close()
    const ro = openDbReadOnly(p)
    expect(() => ro.prepare(
      `INSERT INTO pipeline_runs (id, stage, started_at, status)
       VALUES ('x','daily-pipeline','2026-08-27T00:00:00.000Z','success')`).run(),
    ).toThrow(/readonly/i)
    expect(() => ro.exec('ALTER TABLE pipeline_runs ADD COLUMN nope TEXT')).toThrow(/readonly/i)
    ro.close()
  })

  it('a database missing the expected schema fails clearly rather than being created for it', () => {
    const p = join(dir, 'empty.db')
    new Database(p).close()                     // exists, but has no tables
    const ro = openDbReadOnly(p)
    expect(() => ro.prepare('SELECT 1 FROM pipeline_runs').get()).toThrow(/no such table/i)
    ro.close()
  })

  it('the status bin opens the store read-only', () => {
    const src = readFileSync(resolve(__dirname, '..', 'bin', 'daily-run-status.ts'), 'utf-8')
    expect(src).toContain('openDbReadOnly(resolveDbPath())')
    expect(src).not.toMatch(/[^y]openDb\(resolveDbPath\(\)\)/)
  })
})

// ── D. scheduled-run identity ──────────────────────────────────────────────

describe('D. scheduled-run identity is structural', () => {
  let dir: string, p: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ident-')); p = join(dir, 'runs.db') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('one non-superseded scheduled run per logical date is enforced by the DATABASE', () => {
    recordStart({ stage: 'daily-pipeline', source: 'queue', logicalDate: '2026-08-27' }, p)
    expect(() =>
      recordStart({ stage: 'daily-pipeline', source: 'queue', logicalDate: '2026-08-27' }, p),
    ).toThrow(/UNIQUE/i)
  })

  it('a deliberate supersession frees the date for an explicit retry', () => {
    const first = recordStart({ stage: 'daily-pipeline', source: 'queue', logicalDate: '2026-08-27' }, p)
    expect(supersedeScheduledRun(first, p)).toBe(1)
    const second = recordStart({ stage: 'daily-pipeline', source: 'queue', logicalDate: '2026-08-27' }, p)
    expect(second).not.toBe(first)
    // Superseding something already superseded is a no-op, not a silent success.
    expect(supersedeScheduledRun(first, p)).toBe(0)
  })

  it('manual/ad hoc runs carry no logical date and are never constrained', () => {
    recordStart({ stage: 'daily-pipeline', source: 'manual' }, p)
    recordStart({ stage: 'daily-pipeline', source: 'manual' }, p)
    const rows = openDbReadOnly(p)
      .prepare(`SELECT logical_date FROM pipeline_runs WHERE source='manual'`).all() as Array<{ logical_date: string | null }>
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.logical_date === null)).toBe(true)
  })

  it('structured parents and child stages are unaffected', () => {
    recordStart({ stage: 'structured-ingestion-scheduled', source: 'queue' }, p)
    recordStart({ stage: 'structured-ingestion-scheduled', source: 'queue' }, p)
    recordStart({ stage: 'capital-ingestion', parentRunId: 'x' }, p)
    recordStart({ stage: 'capital-ingestion', parentRunId: 'y' }, p)
    const n = (openDbReadOnly(p).prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get() as { n: number }).n
    expect(n).toBe(4)
  })

  it('migration is idempotent and preserves pre-existing rows', () => {
    // A store created WITHOUT the new columns, as production is today.
    const legacy = new Database(p)
    legacy.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
      doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
      error_message TEXT, error_stack TEXT, metadata_json TEXT)`)
    legacy.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status)
                    VALUES ('historical','daily-pipeline','2026-08-01T00:00:00.000Z','success')`).run()

    migrateScheduledRunIdentity(legacy)
    migrateScheduledRunIdentity(legacy)      // twice — must be a no-op
    migrateScheduledRunIdentity(legacy)

    const cols = new Set((legacy.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`)
      .all() as Array<{ name: string }>).map(c => c.name))
    expect(cols.has('logical_date')).toBe(true)
    expect(cols.has('superseded_at')).toBe(true)

    const row = legacy.prepare(`SELECT id, status, logical_date FROM pipeline_runs WHERE id='historical'`)
      .get() as { id: string; status: string; logical_date: string | null }
    expect(row.status).toBe('success')
    expect(row.logical_date).toBeNull()       // historical rows stay valid and unconstrained
    legacy.close()
  })
})

// ── F. logical_date is authoritative once the schema carries it ────────────
//
// Before this, `findRunForDate` inferred the day from `started_at`. That
// inference cannot survive activation: the scheduler approves a date, stamps it
// on the row, and the row must answer for THAT date regardless of when it
// actually began. The failure it prevents is a double one — a run approved for
// day N that starts at 00:02 on day N+1 makes N look missing AND N+1 look
// already satisfied, so N+1 is never submitted.

describe('F. scheduled identity decides the day', () => {
  /** A migrated store: identity columns present. */
  const migrated = () => {
    const d = new Database(':memory:')
    d.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, status TEXT NOT NULL, logical_date TEXT, superseded_at TEXT)`)
    return d
  }
  /** The same store shape WITHOUT the identity columns. */
  const legacy = () => {
    const d = new Database(':memory:')
    d.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, status TEXT NOT NULL)`)
    return d
  }
  const add = (d: Database.Database, id: string, startedIso: string,
               logicalDate: string | null, supersededAt: string | null = null) =>
    d.prepare(`INSERT INTO pipeline_runs
      (id, stage, started_at, status, logical_date, superseded_at)
      VALUES (?, 'daily-pipeline', ?, 'success', ?, ?)`).run(id, startedIso, logicalDate, supersededAt)

  // The instant that breaks started_at inference: 00:02 Los Angeles on 08-30,
  // for a run the scheduler approved as 08-29.
  const LATE_START = businessInstant('2026-08-30', '00:02').toISOString()

  it('1. a matching logical_date satisfies the day', () => {
    const d = migrated()
    add(d, 'approved', businessInstant('2026-08-29', '07:05').toISOString(), '2026-08-29')
    expect(findRunForDate(d, '2026-08-29')?.id).toBe('approved')
    d.close()
  })

  it('2. a run for the PREVIOUS logical date does not satisfy the next one', () => {
    const d = migrated()
    add(d, 'late', LATE_START, '2026-08-29')          // approved 08-29, started 08-30
    expect(findRunForDate(d, '2026-08-29')?.id, 'it must still answer for its own date').toBe('late')
    expect(findRunForDate(d, '2026-08-30'), 'it must NOT discharge the next day').toBeNull()
    d.close()
  })

  it('2b. NON-VACUOUS: that same row DOES satisfy 08-30 under started_at inference', () => {
    // Proof the test above catches a real regression rather than a tautology:
    // on a legacy schema the identical instant is attributed to 08-30, which is
    // exactly the misfiling the identity columns exist to stop.
    const d = legacy()
    d.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status)
               VALUES ('late', 'daily-pipeline', ?, 'success')`).run(LATE_START)
    expect(findRunForDate(d, '2026-08-30')?.id).toBe('late')
    expect(findRunForDate(d, '2026-08-29')).toBeNull()
    d.close()
  })

  it('3. a manual run with logical_date NULL does not satisfy a scheduled date', () => {
    const d = migrated()
    add(d, 'manual', businessInstant('2026-08-29', '11:00').toISOString(), null)
    expect(findRunForDate(d, '2026-08-29'),
      'an ad-hoc run must not silently discharge the schedule').toBeNull()
    d.close()
  })

  it('4. a superseded run does not satisfy its date', () => {
    const d = migrated()
    add(d, 'replaced', businessInstant('2026-08-29', '07:05').toISOString(),
        '2026-08-29', '2026-08-29T18:00:00.000Z')
    expect(findRunForDate(d, '2026-08-29')).toBeNull()
    d.close()
  })

  it('4b. superseding one row leaves its live replacement answering for the day', () => {
    const d = migrated()
    add(d, 'replaced', businessInstant('2026-08-29', '07:05').toISOString(),
        '2026-08-29', '2026-08-29T18:00:00.000Z')
    add(d, 'live', businessInstant('2026-08-29', '18:10').toISOString(), '2026-08-29')
    expect(findRunForDate(d, '2026-08-29')?.id).toBe('live')
    d.close()
  })

  it('5. a legacy schema still uses the business-time fallback', () => {
    const d = legacy()
    d.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status)
               VALUES ('legacy-run', 'daily-pipeline', ?, 'success')`)
      .run(businessInstant('2026-08-29', '07:05').toISOString())
    expect(findRunForDate(d, '2026-08-29')?.id,
      'read-only status must stay usable before migration').toBe('legacy-run')
    d.close()
  })

  it('the two regimes are selected by the SCHEMA, not by configuration', () => {
    // No flag, no env var, no second store — the column's presence is the switch.
    const src = readFileSync(resolve(__dirname, '..', 'src', 'daily-run-state.ts'), 'utf-8')
    expect(src).toMatch(/hasScheduledIdentity\(db\)/)
    expect(src).not.toMatch(/process\.env\.[A-Z_]*LOGICAL/)
  })
})

// ── G. the under-lock recheck must ask about the date it approved ──────────
//
// The scheduler evaluates eligibility, acquires the lock, then re-checks before
// spending. The recheck called the status CLI with no date, so it re-derived
// the day from its own clock. Acquiring a lock takes a moment; when that moment
// crossed Los Angeles midnight the recheck evaluated the NEXT date — not due,
// no run — and threw away a correctly approved run for the previous one.

describe('G. explicit logical date on the assessment seam', () => {
  const store = () => {
    const d = new Database(':memory:')
    d.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, status TEXT NOT NULL, logical_date TEXT, superseded_at TEXT)`)
    return d
  }
  const addRun = (d: Database.Database, id: string, status: string,
                  logicalDate: string, supersededAt: string | null = null) =>
    d.prepare(`INSERT INTO pipeline_runs
      (id, stage, started_at, status, logical_date, superseded_at)
      VALUES (?, 'daily-pipeline', ?, ?, ?, ?)`)
      .run(id, businessInstant(logicalDate, '07:05').toISOString(), status, logicalDate, supersededAt)

  const N = '2026-08-29'
  const NEXT = '2026-08-30'
  // The two instants that straddle the boundary, one second apart.
  const APPROVED_AT = businessInstant(N, '23:59:59')
  const RECHECK_AT = businessInstant(NEXT, '00:00:01')
  // Heartbeats since the due time, so the machine counts as having been available.
  const beats = [businessInstant(N, '07:00'), businessInstant(N, '12:00'), APPROVED_AT]

  it('1. initial approval at 23:59:59 evaluates date N and is eligible', () => {
    const d = store()
    const a = assessDailyRun({ db: d, now: APPROVED_AT, heartbeats: beats })
    expect(a.logicalDate).toBe(N)
    expect(a.eligibleToRun).toBe(true)
    d.close()
  })

  it('2. the recheck one second later evaluates N, not N+1', () => {
    const d = store()
    const a = assessDailyRun({ db: d, now: RECHECK_AT, logicalDate: N, heartbeats: beats })
    expect(a.logicalDate, 'the recheck drifted to the next day').toBe(N)
    d.close()
  })

  it('2b. NON-VACUOUS: without the explicit date the SAME call answers for N+1', () => {
    // Proof this catches the real defect. The old recheck made exactly this
    // call, and its verdict was about a day nobody had approved.
    const d = store()
    const a = assessDailyRun({ db: d, now: RECHECK_AT, heartbeats: beats })
    expect(a.logicalDate).toBe(NEXT)
    expect(a.eligibleToRun, 'N+1 is not due at 00:00:01, so the run was discarded').toBe(false)
    d.close()
  })

  it('3. it stays eligible when no run for N has appeared', () => {
    const d = store()
    const a = assessDailyRun({ db: d, now: RECHECK_AT, logicalDate: N, heartbeats: beats })
    expect(a.eligibleToRun).toBe(true)
    d.close()
  })

  it('4. it becomes ineligible once another scheduler created the row for N', () => {
    const d = store()
    addRun(d, 'other-fire', 'running', N)
    const a = assessDailyRun({ db: d, now: RECHECK_AT, logicalDate: N, heartbeats: beats })
    expect(a.eligibleToRun, 'a duplicate daily run would have been submitted').toBe(false)
    expect(a.logicalDate).toBe(N)
    d.close()
  })

  it('4b. a SUPERSEDED row for N does not suppress the recheck', () => {
    const d = store()
    addRun(d, 'replaced', 'failed', N, '2026-08-29T20:00:00.000Z')
    const a = assessDailyRun({ db: d, now: RECHECK_AT, logicalDate: N, heartbeats: beats })
    expect(a.eligibleToRun).toBe(true)
    d.close()
  })

  it('6. the default path is unchanged — no date means the current business date', () => {
    const d = store()
    const noon = businessInstant(N, '12:00')
    expect(assessDailyRun({ db: d, now: noon, heartbeats: beats }).logicalDate).toBe(N)
    const nextNoon = businessInstant(NEXT, '12:00')
    expect(assessDailyRun({ db: d, now: nextNoon, heartbeats: beats }).logicalDate).toBe(NEXT)
    d.close()
  })

  it('narrows the DAY, never the clock — `now` is still the real instant', () => {
    // The distinction that makes this safe in production: a stale `now` would
    // fabricate a verdict; a stale day merely asks about the right question.
    const d = store()
    addRun(d, 'r', 'running', N)
    const a = assessDailyRun({ db: d, now: RECHECK_AT, logicalDate: N, heartbeats: beats })
    // runningForMin is measured from the REAL now, so it reflects the true gap.
    expect(a.runningForMin).toBeGreaterThan(15 * 60)
    d.close()
  })
})
