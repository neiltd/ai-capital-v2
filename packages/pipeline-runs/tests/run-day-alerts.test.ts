import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assessDailyRun, businessInstant } from '../src/daily-run-state.js'
import { nyseHolidays, isNyseTradingDay, isDailyRunDay } from '../src/nyse-calendar.js'

// ── WHAT A RUN-DAY RULE MUST NOT SWALLOW ────────────────────────────────────
//
// The run-day check is deliberately NOT the first thing assessDailyRun does.
// It sits at daily-run-state.ts:426, after every branch that reads an actual
// run row, so a run that really happened on a day we do not schedule still
// reports its real outcome. Neil decided this explicitly (DECISION-92): a real
// run row on a non-run day that failed, went stale, or carries an unknown
// status STILL alerts.
//
// Moving that check to the top of the function is the regression these tests
// exist to catch. It would look harmless — "we do not run on Thanksgiving, so
// there is nothing to report" — and it would silently hide a failed manual
// submission behind a calendar rule.
//
// SAFETY: in-memory and temp-directory databases only. data/pipeline-runs.db is
// never opened, and nothing here submits a pipeline.

const PKG = resolve(__dirname, '..')
const TSX = resolve(PKG, '..', '..', 'node_modules', '.bin', 'tsx')
const STATUS_CLI = join(PKG, 'bin', 'daily-run-status.ts')

const SCHEMA = `CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT,
  logical_date TEXT, superseded_at TEXT)`

const store = (): Database.Database => {
  const d = new Database(':memory:')
  d.exec(SCHEMA)
  return d
}

const addRun = (d: Database.Database, status: string, logicalDate: string,
                startedAt: string, endedAt: string | null = null) =>
  d.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, ended_at, status, logical_date)
             VALUES (?, 'daily-pipeline', ?, ?, ?, ?)`)
    .run(`t-${status}-${logicalDate}`, startedAt, endedAt, status, logicalDate)

// ── A. a real run row on a non-run day still reports ───────────────────────

describe('A. a recorded run on a day we do not schedule is still assessed', () => {
  // Thanksgiving 2026: Thursday 26 November, an NYSE full-day closure, so not a
  // run day. 09:00 business time is hours past the 04:30 due time.
  const HOLIDAY = '2026-11-26'
  const HOLIDAY_NOW = businessInstant(HOLIDAY, '09:00')
  // Saturday 10 October 2026 — never a run day, holiday or not.
  const SATURDAY = '2026-10-10'
  const SATURDAY_NOW = businessInstant(SATURDAY, '09:00')

  it('the two fixture dates really are non-run days', () => {
    // Non-vacuity for everything below: if either date were eligible these
    // tests would be asserting the ordinary due-day behaviour by accident.
    expect(isDailyRunDay(HOLIDAY), 'Thanksgiving is not a run day').toBe(false)
    expect(isDailyRunDay(SATURDAY), 'Saturday is not a run day').toBe(false)
  })

  it('a FAILED run on Thanksgiving alerts, and is not reported as not_trading_day', () => {
    const d = store()
    addRun(d, 'failed', HOLIDAY, businessInstant(HOLIDAY, '05:00').toISOString(),
           businessInstant(HOLIDAY, '05:06').toISOString())
    const a = assessDailyRun({ db: d, now: HOLIDAY_NOW, heartbeats: [businessInstant(HOLIDAY, '04:35')] })
    expect(a.state, 'the calendar rule swallowed a real failure').toBe('failed')
    expect(a.shouldAlert).toBe(true)
    expect(a.eligibleToRun).toBe(false)
    expect(a.reason).toContain('terminal, not auto-retried')
    d.close()
  })

  it('the SAME day with no run row is not_trading_day and silent', () => {
    // The other half of the pair. Both verdicts come from the same date, so the
    // difference is the run row and nothing else.
    const d = store()
    const a = assessDailyRun({ db: d, now: HOLIDAY_NOW, heartbeats: [businessInstant(HOLIDAY, '04:35')] })
    expect(a.state).toBe('not_trading_day')
    expect(a.shouldAlert).toBe(false)
    expect(a.eligibleToRun).toBe(false)
    d.close()
  })

  it('a STALE running row on a Saturday alerts', () => {
    const d = store()
    // Started 05:00, assessed at 09:00 — 240 minutes, well past STALE_AFTER_MIN.
    addRun(d, 'running', SATURDAY, businessInstant(SATURDAY, '05:00').toISOString())
    const a = assessDailyRun({ db: d, now: SATURDAY_NOW, heartbeats: [businessInstant(SATURDAY, '04:35')] })
    expect(a.state, 'an orphaned run was hidden by the Saturday rule').toBe('stale')
    expect(a.shouldAlert).toBe(true)
    expect(a.runningForMin).toBeGreaterThanOrEqual(90)
    d.close()
  })

  it('an UNKNOWN status on a non-run day alerts rather than being treated as absent', () => {
    const d = store()
    addRun(d, 'wedged', HOLIDAY, businessInstant(HOLIDAY, '05:00').toISOString())
    const a = assessDailyRun({ db: d, now: HOLIDAY_NOW, heartbeats: [businessInstant(HOLIDAY, '04:35')] })
    expect(a.state).toBe('unknown')
    expect(a.shouldAlert).toBe(true)
    d.close()
  })

  it('a SUCCESSFUL manual run on a non-run day reports success, not not_trading_day', () => {
    const d = store()
    addRun(d, 'success', HOLIDAY, businessInstant(HOLIDAY, '05:00').toISOString(),
           businessInstant(HOLIDAY, '05:31').toISOString())
    const a = assessDailyRun({ db: d, now: HOLIDAY_NOW, heartbeats: [businessInstant(HOLIDAY, '04:35')] })
    expect(a.state).toBe('success')
    expect(a.shouldAlert).toBe(false)
    d.close()
  })

  it('the run-day check really does sit after the run-row branches', () => {
    // A source assertion, because the ORDER is the property Neil decided on and
    // the behavioural tests above can all be satisfied by code that happens to
    // be ordered correctly today. Both anchors are in the same function.
    const src = readFileSync(join(PKG, 'src', 'daily-run-state.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function assessDailyRun'))
    expect(body.indexOf('TERMINAL[run.status]'), 'terminal branch missing')
      .toBeGreaterThan(-1)
    expect(body.indexOf('if (!isDailyRunDay(logicalDate))'), 'run-day branch missing')
      .toBeGreaterThan(body.indexOf('TERMINAL[run.status]'))
  })
})

// ── B. the non-run reason names the case, at both levels ───────────────────

describe('B. the not_trading_day reason says WHICH rule applied', () => {
  const cases: Array<[string, string]> = [
    ['2026-10-10', 'Saturday'],
    ['2026-11-26', 'NYSE holiday: Thanksgiving Day'],
  ]

  it.each(cases)('assessDailyRun on %s says "%s"', (date, expected) => {
    const d = store()
    const a = assessDailyRun({ db: d, now: businessInstant(date, '09:00'),
                               heartbeats: [businessInstant(date, '04:35')] })
    expect(a.state).toBe('not_trading_day')
    expect(a.reason).toContain(`(${expected})`)
    d.close()
  })

  // The same text through the CLI the scheduler, the watchdog and the catch-up
  // script all read. A reason that is right in the library and lost on the way
  // out is no use to whoever is reading the log at 05:00.
  it.each(cases)('the status CLI on %s prints "%s"', (date, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'run-day-cli-'))
    try {
      const dbPath = join(dir, 'pipeline-runs.db')
      const seed = new Database(dbPath)
      seed.exec(SCHEMA)
      seed.close()
      const hb = join(dir, 'heartbeat.log')
      writeFileSync(hb, `${businessInstant(date, '04:35').toISOString()}\n`)

      const out = execFileSync(TSX, [STATUS_CLI], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...process.env,
          PIPELINE_RUNS_DB: dbPath,
          SCHEDULER_HEARTBEAT_FILE: hb,
          SCHEDULER_TEST_NOW: businessInstant(date, '09:00').toISOString(),
        },
      })
      expect(out).toContain('NOT_TRADING_DAY')
      expect(out).toContain(`(${expected})`)
      expect(out).toMatch(/^eligible *: false$/m)
      expect(out).toMatch(/^alert *: false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── C. NYSE Rule 7.2, which a naive observance rule gets wrong ─────────────

describe('C. New Year’s Day on a Saturday is NOT observed', () => {
  // The general NYSE rule moves a Saturday holiday to the preceding Friday. New
  // Year's Day is the documented exception (Rule 7.2): when 1 January falls on
  // a Saturday the market is OPEN on 31 December and there is no closure at all.
  //
  // 2022-01-01 was a Saturday. The NYSE traded a full session on Friday
  // 2021-12-31, and published no New Year's closure for 2022.
  const NYE = '2021-12-31'   // Friday
  const NYD = '2022-01-01'   // Saturday

  it('2021-12-31 is a Friday and a trading day', () => {
    expect(new Date(`${NYE}T00:00:00Z`).getUTCDay()).toBe(5)
    expect(isNyseTradingDay(NYE)).toBe(true)
    expect(isDailyRunDay(NYE)).toBe(true)
  })

  it('neither 2021 nor 2022 records a New Year’s closure for that 1 January', () => {
    expect(nyseHolidays(2021).map(h => h.date)).not.toContain(NYE)
    expect(nyseHolidays(2022).filter(h => h.name === "New Year's Day")).toEqual([])
  })

  it('and 2022-01-01 itself produces no WEEKDAY closure anywhere', () => {
    // The point of the rule: the closure does not move onto a weekday. Checked
    // across the turn of the year so a shift in either direction would show.
    const around = ['2021-12-30', '2021-12-31', '2022-01-03', '2022-01-04']
    for (const d of around) {
      expect(isNyseTradingDay(d), `${d} should be a trading day`).toBe(true)
    }
    expect(new Date(`${NYD}T00:00:00Z`).getUTCDay()).toBe(6)   // the Saturday itself
  })

  it('NON-VACUITY: the naive "Saturday -> preceding Friday" rule FAILS here', () => {
    // Run the rule this implementation deliberately does not apply to New
    // Year's Day, and show it lands on 2021-12-31 — a day the NYSE traded. If
    // nyseHolidays ever adopted the naive rule, the assertion above would break
    // and this one explains why.
    const naive = (y: number, m: number, d: number): string => {
      const t = new Date(Date.UTC(y, m - 1, d))
      const dow = t.getUTCDay()
      if (dow === 6) t.setUTCDate(t.getUTCDate() - 1)
      if (dow === 0) t.setUTCDate(t.getUTCDate() + 1)
      return t.toISOString().slice(0, 10)
    }
    expect(naive(2022, 1, 1)).toBe(NYE)
    expect(isNyseTradingDay(naive(2022, 1, 1)),
           'the naive rule would close a day the NYSE traded').toBe(true)
  })

  it('the exception is narrow: a SUNDAY New Year’s IS observed on the Monday', () => {
    // 2023-01-01 was a Sunday; the NYSE observed it on Monday 2023-01-02.
    expect(nyseHolidays(2023).find(h => h.name === "New Year's Day")?.date).toBe('2023-01-02')
    expect(isNyseTradingDay('2023-01-02')).toBe(false)
  })
})
