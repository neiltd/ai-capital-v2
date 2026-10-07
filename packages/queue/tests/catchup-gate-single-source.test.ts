import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync,
         chmodSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { logicalRunDate } from '@common/pipeline-runs'

// ── scripts/daily-catchup.sh TAKES ITS DECISION FROM ONE PLACE ──────────────
//
// REACHABILITY, FIRST. Nothing installed or scheduled runs this script: no
// tracked launchd template targets it (ops/launchd/*.template name
// run-alerts.sh, daily-scheduler.sh, pipeline-watchdog.sh or a queue bin), and
// neither daily-scheduler.sh nor pipeline-watchdog.sh invokes it. It is a
// hand-run tool, and it is kept because deleting it is a separate decision.
//
// That is exactly why it is worth pinning. An unreachable script is the one
// nobody re-reads, and this one used to decide for itself when the daily run
// was due: `[ "$(date +%H)" -lt 7 ]`, plus its own SQL filtered by SQLite
// 'localtime'. Three ways wrong at once — a second copy of the due time, the
// HOST's zone instead of America/Los_Angeles, and no run-day rule at all, so a
// hand-run on Thanksgiving would have submitted a pipeline.
//
// The decision now comes from daily-run-status.ts, which owns DUE_TIME and
// isDailyRunDay. The not-due and non-run-day behaviour is therefore the
// evaluator's, proven in packages/pipeline-runs/tests/run-day-alerts.test.ts;
// what has to be proven HERE is that this script adds no second opinion and
// acts on the evaluator's verdict.
//
// SAFETY: the script runs from a throwaway root containing only symlinks to
// `packages` and `node_modules`, so its log, lock and data all land in a temp
// directory. `daily-queue.sh` does not exist there, so a submission cannot
// happen even if the gate were wrong — asserted below rather than assumed.

const REPO = resolve(__dirname, '..', '..', '..')
const SCRIPT = resolve(REPO, 'scripts', 'daily-catchup.sh')
const src = readFileSync(SCRIPT, 'utf-8')
/** Executable text only, so the comments explaining the old defects do not count as the defects. */
const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

let work: string
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'catchup-gate-')) })
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** A root that can resolve the status CLI but cannot submit anything. */
function fakeRoot(name: string): string {
  const root = join(work, name)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  symlinkSync(join(REPO, 'packages'), join(root, 'packages'))
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'))
  const dst = join(root, 'scripts', 'daily-catchup.sh')
  copyFileSync(SCRIPT, dst)
  chmodSync(dst, 0o755)
  return root
}

const SCHEMA = `CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT,
  logical_date TEXT, superseded_at TEXT);`

function run(name: string, seedSql: string, extraEnv: Record<string, string> = {}) {
  const root = fakeRoot(name)
  const db = join(work, `${name}.db`)
  execFileSync('/usr/bin/sqlite3', [db, SCHEMA + seedSql], { encoding: 'utf-8' })
  const hb = join(work, `${name}.hb`)
  writeFileSync(hb, '')
  const r = spawnSync('/bin/bash', [join(root, 'scripts', 'daily-catchup.sh')], {
    encoding: 'utf-8',
    timeout: 180_000,
    env: { ...process.env, PIPELINE_RUNS_DB: db, SCHEDULER_HEARTBEAT_FILE: hb, ...extraEnv },
  })
  const logPath = join(root, 'logs', 'daily-catchup.log')
  return {
    status: r.status, stderr: r.stderr ?? '',
    log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '',
    root,
  }
}

describe('A. no second opinion about the due time or the run day', () => {
  it('the host-clock hour gate is gone', () => {
    expect(code, 'date +%H is the host zone, not the business zone').not.toContain('date +%H')
    expect(code).not.toMatch(/-lt\s+7\b/)
  })

  it('no SQLite localtime date filter remains', () => {
    expect(code).not.toContain("'localtime'")
  })

  it('no hour or HH:MM due time is hard-coded', () => {
    // Any literal clock time in executable text would be a second source of
    // truth. The only times that may appear are in `date '+%Y-%m-%d %H:%M:%S'`,
    // which formats the log timestamp and decides nothing.
    const withoutLogStamp = code.replace(/date '\+%Y-%m-%d %H:%M:%S'/g, '')
    expect(withoutLogStamp).not.toMatch(/\b\d{1,2}:\d{2}\b/)
    expect(withoutLogStamp).not.toMatch(/DUE_HOUR|DUE_TIME/)
  })

  it('the verdict comes from the same evaluator the scheduler reads', () => {
    expect(code).toContain('packages/pipeline-runs/bin/daily-run-status.ts --json')
    expect(code).toContain('["eligibleToRun"]')
    expect(code).toMatch(/if \[ "\$ELIGIBLE" != "True" \] && \[ "\$ELIGIBLE" != "true" \]; then/)
  })

  it('and the scheduler reads that same evaluator — one source, not two', () => {
    const scheduler = readFileSync(resolve(REPO, 'scripts', 'daily-scheduler.sh'), 'utf-8')
    expect(scheduler).toContain('packages/pipeline-runs/bin/daily-run-status.ts --json')
  })
})

describe('B. the gate acts on the verdict', () => {
  // Today's real business date, so these cases need no clock override — which
  // the script now refuses anyway (case C). A recorded outcome for today makes
  // the day ineligible whatever the hour, so the result does not depend on when
  // the suite runs.
  const today = logicalRunDate(new Date())

  it('a successful run today: not eligible, nothing submitted', () => {
    const r = run('success', `INSERT INTO pipeline_runs
      (id, stage, started_at, ended_at, status, logical_date)
      VALUES ('t-ok','daily-pipeline','${today}T13:00:00.000Z','${today}T13:30:00.000Z','success','${today}');`)
    expect(r.status, r.stderr).toBe(0)
    expect(r.log).toContain(`state=success logical=${today} — not eligible`)
    expect(r.log, 'it tried to submit').not.toContain('triggering catch-up run')
  })

  it('a failed run today: still not eligible, and says why', () => {
    // The old script had its own rule for this, with its own log line. The rule
    // is unchanged — a day that already failed is not auto-retried — but it now
    // comes from the evaluator's terminal-state branch.
    const r = run('failed', `INSERT INTO pipeline_runs
      (id, stage, started_at, ended_at, status, logical_date)
      VALUES ('t-bad','daily-pipeline','${today}T13:00:00.000Z','${today}T13:06:00.000Z','failed','${today}');`)
    expect(r.status, r.stderr).toBe(0)
    expect(r.log).toContain(`state=failed logical=${today} — not eligible`)
    expect(r.log).toContain('terminal, not auto-retried')
    expect(r.log).not.toContain('triggering catch-up run')
  })

  it('NON-VACUITY: the throwaway root could not have submitted anyway', () => {
    // So "nothing submitted" above is a statement about the gate, not about a
    // missing file. The submitter the script would call is absent by design.
    const root = fakeRoot('probe')
    expect(existsSync(join(root, 'daily-queue.sh'))).toBe(false)
    expect(code).toContain('"$ROOT/daily-queue.sh"')
  })
})

describe('C. a test clock cannot cause a submission', () => {
  it('refuses with exit 2 when SCHEDULER_TEST_NOW is set', () => {
    // The same refusal the scheduler and watchdog carry. Without it, a fixed
    // clock left in the environment would file a live run under a made-up date
    // — and would also be the obvious way to fake a run day.
    const today = logicalRunDate(new Date())
    const r = run('overridden', '', { SCHEDULER_TEST_NOW: `${today}T16:00:00.000Z` })
    expect(r.status).toBe(2)
    expect(r.log).toContain('refusing to submit on an overridden clock')
    expect(r.log).not.toContain('triggering catch-up run')
  })
})

describe('D. it fails closed when the state cannot be read', () => {
  it('exits 1 without submitting when the evaluator produces nothing', () => {
    // A catch-up that cannot tell what day it is must not spend API budget
    // guessing. Produced by pointing the script at a root with no `packages`.
    const root = join(work, 'blind')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const dst = join(root, 'scripts', 'daily-catchup.sh')
    copyFileSync(SCRIPT, dst)
    chmodSync(dst, 0o755)
    const r = spawnSync('/bin/bash', [dst], { encoding: 'utf-8', timeout: 180_000,
      env: { ...process.env, PIPELINE_RUNS_DB: join(work, 'blind.db') } })
    expect(r.status).toBe(1)
    const log = readFileSync(join(root, 'logs', 'daily-catchup.log'), 'utf-8')
    expect(log).toContain('refusing to submit blind')
    expect(log).not.toContain('triggering catch-up run')
  })
})
