import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// WHAT THIS GUARDS.
//
// decideIsolation() classifies three dimensions — database, Redis and filesystem
// — and refuses to run when only some are isolated, because isolating one
// disarms the safety mechanisms living in the others (2026-08-27: a
// filesystem-only isolated watchdog read the real LINE token). The scheduler
// harness overrode PIPELINE_RUNS_DB alone, so every real scheduler/watchdog
// invocation was refused as PARTIALLY isolated: PASS=9 FAIL=3.
//
// The already-successful case hid a second defect. It awarded PASS whenever
// "would submit" was ABSENT from the output — which is equally true when the
// script never ran at all. A refusal, a crash or a missing file all read as
// "correctly declined to submit". Exit status is now checked first.
//
// SAFETY: the harness is dry-run only, its Redis URL is loopback on a
// non-production port and is classified but never connected to, and its
// database and root live in a throwaway mktemp directory.

const REPO = resolve(__dirname, '..', '..', '..')
const HARNESS = 'scripts/test-scheduler-cases.sh'
const HARNESS_ABS = resolve(REPO, HARNESS)
const TIMEOUT_MS = 180_000

/** Production/credential variables must not leak into the child. */
const STRIP = [
  'DATABASE_URL', 'AGENT_DATABASE_URL', 'CLAIM_WRITER_DATABASE_URL', 'TEST_RUNTIME_DATABASE_URL',
  'PIPELINE_DATABASE_URL', 'AI_CAPITAL_COPY_DATABASE_URL', 'AI_CAPITAL_COPY_SOURCE_ROOT',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE',
  'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD',
  'ANTHROPIC_API_KEY', 'SEC_FUND_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN',
  'AI_CAPITAL_ROOT', 'PIPELINE_RUNS_DB', 'SCHEDULER_HEARTBEAT_FILE',
]

describe('A. the scheduler harness runs fully isolated and passes', () => {
  const r = spawnSync('/bin/bash', [HARNESS_ABS], {
    cwd: REPO,
    env: (() => {
      // A HOSTILE PARENT CLOCK. The harness must own its own instant; if any of
      // it were inherited, this value would move every fixture and the matrix
      // would report differently. It is set deliberately to a time BEFORE the
      // 04:30 opportunity, which is precisely the window in which the old
      // host-clock harness failed.
      const e: NodeJS.ProcessEnv = {
        ...process.env, CI: '1', SCHEDULER_TEST_NOW: '2026-08-27T09:00:00.000Z',
      }
      for (const k of STRIP) delete e[k]
      return e
    })(),
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const report = `status=${String(r.status)} signal=${String(r.signal)}\n--- output ---\n${out}`

  it('exits 0', () => {
    expect(r.status, report).toBe(0)
  })

  it('reports PASS=21 FAIL=0', () => {
    // 12 before the calendar rule; the 9 added cases are the six Cal checks and
    // the three real script runs on a holiday, a holiday watchdog and a Sunday.
    expect(out, report).toMatch(/^PASS=21 FAIL=0$/m)
  })

  it('never hits the partial-isolation refusal', () => {
    expect(out, report).not.toContain('PARTIALLY isolated')
    expect(out, report).not.toContain('REFUSING TO RUN')
  })

  it('the harness OWNS and supplies its own fixed SCHEDULER_TEST_NOW', () => {
    // It announces the instant it fixed, and that instant is the reviewed one —
    // not the hostile value this test put in its environment.
    expect(out, report).toMatch(/fixed clock: 2026-08-27T16:00:00\.000Z/)
    expect(out, report).toMatch(/2026-08-27 09:00 America\/Los_Angeles/)
  })

  it('a hostile parent SCHEDULER_TEST_NOW cannot change the result', () => {
    // The parent supplied 09:00Z (02:00 Los Angeles, BEFORE the opportunity).
    // If it won, Cases A, E and F would report not_due and the matrix would
    // fail — which is exactly what used to happen on the host clock.
    expect(out, report).not.toContain('2026-08-27T09:00:00.000Z')
    expect(out, report).toMatch(/^PASS=21 FAIL=0$/m)
  })

  it('performs no production Redis, database or pipeline action', () => {
    // Real submission and real delivery both announce themselves; dry-run does not.
    expect(out, report).not.toMatch(/\bsubmitted\b|FlowProducer|enqueued/i)
    expect(out, report).not.toMatch(/localhost:6379|127\.0\.0\.1:6379/)
    expect(out, report).not.toMatch(/postgres:\/\/|postgresql:\/\//)
    expect(out, report).not.toMatch(/launchctl/)
  })
})

describe('B. the harness cannot pass vacuously — structural contract', () => {
  const src = readFileSync(HARNESS_ABS, 'utf-8')

  it('routes every real scheduler/watchdog invocation through one helper', () => {
    expect(src, 'the centralized helper is gone').toMatch(/^run_isolated\(\)\s*\{/m)
    expect(src, 'the explicit-clock helper is gone').toMatch(/^run_isolated_at\(\)\s*\{/m)
    const calls = src.match(/^run_isolated \.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh --dry-run$/gm) ?? []
    expect(calls.length, `expected 4 shared-clock call sites, found ${calls.length}`).toBe(4)
    const atCalls = src.match(/^run_isolated_at '[^']+' \.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh --dry-run$/gm) ?? []
    expect(atCalls.length, `expected 3 explicit-clock call sites, found ${atCalls.length}`).toBe(3)
  })

  it('supplies all four isolation variables through that helper', () => {
    const helper = src.slice(src.indexOf('run_isolated() {'), src.indexOf('\n}', src.indexOf('run_isolated() {')))
    for (const v of ['AI_CAPITAL_ROOT', 'REDIS_URL', 'PIPELINE_RUNS_DB', 'SCHEDULER_HEARTBEAT_FILE']) {
      expect(helper, `${v} is not supplied by run_isolated`).toContain(`${v}=`)
    }
    expect(helper, 'the helper no longer forwards the command verbatim').toContain('"$@"')
    // --dry-run lives on the call sites so the portability contract can see it.
    const invocations = src.split('\n').filter(l => /\.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh/.test(l))
    expect(invocations.length, 'no real invocations remain').toBeGreaterThan(0)
    for (const line of invocations) expect(line, `invocation without --dry-run: ${line}`).toContain('--dry-run')
  })

  it('never invokes the real scripts outside the helper', () => {
    // Any occurrence of the script paths must be a `run_isolated` call site.
    // Two helpers now: run_isolated (the shared FIXED_NOW) and run_isolated_at
    // (an explicit instant, which the calendar cases need because each one is a
    // different day). Both isolate identically; only the clock differs.
    const refs = src.match(/^.*\.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh.*$/gm) ?? []
    const stray = refs.filter(l =>
      !/^run_isolated \.\/scripts\//.test(l.trim()) &&
      !/^run_isolated_at '[^']+' \.\/scripts\//.test(l.trim()))
    expect(stray, `unisolated invocation(s):\n  ${stray.join('\n  ')}`).toEqual([])
  })

  it('checks the captured exit status for all four real cases before awarding PASS', () => {
    // One per real script invocation: the original four, plus the three
    // calendar-rule runs (holiday scheduler, holiday watchdog, Sunday scheduler).
    const checks = src.match(/if \[ "\$ISO_RC" -ne 0 \]; then/g) ?? []
    expect(checks.length, `expected 7 exit-status guards, found ${checks.length}`).toBe(7)
  })

  it('supplies the fixed clock to every status check and real dry run', () => {
    // THREE PLACES, ALL REQUIRED: the helper that runs the real scripts, the
    // status check, and the declaration itself. A fixed clock supplied to only
    // some of them leaves the rest on the host clock.
    expect(src).toContain("readonly FIXED_NOW='2026-08-27T16:00:00.000Z'")
    const helper = src.slice(src.indexOf('run_isolated() {'), src.indexOf('sqlite3 "$DB"'))
    expect(helper).toContain('SCHEDULER_TEST_NOW="$FIXED_NOW"')
    const check = src.slice(src.indexOf('check() {'), src.indexOf('NOW_H='))
    expect(check).toContain('SCHEDULER_TEST_NOW="$FIXED_NOW"')
    // And an inherited value is discarded rather than trusted.
    expect(src).toContain('unset SCHEDULER_TEST_NOW')
  })

  it('leaves no real-time fallback in fixture construction', () => {
    // EXECUTABLE TEXT ONLY, so the comments explaining the defect do not count
    // as the defect. Every fixture is built from FIXED_NOW in the business zone.
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    for (const forbidden of ['date +%H', "date '+%H'", "date '+%Y-%m-%d'",
                             'datetime.now(', 'Date.now(']) {
      expect(code, forbidden).not.toContain(forbidden)
    }
    // Non-vacuity: the stripped text really is still the harness body.
    expect(code).toContain('run_isolated')
    expect(code).toContain('FIXED_NOW')
    expect(code).toContain("BUSINESS_TZ='America/Los_Angeles'")
  })

  it('every real scheduler/watchdog invocation remains dry-run only', () => {
    const calls = [...src.matchAll(/run_isolated \.\/scripts\/[a-z-]+\.sh([^\n]*)/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c[1]).toContain('--dry-run')
  })

  it('uses a disposable root and a non-production Redis endpoint', () => {
    expect(src).toMatch(/ISO_ROOT="\$TMP\//)
    expect(src, 'the Redis endpoint must not be the production port').toMatch(/ISO_REDIS="redis:\/\/127\.0\.0\.1:(?!6379)\d+"/)
  })
})
