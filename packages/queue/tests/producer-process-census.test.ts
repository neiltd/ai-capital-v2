// THE PRODUCER PROCESS CENSUS SEES THE WHOLE CHAIN, NOT ITS MIDDLE.
//
// THE DEFECT THIS FILE PINS. `PRODUCER_PROCESS_PATTERNS` used to carry one
// substring per label, and for two labels that substring named a process at the
// middle of a launch chain. `measure()` (launchd.ts:700-702) sets
// `stopped = noProcess && (absent || disabled-and-idle)`, so a producer the
// census cannot see makes `noProcess` true and the label reads as STOPPED while
// the producer is alive:
//
//   daily   launchd starts `/bin/bash .../scripts/daily-scheduler.sh`, which
//           only reaches `daily-queue.sh` at daily-scheduler.sh:492. Before that
//           line - and on every run that exits without submitting - nothing in
//           the chain carried 'daily-queue.sh'. At the other end,
//           daily-queue.sh:149 runs the submitter through `npx`, so an orphaned
//           `run-daily.ts` outlives the wrapper that was being matched.
//
//   alerts  run-alerts.sh:36-37 EXECS, replacing the only argv that carried
//           'run-alerts.sh', and run-stage.ts:120 spawns the real work
//           `detached`.
//
// THE FIXTURES ARE A REGRESSION LOCK, NOT PROOF OF REAL ARGV. Every command
// line below is written as `ps -Ao pid=,command=` would show it, shebang
// interpreter included, and is REASONED FROM CODE - from the plists'
// `ProgramArguments`, from the `exec` and `spawn` sites cited above, and from
// daily-queue.sh:80-81's account of the `npx` -> `npm exec` handoff. No argv
// here was observed from a running producer. What these cases pin is that the
// reviewed constant still covers the chains as documented; if the real argv
// differs, the fixtures are what must be corrected, and they are deliberately
// written so that correcting them is a one-line edit per process.
//
// NO LIVE PROCESS TABLE IS READ. Every case injects a fake `commands.run` that
// answers `/ps` from a table, reusing `world()` from ./support/ops-world.js -
// the same seam installed-unloaded.test.ts:620-638 uses. The census itself is
// the real one.

import { describe, it, expect, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

import { REVIEWED_PRODUCERS } from '@common/db/pg-copy'

import {
  launchdQuiescenceAdapter, matchesProducerPattern, LaunchdInspectionRefused,
  PRODUCER_PROCESS_PATTERNS,
} from '../src/pg-copy-ops/launchd.js'
import { world, ROOTS } from './support/ops-world.js'

const DAILY = 'com.thanapol.ai-capital.daily'
const WATCHDOG = 'com.thanapol.ai-capital.watchdog'
const ALERTS = 'com.thanapol.ai-capital.alerts'
const STRUCTURED = 'com.thanapol.ai-capital.structured-worker'
const WORKER = 'com.thanapol.ai-capital.worker'

const ROOT = '/Users/thanapold/ai-capital-runtime'

/** Every fixture argv, as `ps` would print the command column. */
const ARGV = Object.freeze({
  launchd: '/sbin/launchd',
  // daily, in chain order (daily.plist ProgramArguments -> :492 -> :149).
  scheduler: `/bin/bash ${ROOT}/scripts/daily-scheduler.sh`,
  submitWrapper: `/bin/bash ${ROOT}/daily-queue.sh --logical-date 2026-10-04`,
  runDaily: `node /opt/homebrew/bin/npx tsx ${ROOT}/packages/queue/bin/run-daily.ts --logical-date 2026-10-04`,
  // watchdog: launchd starts it directly.
  watchdog: `/bin/bash ${ROOT}/scripts/pipeline-watchdog.sh`,
  // alerts, after the exec at run-alerts.sh:36-37, then run-stage.ts:120.
  runStage: `node /opt/homebrew/bin/npx tsx ${ROOT}/packages/queue/bin/run-stage.ts -- /opt/homebrew/bin/npx tsx src/cli/cli-alerts.ts`,
  cliAlerts: 'node /opt/homebrew/bin/npx tsx src/cli/cli-alerts.ts',
  // worker: caffeinate keeps the whole command in its own argv.
  worker: `/usr/bin/caffeinate -i /opt/homebrew/bin/npx tsx ${ROOT}/packages/queue/bin/worker.ts`,
  structured: `node /opt/homebrew/bin/npx tsx bin/structured-worker.ts`,
})

const ctx = (): { signal: AbortSignal } => ({ signal: new AbortController().signal })

/** A ps listing: launchd at pid 1, then the given lines from pid 900 up. */
const psTable = (...lines: readonly string[]): string =>
  [`    1 ${ARGV.launchd}`, ...lines.map((l, n) => `  ${900 + n} ${l}`)].join('\n') + '\n'

/**
 * A cutover world - plists installed, labels booted out, so every label reports
 * `presence: 'absent'` - with `/ps` answered from this table and everything
 * else answered by the reviewed fake.
 */
const measureWith = async (ps: string) => {
  const w = world({ unloaded: true })
  return await launchdQuiescenceAdapter(REVIEWED_PRODUCERS, {
    uid: '501', agentsDir: w.agents,
    commands: {
      openPlist: w.commands.openPlist,
      run: async (file: string, args: readonly string[], c: never) => {
        if (file.endsWith('/ps')) return { code: 0, stderr: '', stdout: ps }
        return await w.commands.run(file, args, c)
      },
    },
  }).measure(ctx())
}

afterAll(() => {
  for (const r of ROOTS) { try { rmSync(r, { recursive: true, force: true }) } catch { /* bounded */ } }
})

// ── C1-C3. The three processes the old constant could not see ──────────────

describe('a producer the census could not see used to read as stopped', () => {
  it('C1: the daily SCHEDULER alone defeats quiescence, before it ever submits', async () => {
    // Nothing else from the daily chain is alive: this is the eligibility phase,
    // or a run that exited at daily-scheduler.sh:483-486 without submitting.
    const states = await measureWith(psTable(ARGV.scheduler))
    const daily = states.find(s => s.name === DAILY)
    expect(daily?.presence).toBe('absent')
    expect(daily?.stopped).toBe(false)
    expect([...(daily?.processPids ?? [])]).toEqual(['900'])
  })

  it('C2: an ORPHANED run-daily.ts submitter defeats quiescence', async () => {
    // Its parent wrapper has died, so neither 'daily-queue.sh' nor
    // 'daily-scheduler.sh' is anywhere in the listing.
    const ps = psTable(ARGV.runDaily)
    expect(ps).not.toContain('daily-queue.sh')
    expect(ps).not.toContain('daily-scheduler.sh')
    const states = await measureWith(ps)
    const daily = states.find(s => s.name === DAILY)
    expect(daily?.presence).toBe('absent')
    expect(daily?.stopped).toBe(false)
    expect([...(daily?.processPids ?? [])]).toEqual(['900'])
  })

  it('C3a: the alerts LAUNCHER after the exec defeats quiescence', async () => {
    const ps = psTable(ARGV.runStage)
    expect(ps).not.toContain('run-alerts.sh')
    const states = await measureWith(ps)
    const alerts = states.find(s => s.name === ALERTS)
    expect(alerts?.presence).toBe('absent')
    expect(alerts?.stopped).toBe(false)
    expect([...(alerts?.processPids ?? [])]).toEqual(['900'])
  })

  it('C3b: the spawned alerts RUNTIME alone defeats quiescence', async () => {
    const ps = psTable(ARGV.cliAlerts)
    expect(ps).not.toContain('run-alerts.sh')
    expect(ps).not.toContain('run-stage.ts')
    const states = await measureWith(ps)
    const alerts = states.find(s => s.name === ALERTS)
    expect(alerts?.presence).toBe('absent')
    expect(alerts?.stopped).toBe(false)
    expect([...(alerts?.processPids ?? [])]).toEqual(['900'])
  })
})

// ── C4. No pattern may reach into another label's chain ────────────────────

describe('the reviewed patterns are disjoint across labels', () => {
  /** Every fixture argv, with the ONE label whose chain it belongs to. */
  const OWNERS: readonly { argv: string; label: string; what: string }[] = Object.freeze([
    { argv: ARGV.scheduler, label: DAILY, what: 'the daily scheduler' },
    { argv: ARGV.submitWrapper, label: DAILY, what: 'the submit wrapper' },
    { argv: ARGV.runDaily, label: DAILY, what: 'the run-daily.ts submitter' },
    { argv: ARGV.watchdog, label: WATCHDOG, what: 'the watchdog' },
    { argv: ARGV.runStage, label: ALERTS, what: 'the alerts launcher after the exec' },
    { argv: ARGV.cliAlerts, label: ALERTS, what: 'the spawned alerts runtime' },
    { argv: ARGV.worker, label: WORKER, what: 'the queue worker under caffeinate' },
    { argv: ARGV.structured, label: STRUCTURED, what: 'the structured worker' },
  ])

  it('C4: each fixture matches its OWN label and no other', () => {
    for (const { argv, label, what } of OWNERS) {
      for (const other of REVIEWED_PRODUCERS) {
        const pattern = PRODUCER_PROCESS_PATTERNS[other] as string
        expect(matchesProducerPattern(argv, pattern), `${what} vs ${other}`)
          .toBe(other === label)
      }
    }
  })

  it('C4: every fixture is owned by exactly one label', () => {
    for (const { argv, what } of OWNERS) {
      const owners = REVIEWED_PRODUCERS.filter(
        l => matchesProducerPattern(argv, PRODUCER_PROCESS_PATTERNS[l] as string))
      expect(owners, what).toHaveLength(1)
    }
  })
})

// ── C5. An empty alternative would match every process alive ───────────────

describe('an empty alternative is refused, never ignored', () => {
  it('C5a: every reviewed label has a value and no empty alternative', () => {
    for (const label of REVIEWED_PRODUCERS) {
      const pattern = PRODUCER_PROCESS_PATTERNS[label]
      expect(pattern, label).toBeTypeOf('string')
      expect(pattern, label).not.toBe('')
      for (const a of (pattern as string).split('|')) {
        expect(a, `${label} alternative of ${JSON.stringify(pattern)}`).not.toBe('')
      }
    }
  })

  it('C5b: a malformed pattern REFUSES, whatever the command contains', () => {
    for (const bad of ['a|', '|a', 'a||b', '']) {
      // Refused for a command that WOULD have matched a non-empty alternative,
      // not only for one that would not: the check runs before any test.
      expect(() => matchesProducerPattern('xxx a b xxx', bad), JSON.stringify(bad))
        .toThrow(LaunchdInspectionRefused)
      expect(() => matchesProducerPattern('nothing here', bad), JSON.stringify(bad))
        .toThrow(/empty alternative/)
    }
  })

  it('C5b: a well-formed pattern still answers normally', () => {
    expect(matchesProducerPattern('a b c', 'b')).toBe(true)
    expect(matchesProducerPattern('a b c', 'z')).toBe(false)
    expect(matchesProducerPattern('a b c', 'z|b')).toBe(true)
    expect(matchesProducerPattern('a b c', 'z|y')).toBe(false)
  })
})
