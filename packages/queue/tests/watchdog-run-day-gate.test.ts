import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ── THE WATCHDOG'S REAL ALERT GATE, ON A NON-RUN DAY ────────────────────────
//
// WHY NOT THROUGH THE SCRIPT. `--dry-run` stops at pipeline-watchdog.sh:158,
// which echoes `state=… alert=…` and exits before the gate at :164 that decides
// whether an alert is actually raised. So "the dry run printed alert=False" says
// nothing about the gate. And the script CANNOT be run for real under a test
// clock: :64-67 refuses outright when SCHEDULER_TEST_NOW is set, which is the
// right refusal — a fabricated clock must never produce a real alert — but it
// means a non-run day cannot be reached by running the whole script, because a
// non-run day is a property of the date.
//
// SO THE GATE ITSELF IS EXECUTED, taken verbatim from the script. The region
// from the status parse through the ALERT log is extracted by its exact first
// and last lines, run with DRY_RUN=0, and fed STATUS_JSON produced by the REAL
// status CLI — the same command line the script uses, which is asserted below
// so the two cannot drift. Nothing is reimplemented: the parse, the dry-run
// branch it must not take, the gate, the last-state marker and the ALERT log
// line are all the script's own bytes.
//
// SAFETY: temp database, temp heartbeat, temp ROOT. The real run store is never
// opened, no pipeline is submitted, and the notification path the gate used to
// own was retired in 2026-08 — the gate's only effects are a log line and a
// marker file, both inside the temp root.

const REPO = resolve(__dirname, '..', '..', '..')
const WATCHDOG = resolve(REPO, 'scripts', 'pipeline-watchdog.sh')
const TSX = resolve(REPO, 'node_modules', '.bin', 'tsx')
const STATUS_CLI = resolve(REPO, 'packages', 'pipeline-runs', 'bin', 'daily-run-status.ts')

const HOLIDAY = '2026-11-26'                       // Thanksgiving, Thursday — not a run day
const NOW = '2026-11-26T17:00:00.000Z'             // 09:00 America/Los_Angeles, well past due
const BEAT = '2026-11-26T13:00:00.000Z'            // 05:00 PST, after the 04:30 due time

const GATE_FIRST = 'read -r STATE ALERT LOGICAL REASON <<<'
const GATE_LAST = 'log "ALERT state=$STATE logical=$LOGICAL — $HEAD. $FULL_REASON"'

const src = readFileSync(WATCHDOG, 'utf-8')

/** The script's own gate text, from the status parse to the ALERT log line. */
function extractGate(): string {
  const start = src.indexOf(GATE_FIRST)
  const end = src.indexOf(GATE_LAST)
  expect(start, 'the status parse line moved or changed').toBeGreaterThan(-1)
  expect(end, 'the ALERT log line moved or changed').toBeGreaterThan(start)
  return src.slice(start, end + GATE_LAST.length)
}

let work: string
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'watchdog-gate-')) })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const SCHEMA = `CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT,
  logical_date TEXT, superseded_at TEXT);`

/** Run the real status CLI exactly as the watchdog does, and return its JSON. */
function statusJson(caseName: string, seedSql: string | null): { json: string; root: string } {
  const dir = join(work, caseName)
  execFileSync('/bin/mkdir', ['-p', dir])
  const db = join(dir, 'pipeline-runs.db')
  execFileSync('/usr/bin/sqlite3', [db, SCHEMA + (seedSql ?? '')], { encoding: 'utf-8' })
  const hb = join(dir, 'heartbeat.log')
  writeFileSync(hb, `${BEAT}\n`)

  const json = execFileSync(TSX, [STATUS_CLI, '--json'], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, PIPELINE_RUNS_DB: db, SCHEDULER_HEARTBEAT_FILE: hb,
           SCHEDULER_TEST_NOW: NOW },
  })
  return { json, root: dir }
}

/** Execute the extracted gate with DRY_RUN=0 and the given status JSON. */
function runGate(json: string, root: string): { stdout: string; log: string; marker: string | null } {
  const logPath = join(root, 'watchdog.log')
  execFileSync('/bin/mkdir', ['-p', join(root, 'data')])
  // Via a file, not an inline assignment: the JSON is multi-line and contains
  // quotes, and any shell-level quoting of it would be a transformation of the
  // exact bytes the gate is supposed to receive.
  const jsonPath = join(root, 'status.json')
  writeFileSync(jsonPath, json)
  const script = [
    'set -uo pipefail',
    `ROOT=${JSON.stringify(root)}`,
    `LOG=${JSON.stringify(logPath)}`,
    'DRY_RUN=0',
    'log() { echo "$*" >> "$LOG"; }',
    `STATUS_JSON=$(cat ${JSON.stringify(jsonPath)})`,
    extractGate(),
  ].join('\n')
  const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf-8', timeout: 60_000 })
  expect(r.status, `gate exited ${r.status}: ${r.stderr}`).toBe(0)
  const markerPath = join(root, 'data', '.watchdog-last-state')
  return {
    stdout: r.stdout ?? '',
    log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '',
    marker: existsSync(markerPath) ? readFileSync(markerPath, 'utf-8').trim() : null,
  }
}

describe('the extraction is the script, not a paraphrase', () => {
  it('the region contains both branches and the real effects', () => {
    const gate = extractGate()
    expect(gate).toContain('if [ "$DRY_RUN" -eq 1 ]; then')       // the branch it must not take
    expect(gate).toContain('if [ "$ALERT" != "True" ] && [ "$ALERT" != "true" ]; then')
    expect(gate).toContain('healthy, no alert')
    expect(gate).toContain('.watchdog-last-state')
    expect(gate).toContain('HEAD="daily pipeline failed"')
    expect(gate).toContain(GATE_LAST)
  })

  it('the status command this test runs is the one the script runs', () => {
    // If the script's invocation changed, the JSON fed to the gate here would no
    // longer be the JSON the gate actually receives in production.
    expect(src).toContain('npx tsx packages/pipeline-runs/bin/daily-run-status.ts --json')
  })

  it('the script still refuses a real run under a test clock', () => {
    // The reason the gate is exercised directly rather than by running the
    // script. Asserted so this test's whole premise cannot go stale silently.
    expect(src).toContain('SCHEDULER_TEST_NOW is set — refusing to run for real')
  })
})

describe('the gate on a non-run day', () => {
  it('with NO run row it does not alert, and records the state', () => {
    const { json, root } = statusJson('no-row', null)
    expect(JSON.parse(json).state, 'fixture is not a non-run day').toBe('not_trading_day')
    const r = runGate(json, root)
    expect(r.log, 'the watchdog alerted on a day nothing was expected')
      .not.toContain('ALERT state=')
    expect(r.log).toContain(`state=not_trading_day logical=${HOLIDAY} — healthy, no alert`)
    expect(r.marker).toBe(`${HOLIDAY}:not_trading_day`)
  })

  it('with a FAILED run row it DOES alert', () => {
    // Neil's option 1 (DECISION-92): a real run that failed on a non-run day is
    // still a failure. This is the case a run-day check placed at the top of
    // assessDailyRun would have silenced.
    const { json, root } = statusJson('failed-row', `INSERT INTO pipeline_runs
      (id, stage, started_at, ended_at, status, logical_date)
      VALUES ('t-failed', 'daily-pipeline', '2026-11-26T13:00:00.000Z',
              '2026-11-26T13:06:00.000Z', 'failed', '${HOLIDAY}');`)
    expect(JSON.parse(json).state).toBe('failed')
    const r = runGate(json, root)
    expect(r.log).toContain(`ALERT state=failed logical=${HOLIDAY}`)
    expect(r.log).toContain('daily pipeline failed')
    expect(r.log, 'a failure must not also be reported as healthy')
      .not.toContain('healthy, no alert')
    expect(r.marker, 'the healthy marker must not advance on an alert').toBeNull()
  })

  it('with a STALE running row it DOES alert', () => {
    const { json, root } = statusJson('stale-row', `INSERT INTO pipeline_runs
      (id, stage, started_at, status, logical_date)
      VALUES ('t-stale', 'daily-pipeline', '2026-11-26T13:00:00.000Z',
              'running', '${HOLIDAY}');`)
    expect(JSON.parse(json).state).toBe('stale')
    const r = runGate(json, root)
    expect(r.log).toContain(`ALERT state=stale logical=${HOLIDAY}`)
    expect(r.log).toContain('daily pipeline is stuck')
  })
})
