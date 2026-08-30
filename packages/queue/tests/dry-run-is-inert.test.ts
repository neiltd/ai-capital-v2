import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, closeDb, logicalRunDate } from '@common/pipeline-runs'

// FINDING 3 — `--dry-run` must not write.
//
// Both schedulers computed their output paths and ran `mkdir -p "$ROOT/logs"
// "$ROOT/data"` before consulting `--dry-run`, then logged through a `log()`
// that appended to the real logfile, and the watchdog redirected its status
// call's stderr into that same file. So the one command an operator is told to
// run before activation — the safe preview — created directories, appended to
// `logs/daily-scheduler.log`, and could write `data/.scheduler-last-state`,
// which then suppresses the first REAL state-change log line.
//
// A preview that mutates the thing it previews is not a preview.
//
// METHOD. The scripts hard-reset PATH for launchd, so `npx` cannot be stubbed;
// the branches are driven for real instead — an isolated run store at
// PIPELINE_RUNS_DB, seeded per case, plus SCHEDULER_TEST_NOW to fix the clock,
// which is what makes `eligible` and `not_due` reachable at any time of day.
// The real status CLI therefore runs, which is the stronger test.
//
// SAFETY: AI_CAPITAL_ROOT and PIPELINE_RUNS_DB point into a fresh temp
// directory; AI_CAPITAL_ROOT does not exist yet, so ANY write is visible. The
// isolation gate refuses partial isolation, and the scheduler refuses to submit
// at all while SCHEDULER_TEST_NOW is set. Nothing reaches Redis, the queue, or
// data/pipeline-runs.db.

const REPO = resolve(__dirname, '..', '..', '..')
const SCHEDULER = join(REPO, 'scripts', 'daily-scheduler.sh')
const WATCHDOG = join(REPO, 'scripts', 'pipeline-watchdog.sh')

let dir: string, root: string, dbPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dry-run-inert-'))
  root = join(dir, 'fake-root')          // deliberately NOT created
  dbPath = join(dir, 'store', 'runs.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fixed instant: 09:00 in Los Angeles on 2026-08-29, i.e. after the 07:00 due hour. */
const AFTER_DUE = '2026-08-29T16:00:00.000Z'
const BEFORE_DUE = '2026-08-29T12:00:00.000Z'   // 05:00 PDT — before the due hour
const LOGICAL = '2026-08-29'

/** Build an isolated run store and seed it. Lives under dir/store, not dir/. */
function seedStore(rows: Array<Record<string, unknown>> = []) {
  mkdirSync(join(dir, 'store'), { recursive: true })
  const db = openDb(dbPath)
  const ins = db.prepare(`INSERT INTO pipeline_runs
    (id, stage, started_at, ended_at, status, logical_date)
    VALUES (@id, 'daily-pipeline', @started_at, @ended_at, @status, @logical_date)`)
  for (const r of rows) {
    ins.run({ ended_at: null, logical_date: LOGICAL, ...r } as never)
  }
  db.close()
  closeDb()
}

function run(script: string, now: string | null = AFTER_DUE, dry = true) {
  return spawnSync('/bin/bash', dry ? [script, '--dry-run'] : [script], {
    encoding: 'utf-8', timeout: 120_000,
    env: {
      ...process.env,
      AI_CAPITAL_ROOT: root,
      PIPELINE_RUNS_DB: dbPath,
      REDIS_URL: 'redis://localhost:6399/15',
      SCHEDULER_HEARTBEAT_FILE: join(dir, 'store', 'heartbeat.log'),
      ...(now ? { SCHEDULER_TEST_NOW: now } : {}),
    },
  })
}

/** Every path under the temp sandbox, so ANY creation is caught. */
function tree(base: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      out.push(p.slice(base.length + 1))
      if (statSync(p).isDirectory()) walk(p)
    }
  }
  walk(base)
  return out.sort()
}

/** The invariant, asserted the same way for every branch. */
function assertNothingWritten(r: ReturnType<typeof run>, label: string) {
  const created = tree(dir).filter(p => !p.startsWith('store'))   // the seeded store is ours, not the script's
  expect(created, `${label}: dry run created ${created.join(', ')}`).toEqual([])
  expect(existsSync(root), `${label}: dry run created AI_CAPITAL_ROOT`).toBe(false)
  expect(existsSync(join(root, 'logs', 'daily-scheduler.log'))).toBe(false)
  expect(existsSync(join(root, 'data', '.scheduler-last-state'))).toBe(false)
  expect(r.stderr, `${label}: the scheduler submitted for real`).not.toContain('submitting:')
}

describe('daily-scheduler.sh --dry-run', () => {
  it('ELIGIBLE: says it would submit, and writes nothing', () => {
    seedStore()                                   // no run for the logical date
    const r = run(SCHEDULER)
    expect(r.stdout, r.stderr).toContain(`would submit daily pipeline for ${LOGICAL}`)
    expect(r.status).toBe(0)
    assertNothingWritten(r, 'eligible')
  })

  it('ELIGIBLE: previews only — it never invokes the submission path', () => {
    seedStore()
    const r = run(SCHEDULER)
    const all = `${r.stdout}${r.stderr}`
    expect(all).not.toMatch(/submitting:/)
    expect(all).not.toMatch(/run-daily/)
    expect(all).not.toMatch(/Submitted|parentRunId/)
  })

  it('NOT DUE: before the due hour it is ineligible and writes no marker', () => {
    seedStore()
    const r = run(SCHEDULER, BEFORE_DUE)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/not eligible/)
    assertNothingWritten(r, 'not-due')
  })

  it('INELIGIBLE (already succeeded): exits 0 and creates no state marker', () => {
    seedStore([{ id: 'r1', started_at: '2026-08-29T14:30:00.000Z',
                 ended_at: '2026-08-29T15:10:00.000Z', status: 'success' }])
    const r = run(SCHEDULER)
    expect(r.status).toBe(0)
    assertNothingWritten(r, 'already-succeeded')
  })

  it('INELIGIBLE (in flight): does not submit a second run for the same day', () => {
    seedStore([{ id: 'r2', started_at: '2026-08-29T15:50:00.000Z', status: 'running' }])
    const r = run(SCHEDULER)
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('would submit')
    assertNothingWritten(r, 'in-flight')
  })

  it('STATUS UNAVAILABLE (no run store): refuses to act blind, writing nothing', () => {
    // No seedStore() — openDbReadOnly has fileMustExist, so the CLI fails.
    const r = run(SCHEDULER)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/refusing to act blind/)
    assertNothingWritten(r, 'no-store')
  })

  it('MALFORMED CLOCK: rejected outright, writing nothing', () => {
    seedStore()
    const r = run(SCHEDULER, 'not-an-instant')
    expect(r.status).not.toBe(0)
    assertNothingWritten(r, 'malformed-clock')
  })

  it('log output goes to stderr, never to a logfile', () => {
    seedStore()
    const r = run(SCHEDULER)
    expect(r.stderr).toMatch(/\[dry-run\]/)
    assertNothingWritten(r, 'stderr-logging')
  })

  it('E: a test clock is rejected BEFORE any runtime evidence is written', () => {
    // Not merely "cannot submit" — cannot leave a trace. A logfile, a directory
    // or a state marker created by a rejected invocation is itself misleading
    // evidence that the scheduler ran.
    seedStore()
    const r = run(SCHEDULER, AFTER_DUE, false)          // not a dry run
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/refusing to run for real on an overridden clock/)
    assertNothingWritten(r, 'real-run-with-test-clock')
    expect(existsSync(join(root, 'logs')), 'created the log directory').toBe(false)
    expect(existsSync(join(root, 'data')), 'created the data directory').toBe(false)
    expect(existsSync(join(root, 'data', 'daily-scheduler.lock'))).toBe(false)
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/run-daily|Submitted/)
  })

  it('E: the guard fires before the isolation check and the status call', () => {
    // Nothing is consulted first — no npx, no store read. The rejection is the
    // first thing that happens.
    seedStore()
    const r = run(SCHEDULER, AFTER_DUE, false)
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toMatch(/isolated|logical date|state=/)
  })
})

describe('pipeline-watchdog.sh: the same clock guard', () => {
  it('E: rejects a test clock before mkdir, log or heartbeat', () => {
    seedStore()
    const r = run(WATCHDOG, AFTER_DUE, false)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/refusing to run for real on an overridden clock/)
    assertNothingWritten(r, 'watchdog-real-run-with-test-clock')
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect(existsSync(join(dir, 'store', 'heartbeat.log'))).toBe(false)
  })
})

describe('pipeline-watchdog.sh --dry-run', () => {
  it('HEALTHY: reports and writes nothing — no heartbeat, no logfile', () => {
    seedStore([{ id: 'w1', started_at: '2026-08-29T14:30:00.000Z',
                 ended_at: '2026-08-29T15:10:00.000Z', status: 'success' }])
    const r = run(WATCHDOG)
    expect(r.status).toBe(0)
    assertNothingWritten(r, 'watchdog-healthy')
    expect(existsSync(join(dir, 'store', 'heartbeat.log')),
      'dry run appended a heartbeat').toBe(false)
  })

  it('NEEDS ATTENTION: reports the alert and still writes nothing', () => {
    seedStore()                                   // missing run, past due
    const r = run(WATCHDOG)
    assertNothingWritten(r, 'watchdog-attention')
    expect(existsSync(join(dir, 'store', 'heartbeat.log'))).toBe(false)
  })

  it('STATUS UNAVAILABLE: writes nothing', () => {
    const r = run(WATCHDOG)
    expect(r.status).toBe(1)
    assertNothingWritten(r, 'watchdog-no-store')
  })
})

// ── Non-vacuity: the harness can actually observe a write ──────────────────

describe('the zero-write assertion is not vacuous', () => {
  it('a real run WITHOUT a test clock does create the outputs', () => {
    // The contrast that gives every zero-write assertion its meaning, and it
    // must come from a genuinely real invocation — no override, real clock.
    //
    // SAFETY: the store is seeded with an IN-FLIGHT run for today's real
    // logical date, so the scheduler is ineligible and exits before the lock
    // and before submission. Nothing is submitted, and REDIS_URL points at a
    // port with no listener regardless.
    const today = logicalRunDate(new Date())
    mkdirSync(join(dir, 'store'), { recursive: true })
    const db = openDb(dbPath)
    db.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status, logical_date)
                VALUES ('inflight', 'daily-pipeline', ?, 'running', ?)`)
      .run(new Date().toISOString(), today)
    db.close(); closeDb()

    const r = run(SCHEDULER, null, false)          // no SCHEDULER_TEST_NOW
    expect(r.status, 'the real run did not exit cleanly').toBe(0)
    expect(existsSync(join(root, 'logs', 'daily-scheduler.log')),
      'the real run wrote nothing either — the comparison is meaningless').toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(true)
    // It stopped at ineligibility: no lock, no submission.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/run-daily|Submitted/)
    expect(existsSync(join(root, 'data', 'daily-scheduler.lock'))).toBe(false)
  })
})
