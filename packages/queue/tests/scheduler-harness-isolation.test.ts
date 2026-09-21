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
      const e: NodeJS.ProcessEnv = { ...process.env, CI: '1' }
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

  it('reports PASS=12 FAIL=0', () => {
    expect(out, report).toMatch(/^PASS=12 FAIL=0$/m)
  })

  it('never hits the partial-isolation refusal', () => {
    expect(out, report).not.toContain('PARTIALLY isolated')
    expect(out, report).not.toContain('REFUSING TO RUN')
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
    const calls = src.match(/^run_isolated \.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh --dry-run$/gm) ?? []
    expect(calls.length, `expected 4 helper call sites, found ${calls.length}`).toBe(4)
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
    const refs = src.match(/^.*\.\/scripts\/(daily-scheduler|pipeline-watchdog)\.sh.*$/gm) ?? []
    const stray = refs.filter(l => !/^run_isolated \.\/scripts\//.test(l.trim()))
    expect(stray, `unisolated invocation(s):\n  ${stray.join('\n  ')}`).toEqual([])
  })

  it('checks the captured exit status for all four real cases before awarding PASS', () => {
    const checks = src.match(/if \[ "\$ISO_RC" -ne 0 \]; then/g) ?? []
    expect(checks.length, `expected 4 exit-status guards, found ${checks.length}`).toBe(4)
  })

  it('uses a disposable root and a non-production Redis endpoint', () => {
    expect(src).toMatch(/ISO_ROOT="\$TMP\//)
    expect(src, 'the Redis endpoint must not be the production port').toMatch(/ISO_REDIS="redis:\/\/127\.0\.0\.1:(?!6379)\d+"/)
  })
})
