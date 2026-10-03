// THE FIVE MODES, EXERCISED OFFLINE.
//
// NOTHING LIVE IS TOUCHED HERE. `launchctl` is never invoked at all - the
// adapter's COMMAND RUNNER is injected, which is the only seam there is now
// that the binary is a constant nobody can override from a command line. The
// source sessions are stubs that answer the reviewed SQL by string equality,
// the quiescence, queue and destination adapters are injected, and no Redis or
// PostgreSQL connection is opened by anything in this file. `plutil` IS run
// for real, on the bytes the adapter hands it, because parsing is the one
// thing a fake would make meaningless.
//
// What is being proved is the CLI's own reasoning: which mode may run, what
// each one publishes AND IN WHICH ORDER, what it refuses, and what it actually
// does when a fence will not release.

import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, fstatSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_RETRY_SCRATCH, REAL_EVIDENCE_OPS, RELEASE_SQL, REVIEWED_PRODUCERS,
  REVIEWED_QUEUES, discardScratch, evidenceNames, inspectScratch,
  publishRetainedScratch, EvidenceRefused, LifecycleEvidenceFailed,
  publishLifecycleBundle,
  type EvidenceOps, type ScratchInput,
  COPY_BINDING_SHAPE_VERSION, COPY_TABLES, INHERITED_FD_DIR, PASSFILE_CHILD_FD,
  QUEUE_SAMPLE_INTERVAL_MS, canonicalJson,
  assertCompletionMarker, contractDigest,
  publishEvidence, serializeArtifact, sha256Hex, verifyPublishedEvidence,
} from '@common/db/pg-copy'
import { afterEach, describe, expect, it } from 'vitest'

import {
  EXIT_ACTION_REQUIRED, EXIT_INTERVENTION_RESOLVED, EXIT_OK,
  EXIT_REFUSED, HELD_SIGNALS, HOLD_ACTIONS, INTENT_PREFIX, OUTCOME_PREFIX,
  DEAD_CHANNEL_IDLE_MS,
  HOLD_RETRY_INTERVAL_MS, PRE_RELEASE_OUTCOME, PRODUCER_AUTHORITY, REHEARSAL_OUTCOME, REHEARSAL_PREFIX,
  RESTORATION_PREFIX, REVIEW_PREFIX, isEntryPoint,
  MEASURED_IDENTITY_COLUMNS, MEASURED_IDENTITY_SQL, OPTIONS, OpsRefused,
  censusFromProver, freshCopyBindingFrom, measureIdentity, measuredCopyBinding,
  parseArgs, processHold,
  readStage1Authority, acceptExistingRecord, attemptRunId, freezeRecord,
  holdRecordFileSet, DETAIL_FILE,
  type FrozenRecord, type HoldInputs,
  type MeasuredIdentity, type Stage1Authority,
  verifyGateLink, type CensusResult, resolutionToken, runOpsCli, verifyReferencedBundle,
  readFencedCensus, verifyRehearsalChain,
  type FenceLike, type OpsDeps,
} from '../bin/pg-copy-ops.js'

/**
 * THE COPY BINDING, EXERCISED DIRECTLY.
 *
 * `--inspect --for=apply` was how these properties used to be reached, and
 * K7-B6.1 retires it: the production apply derives its binding from the
 * Stage-1 bundle it publishes inside its own fenced process, so a token minted
 * in an earlier process over an earlier bundle could only ever name a
 * different copy. The BINDING's behaviour is unchanged and still governs the
 * real apply, so these tests call it instead of the retired mode rather than
 * being deleted along with it.
 */
/**
 * A `FenceLike` stub. K7-B6.2 Phase F declared the capabilities the real
 * `PsqlBackend` always had - `pid`, `rows`, `alive` - so the production
 * supervisor satisfies `SupervisorSession` without a cast. Stubs state the
 * behaviour they are about and inherit the rest.
 */
const fenceStub = (over: Partial<FenceLike> = {}): FenceLike => ({
  pid: '41512',
  send: async () => ({ rows: [] as string[][], error: null }),
  rows: async () => [] as string[][],
  close: async () => undefined,
  alive: () => true,
  ...over,
})

const bindingOf = async (
  w: World, bundleDir: string, over: Partial<OpsDeps> = {},
): ReturnType<typeof measuredCopyBinding> =>
  await measuredCopyBinding(
    parseArgs(base(w, ['--inspect', '--for=rehearse', ...applyScope(bundleDir)])).values,
    deps(w, over), '/tmp/s')
import { RELEASE_GATE_PREFIX } from '@common/db/pg-copy'
import {
  openReviewedFileDescriptor, proveReviewedFileMetadata,
} from '../src/pg-copy-ops/secure-file.js'
import {
  launchdQuiescenceAdapter,
} from '../src/pg-copy-ops/launchd.js'
import { PassThrough } from 'node:stream'
import { BLOCKING_STATES, PAUSED_IS_BLOCKING } from '../src/pg-copy-ops/bullmq.js'

// THE FIXTURE LIVES IN `tests/support/ops-world.ts`.
//
// WHY IT MOVED. Every hold-capable case in this file now runs inside a CHILD
// PROCESS, because `holdForIntervention` is unbounded by design and nothing
// inside the process running it can stop it - see `tests/support/contained.ts`
// for why a `Promise.race`, a Vitest timeout and an `afterEach` are each
// insufficient. The child needs the same world, the same stubs and the same
// dependency wiring these in-process tests use, so all of it lives in one module
// that both sides import. Two copies would be two definitions of what "this
// world" means, and they would drift.
import {
  BACKEND_START, MAX_BUNDLES_PER_WORLD,
  PROVING_PID, ROOTS, ROOT_PREFIX, RUN_ID, STAMP, SUPERVISOR_PID,
  allBundles, applyScope, base, bundles, deps, fileDigestOf, goneProver,
  manifestOf, onlyBundle,
  proverStub, ready, rehearseArgs, sourceIdentity,
  stage1Bundle, strip, supervisorStub, takeUnscriptedHold, targetIdentity,
  tokenFor, world, type World,
} from './support/ops-world.js'
import {
  killContainedChildren, runContained, type ContainedResult,
} from './support/contained.js'
import {
  removeProvedRoot, unfreezeProvedRoot,
} from './support/roots.js'
import type { HoldSpec } from './support/hold-spec.js'

/**
 * THE MANDATORY GUARD. Read this before adding a test that can reach a hold.
 *
 * WHAT WENT WRONG, SO IT CANNOT AGAIN. `holdForIntervention` is unbounded by
 * design - there is no attempt count at which abandoning a held fence becomes
 * correct - and nothing injected can stop it: a `decide` that throws is an
 * unresolved attempt, a failed pause is swallowed, an unpublishable record is a
 * reason to keep holding. Two tests here reached a hold nobody had scripted.
 * Each iteration publishes an intent and an outcome, so they published until the
 * volume was full: 103 GB across twenty-two abandoned roots, and four orphaned
 * workers that ignored SIGTERM because the hold's own signal handlers were doing
 * exactly what they are built to do.
 *
 * THREE THINGS NOW MAKE THAT IMPOSSIBLE.
 *
 *   1. NO HOLD-CAPABLE CASE RUNS IN THIS PROCESS. Every one goes through
 *      `runContained`, which spawns its own process GROUP, polices wall clock,
 *      bundle count and bytes from outside, and SIGKILLs the group on breach -
 *      the only signal the hold cannot hold.
 *   2. EVERY `deps()` CARRIES A RESOLVER. The default is `forbiddenHold`, which
 *      records that a hold was entered unscripted and resolves nothing. There is
 *      no `__maxAttempts` to fall back on: a production hold a dependency could
 *      make finite is not a hold, and the seam has been removed.
 *   3. `afterEach` ENFORCES A BUNDLE CEILING AND ZERO RESIDUE, over the roots
 *      this process made AND the roots a contained child reported.
 */
afterEach(() => {
  const violations: string[] = []
  // FIRST, BEFORE ANYTHING IS REMOVED: kill any contained child still alive.
  //
  // A Vitest timeout rejects the test and abandons the promise `runContained`
  // returns, so its ceilings stop being checked while the detached child goes on
  // holding and writing. `afterEach` runs even then, and removing a root out from
  // under a process still publishing into it is how residue gets recreated behind
  // the cleanup - so the killing happens here, first, and is reported.
  const orphaned = killContainedChildren()
  if (orphaned.length > 0) {
    violations.push(
      `${orphaned.length} contained child(ren) were still running and had to be killed`)
  }
  const unscripted = takeUnscriptedHold()
  if (unscripted !== null) violations.push(unscripted)
  for (const r of ROOTS.splice(0)) {
    // PUBLISHED EVIDENCE IS FROZEN 0500/0400 ON PURPOSE, so a plain recursive
    // remove cannot descend into it. The suite unfreezes what it created; the
    // freeze itself is the property under test, not an obstacle to work around.
    //
    // AND THE UNFREEZE HAPPENS ONLY INSIDE A PROVED ROOT. Lifting permissions is
    // the most destructive thing this guard does, so the path is first proved to
    // be a real directory, directly beneath the real temporary directory, under
    // the reviewed name, owned by this user - a substituted or symlinked path is
    // refused here rather than chmod-ed and removed.
    try { unfreezeProvedRoot(r) } catch (e) {
      violations.push(`refused to clean up ${r}: ${(e as Error).message}`)
      continue
    }
    const evidence = join(r, 'evidence')
    let published = 0
    try { published = readdirSync(evidence).length } catch { published = 0 }
    if (published > MAX_BUNDLES_PER_WORLD) {
      violations.push(
        `a world published ${published} bundles, over the ${MAX_BUNDLES_PER_WORLD} ceiling`)
    }
    removeProvedRoot(r)
  }
  // ZERO RESIDUE, ALWAYS - after a success AND after a failure. Checked here
  // rather than at the end of the file, so the test that left something behind is
  // the one that fails. A contained child is given this process's prefix,
  // extended, so its roots are caught here too.
  const leftover = readdirSync(realpathSync(tmpdir()))
    .filter(n => n.startsWith(ROOT_PREFIX))
  if (leftover.length > 0) violations.push(`left ${leftover.length} root(s) behind`)
  if (violations.length > 0) {
    throw new Error(`HARNESS GUARD: ${violations.join('; ')}`)
  }
})

/**
 * Run one hold-capable case in its own process group and REQUIRE it to finish.
 *
 * The container's verdict is asserted here rather than swallowed: a case that had
 * to be killed is a case whose hold did not end when it should have, and the
 * ceiling that fired says which way it failed.
 */
async function contained(
  spec: HoldSpec, over?: Parameters<typeof runContained>[1],
): Promise<ContainedResult> {
  const r = await runContained(spec, over)
  expect(r.outcome, `${r.ceiling ?? 'no ceiling'}: ${r.stderr}`).toBe('completed')
  return r
}

/** The evidence root of a contained run that finished. */
const evidenceOf = (r: ContainedResult): string => {
  const root = r.report.evidence
  if (root === null) throw new Error(`the contained run reported no evidence root: ${r.stderr}`)
  return root
}
const restoreArgs = (w: World, extra: readonly string[] = []): string[] =>
  base(w, [
    '--verify-restoration', `--run-id=${RUN_ID}`, `--stamp=${STAMP}`,
    `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    ...extra,
  ])

const reviewArgs = (w: World, extra: readonly string[] = []): string[] =>
  base(w, [
    '--review-rehearsal', '--reviewer=operator-under-test',
    `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    `--run-id=${RUN_ID}`, `--stamp=${STAMP}`, ...extra,
  ])

/** Run rehearse then verify-restoration, and assert both succeeded. */
async function rehearseAndRestore(w: World, d?: OpsDeps): Promise<void> {
  const token = await tokenFor(w, 'rehearse', d)
  const r = await runOpsCli(rehearseArgs(w, token), d ?? deps(w))
  expect(r.exitCode, r.lines.join('\n')).toBe(EXIT_ACTION_REQUIRED)
  const s = await runOpsCli(restoreArgs(w), d ?? deps(w))
  expect(s.exitCode, s.lines.join('\n')).toBe(EXIT_OK)
}

// ---------------------------------------------------------------------------

describe('the command actually runs', () => {
  it('has a guarded entry point that an import does not trigger', () => {
    // K1.1-M08. Importing this module - which every test does - must start
    // nothing, open nothing and exit nothing. The guard is a fact about the
    // process, not a convention.
    const here = fileURLToPath(new URL('../bin/pg-copy-ops.ts', import.meta.url))
    expect(isEntryPoint(here, here)).toBe(true)
    expect(isEntryPoint(fileURLToPath(import.meta.url), here)).toBe(false)
    expect(isEntryPoint(undefined, here)).toBe(false)
    expect(isEntryPoint('/nonexistent/path', here)).toBe(false)
    const src = strip(readFileSync(here, 'utf-8'))
    expect(src).toContain('export async function main(')
    expect(src).toContain('if (isEntryPoint(process.argv[1]')
    // AND THE GUARD COMES BEFORE ANYTHING RUNS.
    expect(src.indexOf('if (isEntryPoint(process.argv[1]'))
      .toBeLessThan(src.indexOf('await main(process.argv.slice(2))'))
  })

  it('is reachable through the reviewed package command', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
        scripts?: Record<string, string>
      }
    expect(pkg.scripts?.['pg-copy-ops']).toBe('tsx bin/pg-copy-ops.ts')
  })

  it('constructs real source sessions through the secret-safe boundary', () => {
    // K1.1-M09. The production path opens psql through the reviewed backend,
    // takes a PASSFILE PATH rather than a password, checks that path as a
    // reviewed 0600 container, and wires the reviewed fence acquisition.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect(src).toContain('openPsqlBackend({')
    expect(src).toContain('acquireSourceFence(')
    // METADATA ONLY. `openReviewedContainer` RETURNS THE BYTES; calling it on
    // PGPASSFILE put the password in this process's memory while a comment
    // claimed the contents were not read.
    // THE DESCRIPTOR IS PINNED, not the pathname re-validated and let go.
    expect(src).toContain('openReviewedFileDescriptor(passfile)')
    expect(src).toContain('passfileFd: held.fd')
    expect(src).not.toContain('openReviewedContainer(passfile)')
    expect(src).not.toContain('passfile }')
    // NO URL, NO PASSWORD, NO ENVIRONMENT.
    expect(src).not.toContain('PGPASSWORD')
    expect(src).not.toMatch(/process\.env\.[A-Z_]+/)
    expect(src).not.toContain('--source-password')
  })

  it('takes the launchctl binary from nobody', () => {
    // K1.1-M10. Anyone who can pass an argument must not be able to decide
    // which program answers "is the fence quiescent". What is injectable is
    // the command RUNNER, which only code can supply.
    expect([...OPTIONS]).not.toContain('--launchctl')
    expect(() => parseArgs(['--inspect', '--launchctl=/tmp/x'])).toThrow(/unknown option/)
  })
})

describe('--inspect', () => {
  it('prints exactly one token, and it carries its mode in its syntax', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    expect(token.startsWith('PGCOPY-REHEARSE-')).toBe(true)
    const r = await runOpsCli(
      base(w, ['--for=rehearse', `--rehearsal-authorization=${w.authorization}`, '--inspect']),
      deps(w))
    expect(r.lines.filter(l => l.startsWith('confirmation ')).length).toBe(1)
    expect(r.lines.join('\n')).not.toContain('PGCOPY-APPLY-')
    // TRUTHFULLY. Measuring the source identity opens ONE read-only session,
    // so "opened no database session" stopped being true the moment the system
    // identifier stopped coming from argv.
    expect(r.lines.join('\n')).toContain('This inspection changed nothing.')
    expect(r.lines.join('\n'))
      .toContain('opened and closed ONE read-only session on the source')
    expect(r.lines.join('\n')).toContain('opened no target session')
  })

  it('opens no source session and publishes nothing', async () => {
    const w = await ready()
    const sup = supervisorStub()
    await tokenFor(w, 'rehearse', deps(w, { openSupervisor: async () => sup }))
    expect(sup.seen).toEqual([])
    expect(readdirSync(w.evidence)).toEqual([])
  })

  // K7-B6.1 PHASE F1: THE APPLY INSPECTION IS RETIRED, NOT RELAXED.
  //
  // A separately minted apply token named a bundle from an earlier process,
  // while the production apply now creates the only bundle it may bind to
  // inside its own fence. The two could never be the same copy, so a token
  // that still looked like authority was the hazard - not a missing feature.
  it('refuses --for=apply outright, and mints no apply token', async () => {
    const w = await ready()
    for (const extra of [[], ['--rehearsal-authorization=' + w.authorization]]) {
      const r = await runOpsCli(base(w, ['--for=apply', '--inspect', ...extra]), deps(w))
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/only --for=rehearse is inspectable/)
      // NO TOKEN OF EITHER SPECIES, and no copy binding line.
      expect(r.lines.join('\n')).not.toContain('PGCOPY-APPLY-')
      expect(r.lines.join('\n')).not.toContain('PGCOPY-REHEARSE-')
      expect(r.lines.some(l => l.startsWith('copy binding '))).toBe(false)
    }
  })
})

/**
 * The source with `runProductionApply` removed, for the guards that must hold
 * of every OTHER path in this CLI. It REFUSES rather than returning the whole
 * file if the function cannot be delimited - a guard that silently widens to
 * "no text removed" would pass for the wrong reason.
 */
function withoutProductionApply(src: string): string {
  const open = src.indexOf('export async function runProductionApply(')
  if (open < 0) throw new Error('runProductionApply not found: rescope this guard')
  const rest = src.slice(open + 1)
  const nextExport = rest.search(/\nexport (async function|function|const) /)
  if (nextExport < 0) throw new Error('runProductionApply end not found: rescope this guard')
  return src.slice(0, open) + src.slice(open + 1 + nextExport)
}

describe('--rehearse', () => {
  it('proves the world, publishes IN ORDER, releases, and stops short of finished',
    async () => {
      // CONTAINED, THOUGH THE HAPPY PATH REACHES NO HOLD.
      //
      // This case used to call `runOpsCli` directly in the Vitest worker, and that
      // is safe only while the release SUCCEEDS. It is a mutation target: removing
      // the `AUTHORIZATIONS.set` registration from `runOperationalGate` makes
      // `releaseFence` refuse the authorization as unregistered, `runRehearsal`
      // catches that WHILE THE FENCE IS HELD, and it enters the intervention hold
      // — which is unbounded by design and holds SIGTERM. In-worker, the test then
      // never returns, so `afterEach` never runs, nothing enforces a ceiling, and
      // the only thing left to stop it is the matrix-level supervisor killing the
      // whole process group. That is what happened: the K1 matrix reached exactly
      // this mutant and was terminated on its 5 GiB TMPDIR ceiling.
      //
      // Running it through the existing process boundary makes the mutant fail
      // HERE, by the container's own named assertion, in seconds and in kilobytes.
      // Nothing about the happy path changes: no hold is entered, so the limits
      // below are never approached.
      //
      // THE LIMITS ARE DELIBERATELY TIGHT. The success path publishes exactly two
      // bundles and finishes in a few seconds; a hold publishes an intent and an
      // outcome per iteration, for ever. Six bundles and 8 MiB leave the reviewed
      // path ample room and give a runaway almost none. The wall clock counts from
      // `spawn` here — `holdStartedAt` stays null when no hold is entered — so it
      // bounds the whole run, and it restarts from the hold if one ever begins.
      const r = await contained({}, {
        wallClockMs: 30_000,
        maxBundles: 6,
        maxBytes: 8 * 1024 * 1024,
      })
      const evidence = evidenceOf(r)

      expect(r.report.exitCode, r.report.lines.join('\n')).toBe(EXIT_ACTION_REQUIRED)
      expect(r.report.lines.join('\n')).toContain(REHEARSAL_OUTCOME)
      expect(r.report.supervisorSql).toContain(RELEASE_SQL)
      expect(r.report.supervisorClosed).toBe(1)
      expect(r.report.proverClosed).toBe(1)
      // AND NO HOLD WAS ENTERED AT ALL on the reviewed path.
      expect(r.report.holdStartedAt).toBeNull()
      expect(r.report.unscripted).toBeNull()

      // BOTH BUNDLES, AND THE PRE-RELEASE ONE CLAIMS NO SUCCESS.
      const gateDir = join(evidence, `${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`)
      const gate = manifestOf(gateDir, 'release-gate.json')
      expect(gate.outcome).toBe(PRE_RELEASE_OUTCOME)
      expect(gate.outcome).not.toBe(REHEARSAL_OUTCOME)
      expect(verifyPublishedEvidence(gateDir).length).toBeGreaterThan(0)

      const dir = join(evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
      const m = manifestOf(dir, 'rehearsal.json')
      expect(m.outcome).toBe(REHEARSAL_OUTCOME)
      expect(m.fence_state).toBe('released')
      expect(m.copy_lifecycle_rehearsed).toBe(false)
      expect(m.target_sessions_opened).toBe(0)
      // AND IT NAMES THE PRE-RELEASE RECORD BY DIGEST.
      expect((m.release_gate_bundle as { name: string }).name).toBe(basename(gateDir))
      // EXACTLY TWO BUNDLES: the ceiling above is generous, not load-bearing here.
      expect(bundles(evidence, RELEASE_GATE_PREFIX).length).toBe(1)
      expect(bundles(evidence, REHEARSAL_PREFIX).length).toBe(1)
    }, 180_000)

  it('publishes NO success bundle when the release is not proved', async () => {
    // K1.1-M11. This is the defect the ordering exists to fix. A success bundle
    // written before the release survives a refused, released-unproved or
    // unknown outcome - and `--review-rehearsal` reads bundles from disk and
    // asks no questions about when they were written.
    for (const over of [{ releaseError: true }, { releaseThrows: true }]) {
      // CONTAINED. This reaches a hold, and a hold is unbounded by design.
      // THE GATE MUST PASS FIRST. A prover that reports the backend gone from
      // the start refuses the gate itself, and the run would never reach a
      // release - which would make this test pass for the wrong reason.
      const r = await contained({
        supervisor: over,
        prover: { kind: 'gone-after-release' },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      })
      const evidence = evidenceOf(r)
      expect(r.report.exitCode, JSON.stringify(over)).not.toBe(EXIT_OK)
      // THE RELEASE WAS ACTUALLY ATTEMPTED, and it did not prove out.
      expect(r.report.supervisorSql, JSON.stringify(over)).toContain(RELEASE_SQL)
      // AND NO SUCCESS BUNDLE EXISTS.
      expect(bundles(evidence, REHEARSAL_PREFIX), JSON.stringify(over)).toEqual([])
      // THE PRE-RELEASE RECORD IS THERE, and it claims nothing about success.
      expect(bundles(evidence, RELEASE_GATE_PREFIX).length).toBe(1)
    }
  }, 180_000)

  it('never opens a target: no target session, no apply, no COMMIT', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    await runOpsCli(rehearseArgs(w, token), deps(w))
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // THESE STAY FORBIDDEN EVERYWHERE. This CLI never runs Stage 2 itself and
    // never writes SQL of its own to a target: the authorized apply HANDS the
    // reviewed lifecycle the openers and lets IT do the writing.
    for (const forbidden of ['runApply', 'runStage2',
                             'BEGIN READ WRITE', 'ALTER SEQUENCE', 'TARGET_COMMIT_SQL']) {
      expect(src, forbidden).not.toContain(forbidden)
    }
    // THE STAGE OPENERS ARE THE AUTHORIZED APPLY'S ALONE. Before K7-B6 no
    // apply path existed and this was a whole-file ban; the ban is what
    // mattered for the REHEARSAL, so it is now scoped to everything outside
    // `runProductionApply` rather than dropped because one caller appeared.
    const outside = withoutProductionApply(src)
    // THE EXCISION ACTUALLY HAPPENED. Without this the guard below would still
    // pass if `withoutProductionApply` quietly returned the whole file. The
    // CALL SITE stays - the `--apply` branch is outside the function and is
    // supposed to reference it; what must be gone is the BODY.
    expect(outside.length).toBeLessThan(src.length)
    // A CODE marker, not a comment: `strip` removes comments, so a comment
    // tripwire silently reports "not present" for the wrong reason.
    expect(src).toContain('restorationAuthority')
    expect(outside).not.toContain('restorationAuthority')
    for (const forbidden of ['openStageTarget', 'openStageSource',
                             'openVerifyTarget', 'openVerifySource']) {
      expect(outside, forbidden).not.toContain(forbidden)
    }
  })

  it('refuses an apply token pasted into a rehearsal', async () => {
    const w = await ready()
    const rehearse = await tokenFor(w, 'rehearse')
    const forged = rehearse.replace('PGCOPY-REHEARSE-', 'PGCOPY-APPLY-')
    const r = await runOpsCli(rehearseArgs(w, forged), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/not in the reviewed form for this mode/)
    expect(r.lines.join('\n')).not.toContain(forged)
  })

  it('refuses a token from a different run', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    const r = await runOpsCli(
      rehearseArgs(w, token).map(a => a === `--run-id=${RUN_ID}` ? '--run-id=deadbeef' : a),
      deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(bundles(w.evidence, REHEARSAL_PREFIX)).toEqual([])
  })

  it('refuses an attestation that still carries session census values', async () => {
    // K1.1-M12. An allowlist a person types is an allowlist a person can
    // extend by one line. Dropping it silently would leave an operator
    // believing the list still mattered, so a file that has one is refused.
    const w = await ready()
    writeFileSync(w.attestation, JSON.stringify({
      authorized_by: 'operator-under-test',
      authorized_at: '2026-09-25T10:00:00Z',
      procedure: 'manual A-G stop',
      sessions: [{ pid: '99999', role: 'ai_capital_owner' }],
    }))
    chmodSync(w.attestation, 0o600)
    const token = await tokenFor(w, 'rehearse')
    const r = await runOpsCli(rehearseArgs(w, token), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/may no longer supply session census values/)
  })

  it('refuses when a producer changed between the two censuses', async () => {
    // K1.1-M13. The pre-fence census answers "where do these agents write"
    // while they could still be running; the fenced one answers it frozen.
    // CONTAINED: a refused rehearsal still reaches a hold.
    const r = await contained({
      destinationsDrifted: true,
      prover: { kind: 'gone' },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    })
    expect(r.report.exitCode).not.toBe(EXIT_OK)
    expect(bundles(evidenceOf(r), REHEARSAL_PREFIX)).toEqual([])
  }, 180_000)
})

describe('the intervention protocol performs real operations', () => {
  it('offers only the operations the proved state allows', () => {
    // K1.1-M14. A single menu would offer a second ROLLBACK to an operator
    // whose ROLLBACK provably ran, and a release to one whose fence is gone.
    // EXACT MEMBERSHIP, not containment. A set that merely CONTAINS the right
    // operation can also contain a wrong one, and `NONE` offered on a fence
    // nobody proved gone is an operator told there is nothing left to do.
    expect([...HOLD_ACTIONS.held])
      .toEqual(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'])
    expect([...HOLD_ACTIONS.unproved])
      .toEqual(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'])
    expect([...HOLD_ACTIONS['not-held']])
      .toEqual(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'])
    expect([...HOLD_ACTIONS['release-unknown']]).toEqual(
      ['CENSUS_ONLY', 'REPROVE_AND_GATE',
       'TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF', 'ABANDON'])
    // AND `NONE` IS OFFERED ONLY WHERE THE FENCE IS PROVED GONE.
    for (const state of ['held', 'not-held', 'unproved', 'released-unproved',
                         'release-unknown'] as const) {
      expect(HOLD_ACTIONS[state], state).not.toContain('NONE')
    }
    // A PROVED ROLLBACK IS NEVER SENT AGAIN.
    // NO SECOND ROLLBACK. `ABANDON` is not one: it terminates the backend
    // from the prover and sends the supervisor nothing at all.
    expect([...HOLD_ACTIONS['released-unproved']]).toEqual(['CENSUS_ONLY', 'ABANDON'])
    // AND TERMINATION IS OFFERED ONLY WHERE THE OUTCOME IS UNKNOWN.
    expect(HOLD_ACTIONS['release-unknown'])
      .toContain('TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF')
    for (const state of ['held', 'not-held', 'unproved', 'released',
                         'released-unproved'] as const) {
      expect(HOLD_ACTIONS[state], state)
        .not.toContain('TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF')
    }
    expect([...HOLD_ACTIONS.released]).toEqual(['NONE'])
    // `ABANDON` IS NOT "WALK AWAY". It is the deliberate version - recorded
    // acceptance, termination from the prover, then a census - and the one
    // state it is NOT offered in is the one where the fence is already gone.
    expect(HOLD_ACTIONS.released).not.toContain('ABANDON')
  })

  it('holds on every catchable signal, SIGQUIT included', () => {
    // K1.1-M15. SIGQUIT is what a terminal still binds to Ctrl-\, and a handler
    // set that stopped at three would let it end a process holding a fence.
    expect([...HELD_SIGNALS].sort())
      .toEqual(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'])
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // AND THEY HOLD RATHER THAN EXIT.
    const handler = src.slice(src.indexOf('export function processHold'))
    expect(handler.slice(0, handler.indexOf('async decide'))).not.toContain('process.exit')
  })

  it('checks the per-run token BEFORE it looks up the operation', async () => {
    // K1.2-A16. A resolution typed for one hold must not resolve another -
    // including the next hold of the same command an hour later.
    //
    // AND A REFUSED RESOLUTION DOES NOT END THE HOLD. The first attempt below
    // throws, which is exactly what a wrong token produces; the loop records
    // that attempt and asks again rather than returning.
    // CONTAINED: the first attempt refuses, and a refusal is not an exit.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'gone-after-release' },
      hold: { kind: 'refuse', refusals: 1, actions: ['CENSUS_ONLY'] },
    })
    const evidence = evidenceOf(r)
    // IT ASKED TWICE AND RESOLVED ON THE SECOND, having returned in between
    // exactly never.
    expect(r.report.requests.length).toBe(2)
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    // EACH ATTEMPT HAS ITS OWN TOKEN, because each has its own run id.
    expect(new Set(r.report.requests.map(x => x.token)).size).toBe(2)
    // AND THE REFUSED ATTEMPT IS ON DISK as a non-terminal outcome.
    const outcomes = allBundles(evidence, OUTCOME_PREFIX)
    expect(outcomes.length).toBe(2)
    const first = manifestOf(join(evidence, outcomes[0] as string), 'outcome.json')
    expect(first.resolved).toBe(false)
    expect(String(first.chosen_action)).toBe('null')
    expect(String((manifestOf(join(evidence, outcomes[0] as string), 'actions.json')).result))
      .toMatch(/refused/)

    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const decide = src.slice(src.indexOf('async decide('))
    expect(decide.indexOf('supplied !== token'))
      .toBeLessThan(decide.indexOf('.includes(action)'))
  }, 180_000)

  it('writes the intent BEFORE the operation, naming the operation and token',
    async () => {
      // CONTAINED.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'gone-after-release' },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      })
      const evidence = evidenceOf(r)

      // TERMINAL, AND ONLY THEN A RETURN. The census found the backend gone,
      // which IS a proof that its locks are gone with it.
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      // CLOSED ONCE, AND ONLY AFTER THE TERMINAL RECORD. The hold owns both
      // sessions from the moment it begins; the `finally` in `runRehearsal`
      // must neither close them again nor leak them.
      expect(r.report.supervisorClosed).toBe(1)
      // ARMED TWICE, ONE HANDLER SET, DISARMED AT THE END.
      //
      // K8-E5: `arm` is now CALLED twice - once by `runRehearsal` before
      // `acquire`, so the fence is never held with nothing armed, and once by
      // `holdForIntervention` to replace the sentence. This stub counts CALLS.
      // The invariant that matters is not the call count: a second `arm` installs
      // no listener and returns the same disarm, which is pinned against
      // `process.listenerCount` in pg-copy-apply-orchestration.test.ts:1963.
      expect(r.report.armed).toBe(2)
      // AND EXACTLY TWO DISARMS. K8-E6 re-pins this to the deterministic value
      // rather than a lower bound: the stub resolver's `arm` returns a FRESH
      // counting closure per call (hold-child.ts), and both are called - the
      // hold's own in its `finally` (pg-copy-ops.ts:2137) and the rehearsal's in
      // runRehearsal's `finally` (:3426). Two arms, two closures, two calls.
      expect(r.report.disarmed).toBe(2)

      const intent = join(evidence, onlyBundle(evidence, INTENT_PREFIX))
      const outcome = join(evidence, onlyBundle(evidence, OUTCOME_PREFIX))
      expect(verifyPublishedEvidence(intent).length).toBeGreaterThan(0)
      expect(verifyPublishedEvidence(outcome).length).toBeGreaterThan(0)

      const i = manifestOf(intent, 'intent.json')
      expect(i.chosen_action).toBe('CENSUS_ONLY')
      expect(i.operator).toBe('operator-under-test')
      expect(i.resolution_token).toBe(r.report.requests[0]?.token)
      // PID AND BACKEND START, so a recycled pid cannot impersonate it.
      expect(i.supervisor_backend).toBe(`${SUPERVISOR_PID}@${BACKEND_START}`)
      // AND THE BUNDLES THIS RUN HAD ALREADY WRITTEN, BY DIGEST.
      const prior = i.prior_bundles as Array<{ name: string; digest_file_digest: string }>
      expect(prior.length).toBe(1)
      expect(prior[0]?.name).toBe(`${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`)
      expect(prior[0]?.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)

      // THE OUTCOME REFERENCES THE INTENT.
      const o = manifestOf(outcome, 'outcome.json')
      expect((o.intent_bundle as { name: string }).name).toBe(basename(intent))
      expect((o.intent_bundle as { digest_file_digest: string }).digest_file_digest)
        .toBe(fileDigestOf(intent))
    }, 180_000)

  it('never marks an intervention resolved just because a name was selected',
    async () => {
      // K1.1-M17. Selecting REPROVE_AND_GATE is not resolving anything;
      // proving the fence released is. Here the census finds the fence still
      // held and the fresh gate cannot pass, so nothing is resolved.
      // CONTAINED. A PARTIAL LOCK SET: the prover reports one advisory lock and
      // nothing else, which is neither a complete fence nor zero reviewed locks.
      // The backend goes only once the operator has looked a second time.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'partial-then-gone', resolveAfter: 1 },
        hold: { kind: 'script', actions: ['REPROVE_AND_GATE', 'CENSUS_ONLY'] },
      })
      const evidence = evidenceOf(r)
      // TWO ATTEMPTS, AND THE FIRST RESOLVED NOTHING.
      expect(r.report.requests.length).toBe(2)
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      const outcomes = allBundles(evidence, OUTCOME_PREFIX)
      expect(outcomes.length).toBe(2)
      const first = manifestOf(join(evidence, outcomes[0] as string), 'outcome.json')
      expect(first.resolved).toBe(false)
      expect(first.chosen_action).toBe('REPROVE_AND_GATE')
      // AND A PARTIAL LOCK SET IS NOT "RELEASED".
      expect(first.fence_state_after).toBe('unproved')
    }, 180_000)

  it('resolves only on a measurement that the fence is gone', async () => {
    // CONTAINED. THE CENSUS FINDS THE BACKEND GONE, which IS a proof the fence
    // is gone.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'gone' },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    })
    const evidence = evidenceOf(r)
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    const o = manifestOf(join(evidence, onlyBundle(evidence, OUTCOME_PREFIX)), 'outcome.json')
    expect(o.resolved).toBe(true)
    expect(o.fence_state_after).toBe('released')
  }, 180_000)

  it('sends NO second ROLLBACK after a released-unproved outcome', async () => {
    // K1.1-M18. The transaction provably ended. A second ROLLBACK would be a
    // statement nobody decided to send, against whatever transaction exists now.
    // NO SECOND ROLLBACK. `ABANDON` is not one: it terminates the backend
    // from the prover and sends the supervisor nothing at all.
    expect([...HOLD_ACTIONS['released-unproved']]).toEqual(['CENSUS_ONLY', 'ABANDON'])
    // CONTAINED.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'gone-after-release' },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    })
    // EXACTLY ONE ROLLBACK EVER LEFT THAT PROCESS.
    expect(r.report.supervisorSql.filter(x => x === RELEASE_SQL).length).toBe(1)
  }, 180_000)

  it('keeps the prover alive for the post-termination census', async () => {
    // CONTAINED. A BACKEND THAT IS REAPED ONLY AFTER IT IS TERMINATED: until
    // then the prover reports it alive holding the complete fence, which is what
    // a real one does between the `pg_terminate_backend` call and the reaping.
    const r = await contained({
      supervisor: { releaseThrows: true },
      prover: { kind: 'reaped-on-terminate' },
      hold: {
        kind: 'script', actions: ['TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF'],
      },
    })
    const evidence = evidenceOf(r)
    const seen = r.report.proverSql
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    expect(r.report.lines.join('\n')).toContain('terminated the supervisor backend')
    // THE TERMINATION WENT OUT ON THE PROVER, not on the thing being ended.
    expect(seen.some(x => x.includes('pg_terminate_backend'))).toBe(true)
    // AND THE PROVER ANSWERED AGAIN AFTERWARDS - it is alive through teardown.
    const at = seen.findIndex(x => x.includes('pg_terminate_backend'))
    expect(seen.slice(at + 1).some(x => x.startsWith('SELECT a.backend_start'))).toBe(true)
    // THE FENCE IS GONE AND THE DATABASE STATE IS STILL PROVABLE, because this
    // was a deliberate termination rather than an abandonment.
    const o = manifestOf(join(evidence, onlyBundle(evidence, OUTCOME_PREFIX)), 'outcome.json')
    expect(o.resolved).toBe(true)
    expect(o.database_state_provable).toBe(true)
  }, 180_000)

  it('ABANDON records the acceptance FIRST, then reaps, and says what is unprovable',
    async () => {
      // K1.2-A6. Not "walk away": walking away releases the fence by exiting.
      // This records what the operator accepted, terminates the backend from
      // the prover, and reports truthfully that the resulting database state
      // was not established.
      // CONTAINED.
      const r = await contained({
        supervisor: { releaseThrows: true },
        prover: { kind: 'reaped-on-terminate' },
        hold: { kind: 'script', actions: ['ABANDON'] },
      })
      const evidence = evidenceOf(r)
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      // THE ACCEPTANCE IS IN THE INTENT, which was published BEFORE anything
      // was terminated.
      const intent = manifestOf(join(evidence, onlyBundle(evidence, INTENT_PREFIX)),
                                'intent.json')
      expect(intent.chosen_action).toBe('ABANDON')
      expect(String(intent.accepted)).toMatch(/may not be provable/)
      // AND THE OUTCOME IS TRUTHFUL ABOUT WHAT WAS NOT ESTABLISHED.
      const o = manifestOf(join(evidence, onlyBundle(evidence, OUTCOME_PREFIX)),
                           'outcome.json')
      expect(o.resolved).toBe(true)
      expect(o.fence_state_after).toBe('released')
      expect(o.database_state_provable).toBe(false)
    }, 180_000)

  it('has no unconditional rollback in its finally', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const rehearse = src.slice(src.indexOf('export async function runRehearsal'))
    const fin = rehearse.slice(rehearse.indexOf('} finally {'),
                               rehearse.indexOf('export async function performHoldOperation'))
    expect(fin).not.toContain('ROLLBACK')
    expect(fin).not.toContain('releaseFence')
    // AND THE SUPERVISOR IS CLOSED ONLY WHEN THE FENCE IS NOT HELD AND NO
    // HOLD TOOK OWNERSHIP OF THE SESSIONS.
    expect(fin).toContain('if (!held && !torndown)')
  }, 180_000)
})

describe('--verify-restoration reproves the whole world', () => {
  it('proves the producers came back and publishes the record', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    const dir = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    const m = manifestOf(dir, 'restoration.json')
    expect(m.outcome).toBe('RESTORED')
    // IT BINDS THE REHEARSAL BY BASENAME AND DIGEST-FILE DIGEST.
    const named = m.operational_rehearsal as { name: string; digest_file_digest: string }
    expect(named.name).toBe(`${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    expect(named.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
    // AND IT RECORDS THE QUEUES AND THE BLOCKING POLICY.
    const detail = manifestOf(dir, 'producers.json')
    expect(Object.keys(detail.queue_depths as object).sort())
      .toEqual([...REVIEWED_QUEUES].sort())
    expect((detail.blocking_policy as { paused_is_blocking: boolean }).paused_is_blocking)
      .toBe(true)
  })

  it('refuses a rehearsal that does not record a proved release', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    const dir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    const file = join(dir, 'rehearsal.json')
    const doc = manifestOf(dir, 'rehearsal.json')
    doc.fence_state = 'unproved'
    execFileSync('/bin/chmod', ['u+w', dir])
    execFileSync('/bin/chmod', ['u+w', file])
    writeFileSync(file, `${JSON.stringify(doc)}\n`)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
  })

  it('reports an agent that did not come back rather than starting it', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    // The SAME world, now reporting its agents as loaded-but-not-running while
    // the policy still requires them running.
    const idle = await ready({ loaded: false })
    execFileSync('/bin/cp', ['-R',
      join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`), idle.evidence])
    execFileSync('/bin/chmod', ['-R', 'u+rwX', idle.evidence])
    const r = await runOpsCli(restoreArgs(idle), deps(idle))
    expect(r.exitCode).not.toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/NOT RESTORED|REFUSED/)
  })

  it('refuses a null last exit for a scheduled agent', async () => {
    // K1.1-M19. `loaded-scheduled-healthy` requires an EXACT successful last
    // exit. A null means launchd has no record of the agent ever having run,
    // which for a scheduled job that should have fired is the thing to look at.
    const w = await ready({ loaded: false, restorationRequired: 'loaded-scheduled-healthy',
                            lastExit: '126' })
    const token = await tokenFor(w, 'rehearse')
    await runOpsCli(rehearseArgs(w, token), deps(w))
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(r.lines.join('\n')).toMatch(/NOT RESTORED/)
  })

  it('refuses a policy that declines to name a required state', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    writeFileSync(w.restorationPolicy, JSON.stringify({
      producers: REVIEWED_PRODUCERS.map(label => ({ label, required: 'whatever' })),
    }))
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/no reviewed required state/)
  })
})

describe('--review-rehearsal and --apply', () => {
  it('closes a rehearsal only when both bundles verify from disk', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    const r = await runOpsCli(reviewArgs(w), deps(w))
    expect(r.exitCode, r.lines.join('\n')).toBe(EXIT_OK)
    const dir = join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)
    const m = manifestOf(dir, 'review.json')
    expect(m.reviewer).toBe('operator-under-test')
    expect(m.copy_lifecycle_rehearsed).toBe(false)
    expect(m.rehearsal_fence_state).toBe('released')
    // BOTH BUNDLES, BY NAME AND BY DIGEST.
    for (const k of ['operational_rehearsal', 'producer_restoration'] as const) {
      const ref = m[k] as { name: string; digest_file_digest: string }
      expect(ref.name.length).toBeGreaterThan(0)
      expect(ref.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('refuses a review whose bundles disagree about the binding', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    const dir = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    const file = join(dir, 'restoration.json')
    const doc = manifestOf(dir, 'restoration.json')
    doc.operational_adapter_binding_digest = 'f'.repeat(64)
    execFileSync('/bin/chmod', ['u+w', dir])
    execFileSync('/bin/chmod', ['u+w', file])
    writeFileSync(file, `${JSON.stringify(doc)}\n`)
    const r = await runOpsCli(reviewArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
  })

  it('refuses a review of a world that has since moved', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    writeFileSync(w.restorationPolicy, `${readFileSync(w.restorationPolicy, 'utf-8')} `)
    const r = await runOpsCli(reviewArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
  })

  it('builds a NON-NULL copy binding over the named bundle', async () => {
    // K1.1-M20. A confirmation over a null copy binding binds the operational
    // world and leaves the thing being copied unnamed - which is every field an
    // operator most needs the token to cover. The MINT moved into the fenced
    // apply (K7-B6.1 F1); the requirement that the binding exist and be
    // well-formed did not move, so it is asserted where it now lives.
    const w = await ready()
    const built = await bindingOf(w, stage1Bundle(w))
    expect(built.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(built.binding.bundleName.length).toBeGreaterThan(0)
    expect(built.stage1.copySet.length).toBeGreaterThan(0)
  })

  it('refuses to build a copy binding over a bundle that does not verify', async () => {
    const w = await ready()
    // A DIRECTORY THAT IS NOT A PUBLISHED BUNDLE.
    const bad = join(w.dir, 'not-a-bundle')
    mkdirSync(bad)
    await expect(bindingOf(w, bad)).rejects.toThrow(/does not verify/)
  })

  it('refuses an apply whose review names evidence that was replaced', async () => {
    // K1.1-M21. A review's DIGEST covers the review's bytes and nothing else.
    // The bundles it NAMES are separate directories anyone could have replaced.
    const w = await ready()
    await rehearseAndRestore(w)
    expect((await runOpsCli(reviewArgs(w), deps(w))).exitCode).toBe(EXIT_OK)
    const restoration = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    const file = join(restoration, 'DIGEST')
    execFileSync('/bin/chmod', ['u+w', restoration])
    execFileSync('/bin/chmod', ['u+w', file])
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\n`)
    const r = await runOpsCli(base(w, [
      '--apply',
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--producer-restoration-bundle=${restoration}`,
    ]), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
  })

  // K7-B6: THIS TEST CHANGED MEANING, and was not deleted for failing. It used
  // to prove that `--apply` refused because production apply was out of scope.
  // K7-B6 authorized that path, so the out-of-scope refusal and its prose are
  // gone. What is still worth holding is that an apply given NO driver
  // credential refuses on that, having done nothing through the supervisor -
  // and that it no longer mis-describes its own scope or the rehearsal.
  it('refuses an apply that names no driver credential, having done nothing', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    expect((await runOpsCli(reviewArgs(w), deps(w))).exitCode).toBe(EXIT_OK)
    const sup = supervisorStub()
    const bundleDir = stage1Bundle(w)
    const r = await runOpsCli(base(w, [
      '--apply',
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      // NO --bundle-dir: a production apply creates the only bundle it may
      // bind to. `applyScope` still supplies the target selectors.
      ...applyScope(bundleDir).filter(a => !a.startsWith('--bundle-dir=')),
    ]), deps(w, {
      openSupervisor: async () => sup,
      // K7-B: `--apply` now PREFLIGHTS THE OPERATOR CHANNEL FIRST, before any
      // session, Redis command or launchctl call - because a preflight that
      // fails after the fence is taken leaves a held source with nobody able to
      // tell this process to let go. This suite has no terminal, so without a
      // channel the run would refuse on the preflight and never reach the
      // truthful refusal below. A satisfied channel is injected so the rest of
      // the path is still exercised; the preflight's own refusal is proved in
      // `pg-copy-apply-ordering.test.ts`.
      operatorChannel: () => ({
        preflight: () => undefined,
        arm: () => () => undefined,
        nextLine: async () => '',
        close: () => undefined,
      }),
    }))
    const text = r.lines.join('\n')
    expect(r.exitCode).toBe(EXIT_REFUSED)
    // NOTHING WAS DONE THROUGH THE SUPERVISOR. The refusal lands before any
    // fence, stage or lifecycle call.
    expect(sup.seen).toEqual([])
    // IT REFUSES FOR THE ACTUAL REASON, and names the option rather than a
    // credential, a path or a digest.
    expect(text).toContain('a required option is missing')
    expect(text).toContain('--export-driver-credential')
    // K1.1-M22. IT NO LONGER CLAIMS THE REHEARSAL HAS NOT BEEN RUN, in a branch
    // that is only reached when a review proving one has just verified.
    expect(text).not.toMatch(/rehearsal itself has not|has not been run/)
    // AND IT NO LONGER CALLS THE AUTHORIZED PATH UNIMPLEMENTED.
    expect(text).not.toContain('out of scope in this milestone')
    // IT VERIFIED THE REVIEWED CHAIN, which is pre-fence work.
    expect(text).toContain('reviewed rehearsal ')
    // AND MEASURED NO BINDING, because K7-B6.1 Phase B derives it from the
    // bundle STAGE 1 PUBLISHES - so a refusal this early cannot have touched
    // a target identity session, and says nothing about a copy binding.
    expect(text).not.toMatch(/^copy binding /m)
    expect(text).not.toContain('stage 1 ')
  })

  it('PREFLIGHTS THE CHANNEL FIRST: no terminal means nothing is opened at all', async () => {
    // The companion to the case above. With no terminal and no resolution file
    // the apply must refuse on the channel, and the truthful
    // target-identity sentence must NOT appear - because no target session was
    // ever measured.
    const w = await ready()
    const sup = supervisorStub()
    const bundleDir = stage1Bundle(w)
    const r = await runOpsCli(base(w, [
      '--apply',
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      ...applyScope(bundleDir),
    ]), deps(w, { openSupervisor: async () => sup }))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(sup.seen).toEqual([])
    const text = r.lines.join('\n')
    expect(text).toMatch(/needs a terminal on stdin AND stdout, or a --resolution-file/)
    expect(text).not.toContain('read-only target identity session was opened and closed')
  })
})

describe('the world is measured, never accepted', () => {
  it('refuses when a reviewed producer points somewhere else than declared',
    async () => {
      const w = await ready()
      writeFileSync(w.credential, 'postgres://u:p@%2Ftmp%2Fs/somewhere_else\n')
      chmodSync(w.credential, 0o600)
      const r = await runOpsCli(restoreArgs(w), deps(w))
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/declared disposition/)
    })

  it('records the structured worker by INSTALLATION, not by destination',
    async () => {
      // K1.1-M23. Whether that agent exists on this machine at all is what
      // decides whether its absence from a quiescence census is expected;
      // where it would write if installed answers a different question.
      const w = await ready()
      await rehearseAndRestore(w)
      const m = manifestOf(join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`),
                           'restoration.json')
      const sw = m.structured_worker as {
        expected: string; actual: string; verdict: string
      }
      // MEASURED FRESH against the REVIEWED POLICY. The old check compared the
      // binding's copy of this field with the same binding, which held
      // whatever the world happened to be and passed for any state at all.
      expect(sw.expected).toBe('expected-absent')
      expect(sw.actual).toBe('expected-absent')
      expect(sw.verdict).toBe('as-reviewed')
      const src = strip(readFileSync(
        new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
      expect(src).not.toContain('structuredWorkerDisposition')
    })

  it('fabricates nothing for an absent label', async () => {
    // K1.1-M24. A plist path from a naming convention, a digest of sixty-four
    // zeroes, a served checkout of `/` - each is a measurement never taken,
    // recorded in a signed document as though it had been.
    const w = await ready()
    await rehearseAndRestore(w)
    const gate = manifestOf(join(w.evidence, `${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`),
                            'gate-detail.json')
    const rows = gate.fenced_producers as Array<Record<string, unknown>>
    const absent = rows.find(r => r.installation === 'expected-absent')
    expect(absent).toBeDefined()
    for (const k of ['plistPath', 'plistSha256', 'plistDeviceInode', 'servedCheckout',
                     'credentialPath', 'credentialDeviceInode', 'databaseHost',
                     'databasePort', 'databaseName']) {
      expect((absent as Record<string, unknown>)[k], k).toBeNull()
    }
    expect((absent as Record<string, unknown>).disposition).toBe('expected-absent')
    expect(JSON.stringify(rows)).not.toContain('0'.repeat(64))
  })

  it('needs an evidence root nobody else can write', async () => {
    const w = await ready()
    chmodSync(w.evidence, 0o777)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
    chmodSync(w.evidence, 0o700)
  })
})

describe('no live reach', () => {
  it('never reads a mode or an authority from the environment', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
    process.env.PGCOPY_MODE = '--apply'
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/ai_capital'
    try {
      const r = await runOpsCli(restoreArgs(w), deps(w))
      expect(r.exitCode).toBe(EXIT_OK)
    } finally {
      delete process.env.PGCOPY_MODE
      delete process.env.DATABASE_URL
    }
  })

  it('refuses any authority this milestone does not implement', async () => {
    const w = await ready()
    for (const authority of ['launchd-stop', 'bootout', 'none', '']) {
      const r = await runOpsCli(
        restoreArgs(w, [`--producer-authority=${authority}`]), deps(w))
      expect(r.exitCode, authority).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/only reviewed producer authority/)
    }
    expect(PRODUCER_AUTHORITY).toBe('manual-stop')
  })

  it('refuses a run id or stamp that is not in the reviewed form', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    for (const bad of [['--run-id=nothex01', `--stamp=${STAMP}`],
                       [`--run-id=${RUN_ID}`, '--stamp=2026-09-25']]) {
      const r = await runOpsCli(base(w, [
        '--rehearse', `--confirm=${token}`,
        `--rehearsal-authorization=${w.authorization}`,
        `--quiescence-attestation=${w.attestation}`, ...bad,
      ]), deps(w))
      expect(r.exitCode, bad.join(' ')).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n'), bad.join(' '))
        .toMatch(/the (run id|stamp) is not in the reviewed form/)
    }
  })
})

describe('the completion marker cannot be missing from a published bundle', () => {
  it('publication itself refuses a manifest without it', () => {
    expect(() => assertCompletionMarker({
      path: 'review.json', bytes: Buffer.from('{"record":"rehearsal-review"}\n', 'utf-8'),
    })).toThrow(/completion marker/)
    expect(() => assertCompletionMarker({
      path: 'review.json',
      bytes: Buffer.from('{"record":"rehearsal-review","complete":true}\n', 'utf-8'),
    })).not.toThrow()
  })

  it('refuses a review pointed at the wrong record', () => {
    // Two independent claims about what a bundle is, and only the second is
    // inside the frozen document the DIGEST covers.
    expect(() => verifyReferencedBundle('/nonexistent', REHEARSAL_PREFIX, 'rehearsal.json'))
      .toThrow()
  })
})

// ---------------------------------------------------------------------------
// K1.1: WHAT THE MUTATION MATRIX FOUND MISSING
// ---------------------------------------------------------------------------

describe('the resolution token is load-bearing', () => {
  /** Resolve a hold through a file under this run's own evidence root. */
  const resolveWith = async (w: World, text: string): Promise<string> => {
    const file = join(w.evidence, 'resolution.txt')
    writeFileSync(file, text)
    chmodSync(file, 0o600)
    const hold = processHold(() => undefined, w.evidence, file)
    try {
      const d = await hold.decide('release-unknown', HOLD_ACTIONS['release-unknown'],
                                  'PGCOPY-RESOLVE-' + 'a'.repeat(64))
      return `ok:${d.action}`
    } catch (e) {
      return `refused:${e instanceof Error ? e.message : ''}`
    }
  }

  it('refuses a resolution that does not carry THIS run\'s token', async () => {
    // K1.1-K27. A resolution typed for one hold must not resolve another -
    // including the next hold of the same command an hour later, which a plain
    // "yes" would have satisfied silently.
    const w = await ready()
    const good = 'PGCOPY-RESOLVE-' + 'a'.repeat(64)
    expect(await resolveWith(w, `CENSUS_ONLY operator ${good}`)).toBe('ok:CENSUS_ONLY')
    expect(await resolveWith(w, 'CENSUS_ONLY operator'))
      .toMatch(/does not carry this run's token/)
    expect(await resolveWith(w, `CENSUS_ONLY operator PGCOPY-RESOLVE-${'b'.repeat(64)}`))
      .toMatch(/does not carry this run's token/)
    // AND THE TOKEN IS CHECKED BEFORE THE OPERATION IS EVEN LOOKED UP: an
    // unreviewed operation with a wrong token fails on the TOKEN.
    expect(await resolveWith(w, 'DROP_EVERYTHING operator wrong-token'))
      .toMatch(/does not carry this run's token/)
    // A REVIEWED OPERATION WITH THE RIGHT TOKEN, but unreviewed for the state.
    expect(await resolveWith(w, `NONE operator ${good}`))
      .toMatch(/not reviewed for this state/)
    // AND AN OPERATOR MUST BE NAMED, in the reviewed form.
    expect(await resolveWith(w, `CENSUS_ONLY 1-not-a-name ${good}`))
      .toMatch(/needs a named operator/)
  })

  it('binds the token to the run, the binding and the backend', () => {
    const a = resolutionToken(RUN_ID, STAMP, 'a'.repeat(64), `${SUPERVISOR_PID}@${BACKEND_START}`)
    expect(a).toMatch(/^PGCOPY-RESOLVE-[0-9a-f]{64}$/)
    for (const other of [
      resolutionToken('ffffffff', STAMP, 'a'.repeat(64), `${SUPERVISOR_PID}@${BACKEND_START}`),
      resolutionToken(RUN_ID, '20260926T101500Z', 'a'.repeat(64),
                      `${SUPERVISOR_PID}@${BACKEND_START}`),
      resolutionToken(RUN_ID, STAMP, 'b'.repeat(64), `${SUPERVISOR_PID}@${BACKEND_START}`),
      resolutionToken(RUN_ID, STAMP, 'a'.repeat(64), `${SUPERVISOR_PID}@2026-09-25 11:00:00+00`),
    ]) {
      expect(other).not.toBe(a)
    }
  })

  it('refuses a resolution file outside this run\'s evidence root', async () => {
    // Resolving a hold requires write access to the directory the hold's own
    // evidence is published into - the same authority, rather than any path on
    // the filesystem that happens to contain the right words.
    const w = await ready()
    const outside = join(w.dir, 'elsewhere.txt')
    writeFileSync(outside, `CENSUS_ONLY operator PGCOPY-RESOLVE-${'a'.repeat(64)}`)
    chmodSync(outside, 0o600)
    const hold = processHold(() => undefined, w.evidence, outside)
    await expect(hold.decide('release-unknown', HOLD_ACTIONS['release-unknown'],
                             'PGCOPY-RESOLVE-' + 'a'.repeat(64)))
      .rejects.toThrow(/not under this run's evidence root/)
  })

  it('refuses a hold with no terminal and no resolution file', async () => {
    const w = await ready()
    const hold = processHold(() => undefined, w.evidence, null)
    if (process.stdin.isTTY !== true) {
      await expect(hold.decide('held', HOLD_ACTIONS.held, 'PGCOPY-RESOLVE-x'))
        .rejects.toThrow(/no terminal and no --resolution-file/)
    }
  })
})

describe('the intent is written before the operation is performed', () => {
  it('publishes the intent, then performs, then publishes the outcome',
    async () => {
      // K1.1-K31. If this process dies between the intent and the outcome, what
      // is on disk says which operation a named person was about to perform
      // against which backend. Written the other way round, a death in the same
      // window leaves no record at all.
      // CONTAINED. The child records `decide` and `perform` as they happen, and
      // what the evidence root held at each `perform`.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'gone' },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      })
      const evidence = evidenceOf(r)
      expect(r.report.order).toEqual(['decide', 'perform'])
      // THE INTENT WAS ALREADY ON DISK WHEN THE OPERATION RAN.
      const seenBefore = r.report.evidenceAtPerform[0] as readonly string[]
      expect(seenBefore).toContain(`${INTENT_PREFIX}-${STAMP}-${RUN_ID}`)
      expect(seenBefore).not.toContain(`${OUTCOME_PREFIX}-${STAMP}-${RUN_ID}`)
      // AND THE OUTCOME CAME AFTERWARDS.
      expect(readdirSync(evidence)).toContain(`${OUTCOME_PREFIX}-${STAMP}-${RUN_ID}`)
    }, 180_000)
})

describe('restoration re-proves every dimension', () => {
  it('reports a producer that came back pointing somewhere else', async () => {
    // K1.1-K34. A producer can come back RUNNING from a different plist,
    // serving a different checkout, holding a different credential that points
    // at a different database - and every one of those reads as "restored" to
    // a check that only looks at the state word.
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
    // The credential now names another database. The agents are still running.
    writeFileSync(w.credential, 'postgres://u:p@%2Ftmp%2Fs/somewhere_else\n')
    chmodSync(w.credential, 0o600)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/NOT RESTORED|REFUSED/)
  }, 180_000)

  it('refuses when a producer plist was replaced since the rehearsal', async () => {
    // The binding digest covers every producer's plist SHA-256, so a plist
    // edited between the rehearsal and the restoration moves the whole world
    // and the restoration refuses before it starts comparing labels. That is
    // the stronger answer: this restoration is not about the rehearsal it
    // claims to close.
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
    const label = REVIEWED_PRODUCERS[0] as string
    const p = join(w.agents, `${label}.plist`)
    writeFileSync(p, `${readFileSync(p, 'utf-8')}<!-- edited -->`)
    chmodSync(p, 0o644)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    // AND THE PER-LABEL COMPARISON EXISTS TOO, for a world that did not move.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect(src).toContain("'the plist is not the one measured'")
    expect(src).toContain("'the served checkout has changed'")
  })

  it('reports a queue sample that does not cover the reviewed set', async () => {
    // K1.1-K33. A sample of one queue satisfies "every depth is zero" the way
    // an empty room satisfies "everyone here is asleep".
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
    const r = await runOpsCli(restoreArgs(w), deps(w, {
      queue: { sample: async () => ({ depths: { 'daily-pipeline': 0 } }) },
    }))
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(r.lines.join('\n')).toMatch(/does not cover the reviewed queue set/)
  })

  it('refuses a null last exit for a scheduled agent, exactly', async () => {
    // K1.1-K35. A null means launchd has no record of the agent ever having
    // run, which for a scheduled job that should have fired is the thing to
    // look at, not the thing to wave through.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runVerifyRestoration'))
    const line = fn.slice(fn.indexOf('const healthy ='), fn.indexOf('const before ='))
    expect(line).toContain("seen.lastExitCode === '0'")
    expect(line).not.toContain('seen.lastExitCode === null')

    const w = await ready({ loaded: false, restorationRequired: 'loaded-scheduled-healthy' })
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
    // A LAST EXIT OF 0 IS SUCCESS; anything else, including nothing, is not.
    expect((await runOpsCli(restoreArgs(w), deps(w))).exitCode).toBe(EXIT_OK)
  })
})

describe('the review chain proves what it claims', () => {
  it('refuses a rehearsal that did not record a proved release', async () => {
    // K1.1-K37. A rehearsal that ended held, unproved or unknown did not
    // finish, and closing it as though it had is the failure the whole
    // evidence ordering exists to prevent.
    const w = await ready()
    await rehearseAndRestore(w)
    const dir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    const doc = manifestOf(dir, 'rehearsal.json')
    doc.fence_state = 'release-unknown'
    execFileSync('/bin/chmod', ['u+w', dir])
    execFileSync('/bin/chmod', ['u+w', join(dir, 'rehearsal.json')])
    writeFileSync(join(dir, 'rehearsal.json'), `${JSON.stringify(doc)}\n`)
    const r = await runOpsCli(reviewArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_REFUSED)

    // AND THE FUNCTION ITSELF REFUSES, for every non-released state.
    for (const state of ['held', 'unproved', 'release-unknown', 'released-unproved']) {
      doc.fence_state = state
      writeFileSync(join(dir, 'rehearsal.json'), `${JSON.stringify(doc)}\n`)
      expect(() => verifyRehearsalChain(
        dir, join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)), state)
        .toThrow()
    }
  })

  it('refuses two REAL bundles from two different worlds', async () => {
    // K1.1-K38. Both verify from disk, both carry a completion marker, both
    // are the record they say they are - what is wrong is that they describe
    // two different worlds. If the bindings differ, the producers came back
    // into a world other than the one whose fence was lifted, and neither
    // record describes the other's subject.
    //
    // EDITING A BUNDLE WOULD NOT TEST THIS. The DIGEST would refuse first, and
    // the check under test would never run - so the disagreement is produced
    // the only way a real one could be: by two genuine runs.
    const a = await ready()
    await rehearseAndRestore(a)
    const b = await ready()
    await rehearseAndRestore(b)
    expect(() => verifyRehearsalChain(
      join(a.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`),
      join(b.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)))
      .toThrow(/do not agree about the operational binding|closes a different rehearsal/)
    // AND EACH WORLD'S OWN PAIR IS FINE.
    expect(() => verifyRehearsalChain(
      join(a.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`),
      join(a.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`))).not.toThrow()
  })
})

describe('a bundle can be real and still be wrong', () => {
  /** Publish a VALID bundle whose CONTENT says the wrong thing. */
  function forge(
    w: World, prefix: string, manifestFile: string, manifest: Record<string, unknown>,
    runId: string,
  ): string {
    return publishEvidence({
      root: w.evidence, prefix, stamp: STAMP, runId,
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: manifestFile,
                  bytes: Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf-8') },
    }).finalPath
  }

  /**
   * A REAL, DIGEST-VALID BUNDLE THAT ADMITS IT IS NOT COMPLETE.
   *
   * `publishEvidence` CANNOT BUILD THIS, and that is itself part of the picture:
   * its `assertCompletionMarker` refuses a manifest whose `complete` is not
   * `true`, so the reviewed writer never emits an incomplete record. The tree is
   * therefore assembled directly — the same shape the publisher produces, frozen
   * to the same modes, with a DIGEST that genuinely covers the bytes — because
   * `verifyReferencedBundle` is a check on A DIRECTORY ON DISK, whoever put it
   * there. An operator assembling one by hand, an older writer, or a partially
   * written record recovered from elsewhere all reach it, and none of them is
   * obliged to have gone through `publishEvidence`.
   */
  function forgeIncomplete(
    w: World, prefix: string, manifestFile: string, manifest: Record<string, unknown>,
    runId: string,
  ): string {
    const dir = join(w.evidence, `${prefix}-${STAMP}-${runId}`)
    mkdirSync(dir, { mode: 0o700 })
    // TEXT, NOT BYTES, AND THE SAME TEXT FOR BOTH. `sha256Hex` hashes the UTF-8
    // encoding of a string, and the file is written from that same string, so the
    // digest describes exactly the bytes on disk by construction rather than by
    // two encodings happening to agree.
    const files: [string, string][] = [
      [manifestFile, `${JSON.stringify(manifest)}\n`],
      ['actions.json', '{}\n'],
    ]
    for (const [rel, text] of files) writeFileSync(join(dir, rel), text, 'utf-8')
    // THE DIGEST IS REAL: the reviewed helper, sorted by path, the reviewed
    // "<digest>  <path>" spelling, trailing newline.
    const body = files
      .map(([rel, text]) => ({ rel, d: sha256Hex(text) }))
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
      .map(e => `${e.d}  ${e.rel}`)
      .join('\n')
    writeFileSync(join(dir, 'DIGEST'), `${body}\n`, 'utf-8')
    // FROZEN EXACTLY AS PUBLICATION FREEZES: files 0400, root 0500, last.
    for (const rel of [...files.map(([r]) => r), 'DIGEST']) chmodSync(join(dir, rel), 0o400)
    chmodSync(dir, 0o500)
    return dir
  }

  it('M37 CONTROL: refuses a referenced bundle that is not complete', async () => {
    // THE M37 CONTROL. `verifyReferencedBundle` reads three things out of a
    // bundle it has already verified on disk: that the named manifest is there,
    // that `record` is the record it is being used as, and that `complete` is
    // true. The first two had controls; the third did not, so deleting the
    // completeness guard changed nothing any test could see.
    //
    // WHY THE DIGEST CANNOT CATCH THIS. A bundle whose manifest says
    // `complete: false` is a structurally perfect bundle: its DIGEST covers
    // exactly the bytes that are there, every file is frozen, and the tree
    // verifies. `complete` is a CLAIM THE WRITER MAKES ABOUT ITSELF — that it
    // finished — and the only way to catch a record admitting it did not is to
    // read the field.
    const w = await ready()

    for (const [label, manifest, runId] of [
      ['explicitly false', { record: REHEARSAL_PREFIX, complete: false,
                             outcome: REHEARSAL_OUTCOME }, 'd0000001'],
      // MISSING IS NOT TRUE. `!== true` is the reviewed spelling precisely so an
      // absent field fails closed rather than reading as absent-means-fine.
      ['missing entirely', { record: REHEARSAL_PREFIX,
                             outcome: REHEARSAL_OUTCOME }, 'd0000002'],
      // AND NEITHER IS A TRUTHY NON-BOOLEAN.
      ['the string "true"', { record: REHEARSAL_PREFIX, complete: 'true',
                              outcome: REHEARSAL_OUTCOME }, 'd0000003'],
    ] as [string, Record<string, unknown>, string][]) {
      const dir = forgeIncomplete(w, REHEARSAL_PREFIX, 'rehearsal.json', manifest, runId)

      // NON-VACUITY, FIRST. This is a REAL published-shaped bundle: it VERIFIES
      // on disk and carries the manifest under the expected name. Were this to
      // fail, the refusal below would prove nothing about completeness.
      const files = verifyPublishedEvidence(dir)
      expect(files, label).toContain('rehearsal.json')
      expect(files, label).toContain('DIGEST')

      // AND THE RECORD IS THE EXPECTED ONE, so the refusal cannot be the record
      // check firing instead.
      expect(manifestOf(dir, 'rehearsal.json').record, label).toBe(REHEARSAL_PREFIX)

      // THE REFUSAL, AND SPECIFICALLY THIS ONE.
      expect(() => verifyReferencedBundle(dir, REHEARSAL_PREFIX, 'rehearsal.json'), label)
        .toThrow(/a referenced bundle is not complete/)
    }

    // NON-VACUITY, THE OTHER DIRECTION: the identical hand-built tree with
    // `complete: true` is ACCEPTED, so the three refusals above turn on that one
    // field and on nothing about how the tree was assembled.
    const good = forgeIncomplete(w, REHEARSAL_PREFIX, 'rehearsal.json',
                                 { record: REHEARSAL_PREFIX, complete: true,
                                   outcome: REHEARSAL_OUTCOME }, 'd0000004')
    expect(verifyPublishedEvidence(good)).toContain('rehearsal.json')
    expect(() => verifyReferencedBundle(good, REHEARSAL_PREFIX, 'rehearsal.json'))
      .not.toThrow()
  })

  it('refuses a rehearsal that does not record a proved release', async () => {
    // K1.1-K37, without editing anything. A published bundle whose DIGEST
    // covers its own bytes, complete, the right record - and its fence_state
    // says the rehearsal did not finish. The DIGEST cannot catch that; only
    // reading the field can.
    const w = await ready()
    await rehearseAndRestore(w)
    const restoration = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    for (const state of ['held', 'unproved', 'release-unknown', 'released-unproved']) {
      const dir = forge(w, REHEARSAL_PREFIX, 'rehearsal.json', {
        record: REHEARSAL_PREFIX, complete: true, outcome: REHEARSAL_OUTCOME,
        operational_adapter_binding_digest: 'a'.repeat(64),
        fence_state: state,
      }, `c${state.length.toString(16).padStart(7, '0')}`)
      expect(() => verifyRehearsalChain(dir, restoration), state)
        .toThrow(/does not record a proved release/)
    }
  })

  it('refuses two real bundles whose recorded bindings differ', async () => {
    // K1.1-K38. Both verify, both are the record they claim, both are complete
    // - and they describe two different worlds.
    const w = await ready()
    await rehearseAndRestore(w)
    const rehearsalDir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    const real = manifestOf(rehearsalDir, 'rehearsal.json')
    const restoration = forge(w, RESTORATION_PREFIX, 'restoration.json', {
      record: RESTORATION_PREFIX, complete: true, outcome: 'RESTORED',
      // THE ONE FIELD THAT DIFFERS.
      operational_adapter_binding_digest: 'b'.repeat(64),
      operational_rehearsal: {
        name: basename(rehearsalDir),
        digest_file_digest: fileDigestOf(rehearsalDir),
      },
    }, 'dddddddd')
    expect(real.operational_adapter_binding_digest).not.toBe('b'.repeat(64))
    expect(() => verifyRehearsalChain(rehearsalDir, restoration))
      .toThrow(/do not agree about the operational binding/)
  })

  it('refuses a bundle whose RECORD field is not what it is used as', async () => {
    // The manifest filename and the `record` field are two independent claims
    // about what a bundle is, and only the second is inside the frozen document
    // the DIGEST covers. Checking the filename alone would accept any bundle
    // that happened to publish under that name.
    const w = await ready()
    await rehearseAndRestore(w)
    const wrong = forge(w, REHEARSAL_PREFIX, 'rehearsal.json', {
      record: 'something-else', complete: true, outcome: REHEARSAL_OUTCOME,
      fence_state: 'released', operational_adapter_binding_digest: 'a'.repeat(64),
    }, 'aaaaaaa1')
    expect(() => verifyReferencedBundle(wrong, REHEARSAL_PREFIX, 'rehearsal.json'))
      .toThrow(/not the expected record/)
    expect(() => verifyRehearsalChain(
      wrong, join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)))
      .toThrow(/not the expected record/)
  })

  it('refuses a restoration that closes a different rehearsal', async () => {
    const w = await ready()
    await rehearseAndRestore(w)
    const rehearsalDir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    const binding = manifestOf(rehearsalDir, 'rehearsal.json')
      .operational_adapter_binding_digest as string
    const restoration = forge(w, RESTORATION_PREFIX, 'restoration.json', {
      record: RESTORATION_PREFIX, complete: true, outcome: 'RESTORED',
      operational_adapter_binding_digest: binding,
      // THE RIGHT BINDING, THE WRONG REHEARSAL.
      operational_rehearsal: { name: 'operational-rehearsal-20260101T000000Z-ffffffff',
                               digest_file_digest: 'f'.repeat(64) },
    }, 'eeeeeeee')
    expect(() => verifyRehearsalChain(rehearsalDir, restoration))
      .toThrow(/closes a different rehearsal/)
  })

  it('reproves the destinations against the rehearsal\'s OWN fenced census',
    async () => {
      // K1.1-K34. Comparing the current measurement with `i.binding` - which
      // was re-derived from that same measurement moments earlier - compares a
      // value with itself and passes whatever the producers did. The rehearsal's
      // release-gate record is an independent source: bytes on disk, covered by
      // a DIGEST, written while the source was frozen.
      const w = await ready()
      await rehearseAndRestore(w)
      const census = readFencedCensus(join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`))
      expect(census.length).toBe(REVIEWED_PRODUCERS.length)
      expect(census.some(p => p.disposition === 'writes-copy-source')).toBe(true)
      const src = strip(readFileSync(
        new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
      const fn = src.slice(src.indexOf('export async function runVerifyRestoration'))
      expect(fn).toContain('compareProducerSets(recorded, now)')
      expect(fn).not.toContain('compareProducerSets(i.binding.producers')
    })
})

// ---------------------------------------------------------------------------
// K1.2: THE TERMINAL HOLD, THE LIVE BINDING, AND RESTORATION CLOSURE
// ---------------------------------------------------------------------------

describe('an unresolved intervention cannot return', () => {
  it('keeps asking, and keeps holding, until the fence is terminally resolved',
    async () => {
      // K1.2-1. The old hold performed ONE operation and returned exit 4 when
      // it did not resolve - and returning is what releases the fence, because
      // the process then exits and the psql child dies with it. So the loop is
      // the property: three unresolving attempts, no return, and the
      // supervisor still open the whole time.
      // CONTAINED. THE CENSUS FINDS THE BACKEND ALIVE HOLDING A PARTIAL LOCK SET
      // for the first three attempts - neither a complete fence nor zero locks -
      // and proves the locks gone on the fourth.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 3 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      })
      const evidence = evidenceOf(r)

      expect(r.report.requests.length).toBe(4)
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      // NEVER EXIT 4 FOR AN UNRESOLVED FENCE.
      expect(r.report.exitCode).not.toBe(EXIT_ACTION_REQUIRED)
      // THE SUPERVISOR WAS STILL OPEN AT EVERY SINGLE PROMPT. Closing it is what
      // would release the fence.
      for (const [n, req] of r.report.requests.entries()) {
        expect(req.supervisorClosedSoFar, `attempt ${n + 1}`).toBe(0)
      }
      // AND IT WAS CLOSED EXACTLY ONCE, after the last attempt.
      expect(r.report.supervisorClosed).toBe(1)
      // THE FIRST THREE OUTCOMES ARE NON-TERMINAL AND SAY SO.
      const outcomes = allBundles(evidence, OUTCOME_PREFIX)
      expect(outcomes.length).toBe(4)
      for (const name of outcomes.slice(0, 3)) {
        const m = manifestOf(join(evidence, name), 'outcome.json')
        expect(m.resolved, name).toBe(false)
        expect(m.terminal, name).toBe(false)
        // A PARTIAL LOCK SET IS NOT "RELEASED".
        expect(m.fence_state_after, name).toBe('unproved')
      }
      expect(manifestOf(join(evidence, outcomes[3] as string), 'outcome.json').terminal)
        .toBe(true)
    }, 180_000)

  it('holds its signal handlers armed across every failed attempt', async () => {
    // K1.2-2. Disarming after an attempt that resolved nothing hands the
    // terminal back the power to end a process that is holding a fence.
    // CONTAINED.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 2 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    })
    expect(r.report.requests.length).toBe(3)
    for (const [n, req] of r.report.requests.entries()) {
      // ARMED BEFORE THE FIRST PROMPT, AND NOT YET DISARMED AT ANY PROMPT.
      //
      // K8-E5: two `arm` CALLS, not one - the rehearsal's own, taken before
      // `acquire` so a fence is never held unarmed, and the hold's, which only
      // replaces the sentence. The property this case exists for is the second
      // assertion: nothing is disarmed while an attempt has resolved nothing,
      // because disarming there hands the terminal back the power to end a
      // process that is holding a fence.
      expect(req.armedSoFar, `attempt ${n + 1}`).toBe(2)
      expect(req.disarmedSoFar, `attempt ${n + 1}`).toBe(0)
    }
    // AND DISARMED ONLY AT THE END. Both closures release the one lease, and the
    // lease itself is idempotent (pg-copy-ops.ts `arm`), so what matters is that
    // no disarm happened before the hold ended - asserted at every prompt above.
    expect(r.report.armed).toBe(2)
    // EXACTLY TWO, for the reason given at the other re-pinned case: two `arm`
    // calls, each returning its own counting closure, each called once in a
    // `finally` (pg-copy-ops.ts:2137 and :3426).
    expect(r.report.disarmed).toBe(2)

    // THE SOURCE SAYS SO TOO: the disarm lives in the `finally` of the loop,
    // not inside it.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function holdForIntervention'),
                         src.indexOf('function attemptRunId'))
    expect(fn.indexOf('for (;;)')).toBeLessThan(fn.indexOf('disarm()'))
    expect(fn).toContain('} finally {')
  }, 180_000)

  it('gives every attempt a distinct immutable bundle name', async () => {
    // K1.2-3. Published evidence claims its final name with an atomic
    // no-replace rename. A second attempt reusing this run's stamp and run id
    // would collide on its own first record, and the COLLISION - not the
    // attempt - is what would be written down.
    // CONTAINED.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 2 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    })
    const evidence = evidenceOf(r)
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    const intents = allBundles(evidence, INTENT_PREFIX)
    const outcomes = allBundles(evidence, OUTCOME_PREFIX)
    expect(intents.length).toBe(3)
    expect(outcomes.length).toBe(3)
    // DISTINCT NAMES, and every one of them verifies from disk.
    expect(new Set([...intents, ...outcomes]).size).toBe(6)
    for (const name of [...intents, ...outcomes]) {
      expect(verifyPublishedEvidence(join(evidence, name)).length).toBeGreaterThan(0)
    }
    // AND EACH ATTEMPT IS NUMBERED, in order.
    expect(intents.map(n => manifestOf(join(evidence, n), 'intent.json').attempt).sort())
      .toEqual([1, 2, 3])
  }, 180_000)
})

describe('the release census counts locks', () => {
  it('does not call a partial lock set released', async () => {
    // K1.2-10. "Does not hold a COMPLETE fence" is true of a backend holding
    // twenty-four of its twenty-five reviewed locks. Those tables are still
    // unwritable, and reporting that as not-held invites the conclusion that
    // the source is free.
    const fence = {
      supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' as const,
    }
    const at = async (count: string | null, locks?: string[][]): Promise<CensusResult> => {
      const base = proverStub(locks === undefined ? {} : { locks })
      const original = base.send
      return await censusFromProver(fenceStub({
        send: async (sql: string) => {
          if (sql.includes('pg_catalog.count(*)')) {
            if (count === null) return { rows: [], error: 'statement-refused' as const }
            return { rows: [[count]], error: null }
          }
          return await original(sql)
        },
        close: () => base.close(),
      }), fence)
    }
    expect((await at('0')).census).toBe('zero-locks-proved')
    expect((await at('0')).state).toBe('released')
    expect((await at('1')).census).toBe('partial-locks-held')
    expect((await at('1')).state).toBe('unproved')
    expect((await at('24')).census).toBe('partial-locks-held')
    expect((await at('24')).state).toBe('unproved')
    expect((await at('25')).census).toBe('complete-fence-held')
    expect((await at('25')).state).toBe('held')
    expect((await at(null)).census).toBe('census-unavailable')
    // AND EVERY PARTIAL COUNT CARRIES THE NUMBER, so the record says how much.
    expect((await at('24')).reviewedLocks).toBe(24)
  })

  it('distinguishes a gone backend from a reused pid from an unavailable census',
    async () => {
      const fence = {
        supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' as const,
      }
      expect((await censusFromProver(goneProver(), fence)).census).toBe('supervisor-gone')
      const reused = proverStub({ observedStart: '2026-09-25 12:00:00+00' })
      expect((await censusFromProver(reused, fence)).census).toBe('pid-reused')
      const dead = fenceStub({ send: async () => { throw new Error('gone') } })
      expect((await censusFromProver(dead, fence)).census).toBe('census-unavailable')
      // AND ONLY THE FIRST TWO RESOLVE A HOLD.
      expect((await censusFromProver(goneProver(), fence)).state).toBe('released')
      expect((await censusFromProver(reused, fence)).state).toBe('released')
      expect((await censusFromProver(dead, fence)).state).toBe('release-unknown')
    })

  it('asks a PID-parameterized census, not the supervisor about itself', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function censusFromProver'),
                         src.indexOf('export async function performHoldOperation'))
    expect(fn).toContain('releasedLockCensusSqlFor(fence.supervisorPid)')
    // NOTHING IS SENT TO THE SUPERVISOR from a census.
    expect(fn).not.toContain('supervisor.send')
    expect(fn).toContain('COMPLETE_FENCE_LOCKS')
  })
})

describe('restoration proves the queues are empty', () => {
  const rehearse = async (w: World): Promise<void> => {
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
  }

  it('refuses a queue with work in it', async () => {
    // K1.2-6. Checking that the names appear would accept two queues with a
    // thousand jobs waiting in each - which is the state the restoration
    // exists to rule out.
    const w = await ready()
    await rehearse(w)
    const r = await runOpsCli(restoreArgs(w), deps(w, {
      queue: {
        sample: async () => ({ depths: { 'daily-pipeline': 3, 'structured-ingestion': 0 } }),
      },
    }))
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(r.lines.join('\n')).toMatch(/daily-pipeline is not empty/)
  })

  it('refuses a paused queue and a depth that is not a count', async () => {
    // K1.2-7. The adapter signals a paused queue as a negative depth rather
    // than by omitting it - an omission would look like a set problem and send
    // the operator to the wrong question.
    // A FRESH WORLD PER CASE. Published bundle names are immutable and are
    // claimed with an atomic no-replace rename, so a second restoration in the
    // same world under the same run id collides on its own record - and the
    // collision would be what the assertion saw.
    for (const depths of [
      { 'daily-pipeline': -1, 'structured-ingestion': 0 },
      { 'daily-pipeline': 1.5, 'structured-ingestion': 0 },
      { 'daily-pipeline': Number.NaN, 'structured-ingestion': 0 },
      // NEGATIVE ZERO. `-0 !== 0` is FALSE, so the emptiness test alone waves
      // it through - and a negative zero arriving from a depth calculation
      // means an arithmetic error nobody has looked at.
      { 'daily-pipeline': -0, 'structured-ingestion': 0 },
    ]) {
      const w = await ready()
      await rehearse(w)
      const r = await runOpsCli(restoreArgs(w), deps(w, {
        queue: { sample: async () => ({ depths }) },
      }))
      expect(r.exitCode, JSON.stringify(depths)).toBe(EXIT_ACTION_REQUIRED)
    }
    // AND THE BLOCKING POLICY INCLUDES waiting-children.
    expect([...BLOCKING_STATES]).toContain('waiting-children')
    expect(PAUSED_IS_BLOCKING).toBe(true)
  })

  it('takes two interval-separated samples, not one instant', async () => {
    // K1.2-C. One observation says the queues were empty when it was taken;
    // the pair says they were still empty afterwards.
    const w = await ready()
    await rehearse(w)
    let samples = 0
    const waited: number[] = []
    const r = await runOpsCli(restoreArgs(w), deps(w, {
      queue: {
        sample: async () => {
          samples += 1
          // WORK ARRIVES BETWEEN THE TWO. A single sample would have passed.
          return {
            depths: {
              'daily-pipeline': samples === 1 ? 0 : 2,
              'structured-ingestion': 0,
            },
          }
        },
      },
      sleep: async (ms: number) => { waited.push(ms) },
    }))
    expect(samples).toBe(2)
    expect(waited).toContain(QUEUE_SAMPLE_INTERVAL_MS)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(r.lines.join('\n')).toMatch(/not empty/)
  })
})

describe('the copy binding is measured', () => {
  async function chain(w: World): Promise<string[]> {
    await rehearseAndRestore(w)
    expect((await runOpsCli(reviewArgs(w), deps(w))).exitCode).toBe(EXIT_OK)
    return [
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    ]
  }

  it('takes no target identity or provenance from the command line', async () => {
    // K1.2-8. Every "which target" field used to come from argv, and the token
    // was then computed from them - so a wrong target produced a token that
    // matched the wrong target, perfectly.
    for (const option of ['--target-system-identifier', '--target-endpoint',
                          '--target-role', '--provenance-head', '--ingestion-gitlink']) {
      expect([...OPTIONS], option).not.toContain(option)
      expect(() => parseArgs(['--inspect', `${option}=x`]), option)
        .toThrow(/unknown option/)
    }
    // WHAT REMAINS ARE SELECTORS: where to look, never what will be found.
    expect([...OPTIONS]).toContain('--bundle-dir')
    expect([...OPTIONS]).toContain('--checkout')
    expect([...OPTIONS]).toContain('--target-host')
  })

  it('binds what the SESSIONS report, not what the caller wanted', async () => {
    const w = await ready()
    const common = await chain(w)
    const bundleDir = stage1Bundle(w)
    expect(common.length).toBeGreaterThan(0)
    const run = async (over: Partial<OpsDeps>): Promise<string> =>
      (await bindingOf(w, bundleDir, over)).digest
    const asMeasured = await run({})
    expect(asMeasured).toMatch(/^[0-9a-f]{64}$/)

    // A DIFFERENT TARGET CLUSTER PRODUCES A DIFFERENT BINDING, because the
    // binding is what the target session said it was.
    const otherCluster = await run({
      openTargetIdentity: async () => targetIdentity({ 0: '7689229024919775000' }),
    })
    expect(otherCluster).not.toBe(asMeasured)

    // A PROVENANCE THE BUNDLE DOES NOT RECORD IS REFUSED, not bound.
    //
    // THIS ASSERTION USED TO PASS VACUOUSLY. Driven through the retired
    // inspection, the mismatch refused, `lines.find('copy binding ')` returned
    // `undefined`, and `expect(undefined).not.toBe(<digest>)` held - so the
    // test claimed "a different provenance yields a different binding" while
    // actually observing a refusal and no binding at all. Calling the binding
    // directly makes the real behaviour visible, and the real behaviour is
    // stricter than the test used to describe.
    await expect(bindingOf(w, bundleDir, {
      measureRepository: async () => ({ head: 'a'.repeat(40), ingestionGitlink: '1'.repeat(40) }),
    })).rejects.toThrow(/checkout is not the one the Stage-1 bundle records/)
  })

  it('refuses when the live source is not the one the bundle describes', async () => {
    const w = await ready()
    const common = await chain(w)
    const bundleDir = stage1Bundle(w)
    expect(common.length).toBeGreaterThan(0)
    // REFUSES BY THROWING, now that it is called directly rather than through
    // a mode that turned the refusal into an exit code and a printed line.
    await expect(bindingOf(w, bundleDir, {
      openSourceIdentity: async () => sourceIdentity({ 1: 'somewhere_else' }),
    })).rejects.toThrow(/not the one the Stage-1 bundle describes/)
  })

  it('refuses when a measurement is unavailable, and mints no token', async () => {
    const w = await ready()
    const common = await chain(w)
    const bundleDir = stage1Bundle(w)
    const cases: Array<[string, Partial<OpsDeps>]> = [
      ['no source session', { openSourceIdentity: undefined }],
      ['no target session', { openTargetIdentity: undefined }],
      ['source refuses', {
        openSourceIdentity: async () => fenceStub({
          send: async () => ({ rows: [] as string[][], error: 'statement-refused' as const }),
        }),
      }],
      ['target answers short', {
        openTargetIdentity: async () => fenceStub({
          send: async () => ({ rows: [['1']] as string[][], error: null }),
        }),
      }],
      ['repository unreadable', {
        measureRepository: async () => { throw new OpsRefused('the repository could not be read') },
      }],
    ]
    for (const [label, over] of cases) {
      const r = await runOpsCli(base(w, [
        '--for=apply', '--inspect', ...common, ...applyScope(bundleDir),
      ]), deps(w, over))
      expect(r.exitCode, label).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n'), label).not.toContain('PGCOPY-APPLY-')
    }
  })
})

describe('the release-gate reference is bound by digest', () => {
  it('refuses a gate bundle that is not the one the rehearsal recorded',
    async () => {
      // K1.2-11. The rehearsal records the gate by basename AND by the SHA-256
      // of that bundle's DIGEST file. Reading only the name would follow a
      // gate republished under the same name - the exact substitution the
      // second field exists to detect.
      const w = await ready()
      await rehearseAndRestore(w)
      const rehearsalDir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
      expect(readFencedCensus(rehearsalDir).length).toBe(REVIEWED_PRODUCERS.length)

      // SUBSTITUTE THE GATE'S CONTENTS. It still verifies as a bundle; what it
      // no longer is, is the bundle the rehearsal pointed at.
      const gateDir = join(w.evidence, `${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`)
      const digestFile = join(gateDir, 'DIGEST')
      execFileSync('/bin/chmod', ['u+w', gateDir])
      execFileSync('/bin/chmod', ['u+w', digestFile])
      writeFileSync(digestFile, `${readFileSync(digestFile, 'utf-8')}\n`)
      expect(() => readFencedCensus(rehearsalDir)).toThrow()
    })

  it('refuses a reference that is not a basename or not a reviewed name', () => {
    const manifest = (name: unknown): Record<string, never> => ({
      release_gate_bundle: { name, digest_file_digest: 'a'.repeat(64) },
    } as unknown as Record<string, never>)
    for (const name of ['../elsewhere', '/absolute/path', 'sub/dir', '.', '..',
                        'not-a-reviewed-name']) {
      expect(() => verifyGateLink('/tmp/whatever', manifest(name)), String(name))
        .toThrow(/basename|reviewed bundle name/)
    }
    // AND A MISSING DIGEST IS A REFUSAL, not a name-only check.
    expect(() => verifyGateLink('/tmp/whatever', {
      release_gate_bundle: { name: `${RELEASE_GATE_PREFIX}-20260925T101500Z-a1b2c3d4` },
    } as unknown as Record<string, never>)).toThrow(/names no release-gate record/)
  })

  it('refuses a gate bundle from another run, and validates the census shape',
    async () => {
      const a = await ready()
      await rehearseAndRestore(a)
      const rehearsalDir = join(a.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
      const manifest = manifestOf(rehearsalDir, 'rehearsal.json')
      // THE REAL LINK VERIFIES, and carries a structurally checked census.
      const link = verifyGateLink(rehearsalDir, manifest as never)
      expect(link.producers.length).toBe(REVIEWED_PRODUCERS.length)
      expect(link.digestFileDigest).toMatch(/^[0-9a-f]{64}$/)
      // AND THE APPLY CHAIN FOLLOWS THE SAME LINK.
      const src = strip(readFileSync(
        new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
      const chainFn = src.slice(src.indexOf('export function verifyRehearsalChain'))
      expect(chainFn.slice(0, chainFn.indexOf('return Object.freeze')))
        .toContain('verifyGateLink(rehearsalPath, rehearsal)')
    })
})

describe('PGPASSFILE is proved, never read', () => {
  it('validates metadata only and issues no read', () => {
    // K1.2-12. `openReviewedContainer` RETURNS THE BYTES. Calling it on
    // PGPASSFILE put the password in this process's memory while a comment
    // claimed the contents were not read. `psql` reads the file during
    // authentication - that is its job, and the reason the PATH is what
    // travels.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function openReviewedFileDescriptor'),
                         src.indexOf('export function openReviewedPlist'))
    expect(fn).toContain('fstatSync(fd')
    expect(fn).toContain('O_NOFOLLOW')
    expect(fn).toContain('realpathSync(path)')
    expect(fn).not.toContain('readFileSync')
    expect(fn).not.toContain('readSync')

    const bin = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const open = bin.slice(bin.indexOf('export async function openProductionSession'),
                           bin.indexOf('export function productionDeps'))
    // THE DESCRIPTOR IS PINNED ACROSS THE SPAWN, and closed only afterwards.
    expect(open).toContain('openReviewedFileDescriptor(passfile)')
    expect(open).toContain('passfileFd: held.fd')
    expect(open).toContain('held.close()')
    expect(open).not.toContain('openReviewedContainer')
  })

  it('proves the same identity checks a credential gets', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(d)
    const good = join(d, 'pgpass')
    writeFileSync(good, 'localhost:5432:ai_capital:me:secret\n')
    chmodSync(good, 0o600)
    const id = proveReviewedFileMetadata(good)
    expect(id.mode).toBe('600')
    expect(id.links).toBe(1)
    expect(id.deviceInode).toMatch(/^\d+:\d+$/)
    // AND THE SECRET IS NOWHERE IN WHAT COMES BACK.
    expect(JSON.stringify(id)).not.toContain('secret')

    const wide = join(d, 'wide')
    writeFileSync(wide, 'x')
    chmodSync(wide, 0o644)
    expect(() => proveReviewedFileMetadata(wide)).toThrow(/not mode 0600/)
    const linked = join(d, 'linked')
    writeFileSync(linked, 'x')
    chmodSync(linked, 0o600)
    execFileSync('/bin/ln', [linked, join(d, 'second')])
    expect(() => proveReviewedFileMetadata(linked)).toThrow(/more than one link/)
    const viaLink = join(d, 'via')
    symlinkSync(good, viaLink)
    expect(() => proveReviewedFileMetadata(viaLink)).toThrow(/does not resolve to itself/)
  })
})

describe('the structured worker is measured, not restated', () => {
  it('detects drift from a fresh measurement', async () => {
    // K1.2-13. The old check compared the binding's copy of this field with
    // the same binding - it held whatever the world happened to be and passed
    // for any state at all.
    const w = await ready()
    await rehearseAndRestore(w)
    const m = manifestOf(join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`),
                         'restoration.json')
    const sw = m.structured_worker as { expected: string; actual: string; verdict: string }
    expect(sw.expected).toBe('expected-absent')
    expect(sw.actual).toBe('expected-absent')
    expect(sw.verdict).toBe('as-reviewed')

    // NOW INSTALL IT. The reviewed policy still says expected-absent, and a
    // FRESH measurement is what notices.
    const label = REVIEWED_PRODUCERS.find(l => l.endsWith('.structured-worker')) as string
    const r = await runOpsCli(restoreArgs(w), deps(w, {
      commands: {
        openPlist: w.commands.openPlist,
        run: async (file, args, ctx) => {
          if (args[0] === 'print' && args[1] === `gui/501/${label}`) {
            const other = REVIEWED_PRODUCERS[0] as string
            return await w.commands.run(file, ['print', `gui/501/${other}`], ctx)
          }
          return await w.commands.run(file, args, ctx)
        },
      },
    }))
    expect(r.exitCode).not.toBe(EXIT_OK)
    expect(r.lines.join('\n')).toMatch(/structured worker|declared installation topology/)
  })
})

describe('the hold is a hold, not a spin, and never exits 4', () => {
  it('pauses between attempts', async () => {
    // K1.2-L09. Without a pause a resolution channel that is simply
    // unavailable - no terminal, an unreadable file - would be re-consulted as
    // fast as the event loop allows, burning a core while holding a fence.
    // CONTAINED.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 2 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      recordSleeps: true,
    })
    expect(r.report.requests.length).toBe(3)
    // TWO PAUSES FOR THREE ATTEMPTS, at the reviewed interval.
    expect(r.report.sleeps.filter(ms => ms === HOLD_RETRY_INTERVAL_MS).length).toBe(2)
    expect(HOLD_RETRY_INTERVAL_MS).toBeGreaterThanOrEqual(1_000)
  }, 180_000)

  it('never names the producer-restoration exit inside the hold', () => {
    // K1.2-L02. Exit 4 is the ordinary state in which a run finished and the
    // producers are still down for a person to restore. An unresolved fence is
    // never that, and the loop cannot reach its return unresolved - so this is
    // the second of two defences, asserted because the first one's absence
    // would be invisible.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // THE FUNCTION ONLY. `publishIntervention` was replaced by
    // `publishDurable`, and an end anchor that no longer exists would slice to
    // the end of the file and find the constant somewhere else entirely.
    const fn = src.slice(src.indexOf('export async function holdForIntervention'),
                         src.indexOf('function attemptRunId'))
    expect(fn.length).toBeGreaterThan(500)
    expect(fn).not.toContain('EXIT_ACTION_REQUIRED')
    expect(fn).toContain('EXIT_INTERVENTION_RESOLVED')
  })
})

describe('the gate link cannot be substituted', () => {
  /** Publish a VALID release-gate bundle whose CONTENT says something else. */
  function forgeGate(
    w: World, manifest: Record<string, unknown>, detail: Record<string, unknown>,
    runId: string,
  ): string {
    return publishEvidence({
      root: w.evidence, prefix: RELEASE_GATE_PREFIX, stamp: STAMP, runId,
      artifacts: [{ path: 'gate-detail.json',
                    bytes: Buffer.from(`${JSON.stringify(detail)}\n`, 'utf-8') }],
      manifest: { path: 'release-gate.json',
                  bytes: Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf-8') },
    }).finalPath
  }

  /** A rehearsal manifest pointing at a named gate with a stated digest. */
  const FENCE = {
    supervisor_pid: SUPERVISOR_PID, backend_start: BACKEND_START,
    mechanism: 'S3', proving_pid: PROVING_PID, reviewed_relations: 24,
  }

  const pointingAt = (name: string, digest: string, over: Record<string, unknown> = {}):
    Record<string, never> => ({
      record: REHEARSAL_PREFIX, complete: true, outcome: REHEARSAL_OUTCOME,
      fence_state: 'released',
      operational_adapter_binding_digest: 'a'.repeat(64),
      run: { id: RUN_ID, stamp: STAMP },
      released_fence: { ...FENCE },
      release_gate_bundle: { name, digest_file_digest: digest },
      ...over,
    } as unknown as Record<string, never>)

  const CENSUS = (over: Record<string, unknown> = {}): Array<Record<string, unknown>> =>
    REVIEWED_PRODUCERS.map(label => ({
      label, installation: 'installed-loaded', stableInstallation: 'installed',
      disposition: 'writes-copy-source',
      plistPath: '/a', plistSha256: 'b', plistDeviceInode: '1:2', servedCheckout: '/c',
      credentialPath: '/d', credentialDeviceInode: '3:4',
      databaseHost: '/tmp/s', databasePort: '5432', databaseName: 'ai_capital',
      ...over,
    }))

  it('refuses a gate whose DIGEST is not the recorded one', async () => {
    // K1.2-L29. A gate bundle republished under the same name would be
    // followed happily by a check that read only the name.
    const w = await ready()
    const gateDir = forgeGate(w, {
      record: RELEASE_GATE_PREFIX, complete: true,
      operational_adapter_binding_digest: 'a'.repeat(64),
      run: { id: RUN_ID, stamp: STAMP },
      fenced_backend: { ...FENCE },
    }, { fenced_producers: CENSUS() }, 'aaaa0001')
    const real = fileDigestOf(gateDir)
    // THE TRUTHFUL REFERENCE VERIFIES.
    expect(() => verifyGateLink(join(w.evidence, 'x'),
                                pointingAt(basename(gateDir), real))).not.toThrow()
    // A DIFFERENT DIGEST FOR THE SAME NAME DOES NOT.
    expect(() => verifyGateLink(join(w.evidence, 'x'),
                                pointingAt(basename(gateDir), 'f'.repeat(64))))
      .toThrow(/not the one the rehearsal recorded/)
  })

  it('refuses a reference that escapes the evidence directory', async () => {
    // K1.2-L30. Basename only: a value carrying a separator or a traversal
    // segment is refused rather than joined.
    const w = await ready()
    const gateDir = forgeGate(w, {
      record: RELEASE_GATE_PREFIX, complete: true,
      operational_adapter_binding_digest: 'a'.repeat(64),
      run: { id: RUN_ID, stamp: STAMP },
      fenced_backend: { ...FENCE },
    }, { fenced_producers: CENSUS() }, 'aaaa0002')
    const real = fileDigestOf(gateDir)
    for (const name of [`../${basename(gateDir)}`, `./${basename(gateDir)}`,
                        `${w.evidence}/${basename(gateDir)}`, '.', '..']) {
      expect(() => verifyGateLink(join(w.evidence, 'x'), pointingAt(name, real)), name)
        .toThrow(/basename|reviewed bundle name/)
    }
    // TWO CHECKS, AND EITHER ALONE WOULD CATCH THESE. The basename rule is
    // stated for what it says - a reference is a name inside one directory -
    // and the reviewed-name pattern happens to exclude every separator as
    // well. Both are asserted, so removing either is visible.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function verifyGateLink'),
                         src.indexOf('export async function proveDestinationsFor')
                         + 1 || undefined)
    expect(fn).toContain('gate.name !== basename(gate.name)')
    expect(fn).toContain('RELEASE_GATE_PREFIX}-')
  })

  it('refuses a gate from another run or another world', async () => {
    // K1.2-L32. A gate from another run of the same command verifies, carries
    // the right record name, and describes a different fence entirely.
    const w = await ready()
    const other = forgeGate(w, {
      record: RELEASE_GATE_PREFIX, complete: true,
      operational_adapter_binding_digest: 'a'.repeat(64),
      // THE SAME WORLD, A DIFFERENT RUN.
      run: { id: 'ffffffff', stamp: STAMP },
      fenced_backend: { ...FENCE },
    }, { fenced_producers: CENSUS() }, 'aaaa0003')
    expect(() => verifyGateLink(join(w.evidence, 'x'),
                                pointingAt(basename(other), fileDigestOf(other))))
      .toThrow(/belongs to a different run/)

    const elsewhere = forgeGate(w, {
      record: RELEASE_GATE_PREFIX, complete: true,
      // THE SAME RUN, A DIFFERENT WORLD.
      operational_adapter_binding_digest: 'b'.repeat(64),
      run: { id: RUN_ID, stamp: STAMP },
      fenced_backend: { ...FENCE },
    }, { fenced_producers: CENSUS() }, 'aaaa0004')
    expect(() => verifyGateLink(join(w.evidence, 'x'),
                                pointingAt(basename(elsewhere), fileDigestOf(elsewhere))))
      .toThrow(/different operational binding/)
  })

  it('refuses a census whose rows are not the reviewed shape', async () => {
    // K1.2-L33. A census read back from disk is data. The comparison that
    // follows would silently pass on rows carrying none of the fields it
    // compares.
    const w = await ready()
    const cases: Array<[string, unknown]> = [
      ['not an array', { fenced_producers: 'all of them' }],
      ['wrong length', { fenced_producers: CENSUS().slice(1) }],
      ['wrong order', { fenced_producers: [...CENSUS()].reverse() }],
      ['missing installation', {
        fenced_producers: CENSUS().map((r, n) => n === 0
          ? { ...r, installation: undefined } : r),
      }],
      ['non-string field', {
        fenced_producers: CENSUS().map((r, n) => n === 2 ? { ...r, plistSha256: 42 } : r),
      }],
    ]
    let seq = 100
    for (const [label, detail] of cases) {
      seq += 1
      const dir = forgeGate(w, {
        record: RELEASE_GATE_PREFIX, complete: true,
        operational_adapter_binding_digest: 'a'.repeat(64),
        run: { id: RUN_ID, stamp: STAMP },
        fenced_backend: { ...FENCE },
      }, detail as Record<string, unknown>, `aaaa0${seq}`)
      expect(() => verifyGateLink(join(w.evidence, 'x'),
                                  pointingAt(basename(dir), fileDigestOf(dir))), label)
        .toThrow(/census/)
    }
  })
})

describe('the copy binding binds every measured field', () => {
  it('changes when ANY measured identity field changes', async () => {
    // K1.2-L17. A binding that hardcoded one field would be unchanged by a
    // target whose database is different - and "which database" is the single
    // question an apply token most needs to answer.
    const w = await ready()
    const bundleDir = stage1Bundle(w)
    const digestFor = async (over: Partial<Record<number, string>>): Promise<string> =>
      (await bindingOf(w, bundleDir, {
        openTargetIdentity: async () => targetIdentity(over),
      })).digest
    const baseline = await digestFor({})
    // ONE FIELD AT A TIME. Every one of them must move the digest.
    expect(await digestFor({ 0: '7689229024919775000' })).not.toBe(baseline)
    expect(await digestFor({ 1: 'ai_capital_v4' })).not.toBe(baseline)
    // CURRENT_USER and SESSION_USER are separate facts and both are bound -
    // and since K8-B1 both must ALSO equal the reviewed copy login, so a
    // perturbed role is now a REFUSAL rather than a different binding. That is
    // the stronger property: a credential naming another valid login can no
    // longer define the binding it is then checked against.
    await expect(digestFor({ 2: 'someone_else' }))
      .rejects.toThrow(/not authenticated as the reviewed copy login/)
    await expect(digestFor({ 3: 'someone_else' }))
      .rejects.toThrow(/authenticated as another login/)
    expect(await digestFor({ 4: '5434' })).not.toBe(baseline)
    // A TCP SESSION: an address AND a transport flag, which must agree.
    expect(await digestFor({ 5: '127.0.0.1', 6: 'false' })).not.toBe(baseline)
  })
})

describe('the structured worker comes back to the state the rehearsal recorded', () => {
  it('compares a FRESH measurement with the rehearsal record, not with itself',
    async () => {
      // K1.2-13 / L38 / L39. The old check read `structuredWorkerInstallation`
      // out of the binding and compared it with the same binding's producer
      // record - it held whatever the world happened to be and passed for any
      // state at all. The rehearsal's release-gate census is an independent
      // source: bytes on disk, covered by a DIGEST, written while the source
      // was frozen.
      const w = await ready()
      await rehearseAndRestore(w)
      const m = manifestOf(join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`),
                           'restoration.json')
      const sw = m.structured_worker as {
        label: string; expected: string; actual: string; verdict: string
      }
      expect(sw.label).toBe('com.thanapol.ai-capital.structured-worker')
      expect(sw.expected).toBe('expected-absent')
      expect(sw.actual).toBe('expected-absent')
      expect(sw.verdict).toBe('as-reviewed')

      // THE EXPECTED VALUE CAME FROM THE REHEARSAL, and the source says so.
      const src = strip(readFileSync(
        new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
      const fn = src.slice(src.indexOf('export async function runVerifyRestoration'))
      const block = fn.slice(fn.indexOf('const structuredLabel'), fn.indexOf('const failed'))
      expect(block).toContain('readFencedCensus(rehearsalDir)')
      expect(block).toContain('inspectLabel(structuredLabel')
      // NEITHER SIDE IS THE BINDING THIS RECORD ALSO CARRIES.
      expect(block).not.toContain('i.binding.structuredWorkerInstallation')
    })

  it('refuses when the rehearsal and the reviewed policy disagree about it',
    async () => {
      // Two independent statements about the same agent. If they differ, the
      // rehearsal was taken in a world the policy does not describe, and
      // neither can be used to judge what came back.
      const w = await ready()
      await rehearseAndRestore(w)
      const policy = JSON.parse(readFileSync(w.destinationPolicy, 'utf-8')) as {
        producers: Array<{ label: string; expected: string; installation: string }>
      }
      for (const e of policy.producers) {
        if (e.label.endsWith('.structured-worker')) e.installation = 'installed'
      }
      writeFileSync(w.destinationPolicy, JSON.stringify(policy))
      const r = await runOpsCli(restoreArgs(w), deps(w))
      // THE BINDING MOVES FIRST - the policy is pinned into it - which is the
      // stronger refusal. Either way the restoration does not pass.
      expect(r.exitCode).not.toBe(EXIT_OK)
    })
})

// ---------------------------------------------------------------------------
// K1.3: HOLD DURABILITY AND MEASUREMENT TRUTH
// ---------------------------------------------------------------------------

describe('evidence failure cannot escape a held intervention', () => {
  /** A world whose evidence root stops accepting new bundles part-way. */
  const brittle = async (failFrom: number): Promise<{
    w: World; deps: OpsDeps; published: () => number
  }> => {
    const w = await ready()
    let n = 0
    // THE ROOT IS MADE UNWRITABLE, which is what a full disk or a revoked
    // mount looks like to the publisher: every attempt to create a temporary
    // directory under it fails.
    const gate = (): void => {
      n += 1
      if (n === failFrom) chmodSync(w.evidence, 0o500)
      if (n === failFrom + 2) chmodSync(w.evidence, 0o700)
    }
    return { w, deps: deps(w), published: () => n, ...{ gate } } as never
  }
  void brittle

  it('an intent that will not publish holds, performs nothing, and asks nobody again',
    async () => {
      // K1.4-B06. An unpublishable intent is not a reason to act anyway and not
      // a reason to unwind - and, since K1.4, not a reason to go back to the
      // operator either. The PHASE retries the same frozen intent under the same
      // attempt identity; a transient failure must not increment the semantic
      // attempt, mint a new record, or request a second decision.
      //
      // CONTAINED, and the failure is injected precisely: the no-replace rename
      // of the INTENT prefix fails twice and then succeeds, the way a transient
      // I/O failure clears. A permission change could not do this - intent and
      // outcome are written into the same root, and which phase fails is the
      // whole question.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-intent', failures: 2 },
      })
      const evidence = evidenceOf(r)

      // IT DID NOT RETURN AFTER THE FAILED PUBLICATIONS.
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      expect(r.report.lines.join('\n')).toMatch(/could not be published|NOT on disk/)
      // AND IT ASKED EXACTLY ONCE AND PERFORMED EXACTLY ONCE. Three renames of
      // the intent for one decision and one operation.
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
      expect(r.report.renames).toBe(3)
      // NOTHING RAN BEFORE THE INTENT LANDED: the only `perform` in the record
      // came after the intent was on disk.
      const at = r.report.evidenceAtPerform[0] as readonly string[]
      expect(at.some(n => n.startsWith(`${INTENT_PREFIX}-`))).toBe(true)
      // ONE INTENT, ONE OUTCOME. Not one per failed publication.
      expect(bundles(evidence, INTENT_PREFIX).length).toBe(1)
      expect(bundles(evidence, OUTCOME_PREFIX).length).toBe(1)
    }, 180_000)

  it('an unpublishable outcome keeps holding and offers no further operation',
    async () => {
      // K1.3-A3. After an operation executes, no second database operation may
      // be offered until THAT attempt's outcome is durably on disk - otherwise
      // the evidence describes a sequence nobody performed.
      // CONTAINED, with the OUTCOME prefix's rename failing twice and then
      // succeeding.
      const r = await contained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: 2 },
      })
      const evidence = evidenceOf(r)
      // AN ATTEMPT WHOSE OUTCOME CANNOT LAND still ends in a hold, not a return -
      // and the run only finishes once one is durable.
      expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
      // NO FURTHER OPERATION, AND NO FURTHER DECISION. One of each, for three
      // publication attempts.
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
      expect(r.report.renames).toBe(3)
      expect(bundles(evidence, OUTCOME_PREFIX).length).toBe(1)
    }, 180_000)

  it('accepts an already-published record only when the bytes are identical',
    async () => {
      // K1.3-A5. An occupied destination means either this exact record
      // already landed - the previous attempt succeeded and its
      // acknowledgement was lost - or something else is using the name. The
      // first is success; the second is a collision that keeps the hold.
      const src = strip(readFileSync(
        new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
      const fn = src.slice(src.indexOf('async function publishDurable'),
                           src.indexOf('async function publishPhase'))
      expect(fn.length).toBeGreaterThan(400)
      // THE SAME BYTES EVERY TIME - and they were serialized ONCE, by the
      // caller, and are handed to the publisher as bytes rather than re-derived.
      expect(fn).toContain('manifest: frozen.manifest')
      expect(fn).toContain('manifestBytes: frozen.manifestBytes')
      expect(fn).toContain('detailBytes: frozen.detailBytes')
      expect(fn).toContain('PUBLICATION_ATTEMPTS')
      // AND AN OCCUPIED DESTINATION IS READ, NOT OVERWRITTEN.
      expect(fn).toContain("e.publication === 'destination-occupied'")
      expect(fn).toContain('acceptExistingRecord(')
      expect(fn).toContain('COLLISION')
      // A COLLISION AND A TRANSIENT FAILURE ARE DIFFERENT ANSWERS, because they
      // were once both `null` and that conflation is what let one be handled
      // like the other.
      expect(fn).toContain("kind: 'collision'")
      expect(fn).toContain("kind: 'unpublished'")
      // IT NEVER THROWS: the caller's contract is that nothing may unwind.
      const accept = src.slice(src.indexOf('function acceptExistingRecord'))
      const body = accept.slice(0, accept.indexOf('\n}'))
      expect(body).toContain('frozen.manifestBytes')
      expect(body).toContain('frozen.detailBytes')
      expect(body).toContain('return null')
    })

  it('turns every step that can fail into a held attempt', () => {
    // K1.3-A6. Minting a run id, asking the operator, performing, publishing
    // either record and pausing are each bounded - a throw from any of them
    // used to unwind through the outer `finally`, disarm the handlers and
    // release the fence by the act of reporting that it had not been released.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function holdForIntervention'),
                         src.indexOf('export function attemptRunId'))
    expect(fn.length).toBeGreaterThan(500)
    // THE RUN ID HAS A DETERMINISTIC FALLBACK.
    expect(fn).toContain('attemptRunId(i, attempt)')
    // THE DECISION AND THE OPERATION ARE EACH CAUGHT.
    expect((fn.match(/} catch \(e\) \{/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // THE PAUSE CANNOT END THE HOLD. Asserted on executable text: `strip`
    // removes comments, so the reason lives in the source and the guard is
    // what is checked here.
    expect(fn).toContain('const pause = async')
    expect(fn).toMatch(/try \{ await i\.sleep\(ms\) \} catch \{/)
    // AND NEITHER PUBLICATION IS OUTSIDE A GUARD: both go through the PHASE,
    // which retries the same frozen record and cannot throw.
    expect(fn).toContain('await publishPhase(')
    expect((fn.match(/await publishPhase\(/g) ?? []).length).toBe(2)
    expect(fn).not.toContain('publishLifecycleBundle(')
    expect(fn).not.toContain('await publishDurable(')
    // AND THE PHASE IS WHAT CANNOT FAIL, so there is no null to handle here.
    const phase = src.slice(src.indexOf('async function publishPhase'),
                            src.indexOf('export function acceptExistingRecord'))
    expect(phase.length).toBeGreaterThan(200)
    expect(phase).toContain('Promise<PriorBundle>')
    expect(phase).not.toContain('| null>')
  }, 180_000)

  it('names an attempt even when the minter fails', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('function attemptRunId'),
                         src.indexOf('export const PUBLICATION_ATTEMPTS'))
    expect(fn).toMatch(/\} catch \{/)
    expect(fn).toContain('if (/^[0-9a-f]{8}$/.test(minted)) return minted')
    expect(fn).toContain('attempt')
    // UNIQUE PER ATTEMPT, so two attempts never claim one name.
    expect(fn).toContain('createHash')
  })
})

describe('the real TTY survives more than one attempt', () => {
  it('reads one line per attempt from a persistent interface', async () => {
    // K1.3-B. An earlier revision iterated `process.stdin` and broke out after
    // the first newline, which closes the iterator and destroys the stream:
    // the FIRST resolution consumed the input channel and every later attempt
    // - the ones the loop exists to make - found nothing to read.
    //
    // THIS EXERCISES THE REAL IMPLEMENTATION. `processHold` is what production
    // uses; a mocked `decide` would prove nothing about it.
    const w = await ready()
    const real = new PassThrough()
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(real, { isTTY: true }), configurable: true,
    })
    try {
      const hold = processHold(() => undefined, w.evidence, null)
      const disarm = hold.arm('holding')
      const token = 'PGCOPY-RESOLVE-' + 'a'.repeat(64)
      // TWO LINES, WRITTEN UP FRONT. The first carries a wrong token and is
      // refused; the second is accepted - which is only possible if the
      // channel survived the first read.
      real.write(`CENSUS_ONLY operator PGCOPY-RESOLVE-${'b'.repeat(64)}\n`)
      real.write(`CENSUS_ONLY operator ${token}\n`)

      await expect(hold.decide('release-unknown', HOLD_ACTIONS['release-unknown'], token))
        .rejects.toThrow(/does not carry this run's token/)
      const second = await hold.decide(
        'release-unknown', HOLD_ACTIONS['release-unknown'], token)
      expect(second.action).toBe('CENSUS_ONLY')
      expect(second.operator).toBe('operator')

      // AND A THIRD ATTEMPT STILL HAS A CHANNEL.
      real.write(`ABANDON operator ${token}\n`)
      expect((await hold.decide(
        'release-unknown', HOLD_ACTIONS['release-unknown'], token)).action).toBe('ABANDON')

      disarm()
      // THE INTERFACE IS CLOSED ONCE, ON DISARM, and the stream is not destroyed
      // by the reads themselves.
      expect(real.destroyed).toBe(false)
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original)
    }
  })

  it('does not consume the channel with a break out of an iterator', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // K7-B: THE SAME PROPERTY, AT ITS NEW ADDRESS. The interface now lives in
    // `operatorChannel`, the transport `processHold` and the copy confirmation
    // share, so every assertion below moved with it rather than being dropped.
    const fn = src.slice(src.indexOf('export function operatorChannel'),
                         src.indexOf('export const COPY_CONFIRM_ACTION'))
    expect(fn).toContain('createInterface({ input: process.stdin')
    // ONE INTERFACE FOR THE WHOLE HOLD, created lazily and reused.
    expect(fn).toContain('if (lines === null)')
    expect(fn).toMatch(/lines as AsyncIterableIterator<string>\)\.next\(\)/)
    // NOT `for await (const c of process.stdin)` with a `break`.
    expect(fn).not.toContain('for await')
    expect(fn).not.toContain('chunks')
    // `rl.close()` exists in exactly one place - the transport's own `close`.
    expect(fn).toContain('rl.close()')
    // AND THE TRANSPORT'S DISARM NO LONGER CLOSES. K7-B needs a confirmation
    // that can disarm and then hand the SAME channel to an intervention hold,
    // so closing on disarm would destroy the only input the hold has.
    const armBody = fn.slice(fn.indexOf('arm(sentence: string)'),
                             fn.indexOf('async nextLine('))
    expect(armBody).toContain('for (const sig of HELD_SIGNALS) process.off')
    expect(armBody).not.toContain('channel.close()')
    // A HOLD, HOWEVER, OWNS THE CHANNEL FOR ITS WHOLE LIFE: its disarm removes
    // the handlers and THEN closes, in that order.
    const hold = src.slice(src.indexOf('export function processHold'),
                           src.indexOf('function readResolutionFile'))
    // K7-B6.1 PHASE E: IT BUILDS ITS OWN CHANNEL, OR ADOPTS ONE.
    //
    // The production apply hands over the channel it already preflighted,
    // because building a second one would re-run the TTY preflight while the
    // source fence is held. Still exactly one channel per hold, and still
    // never a raw readline interface of its own.
    expect(hold).toContain('existing ?? operatorChannel(say, root, resolutionFile)')
    expect(hold).not.toContain('createInterface(')
    expect(hold.indexOf('disarmHandlers()')).toBeLessThan(hold.indexOf('channel.close()'))
  })
})

describe('the operational binding is measured, not stated', () => {
  it('takes no source system identifier or implementation head from argv', () => {
    // K1.3-C. Both were forty-hex or decimal strings somebody pasted, recorded
    // as facts about the world and folded into every token.
    for (const option of ['--source-system-identifier', '--implementation-head']) {
      expect([...OPTIONS], option).not.toContain(option)
      expect(() => parseArgs(['--inspect', `${option}=x`]), option)
        .toThrow(/unknown option/)
    }
    expect([...OPTIONS]).toContain('--checkout')
    expect([...OPTIONS]).toContain('--source-host')
  })

  it('changes the binding when the measured source identity changes', async () => {
    const w = await ready()
    const digestFor = async (over: Partial<Record<number, string>>): Promise<string> => {
      const r = await runOpsCli(
        base(w, ['--for=rehearse', `--rehearsal-authorization=${w.authorization}`,
                 '--inspect']),
        deps(w, { openSourceIdentity: async () => sourceIdentity(over) }))
      const line = r.lines.find(l => l.startsWith('operational adapter binding '))
      expect(line, r.lines.join('\n')).toBeDefined()
      return (line as string).slice('operational adapter binding '.length)
    }
    const baseline = await digestFor({})
    expect(await digestFor({ 0: '7300000000000000009' })).not.toBe(baseline)
  })

  it('changes the binding when the measured implementation head changes', async () => {
    const w = await ready()
    const digestFor = async (head: string): Promise<string> => {
      const r = await runOpsCli(
        base(w, ['--for=rehearse', `--rehearsal-authorization=${w.authorization}`,
                 '--inspect']),
        deps(w, {
          measureRepository: async () => ({ head, ingestionGitlink: '1'.repeat(40) }),
        }))
      const line = r.lines.find(l => l.startsWith('operational adapter binding '))
      expect(line, r.lines.join('\n')).toBeDefined()
      return (line as string).slice('operational adapter binding '.length)
    }
    expect(await digestFor('a'.repeat(40))).not.toBe(await digestFor('b'.repeat(40)))
  })

  it('refuses when the source identity cannot be measured', async () => {
    const w = await ready()
    const r = await runOpsCli(
      base(w, ['--for=rehearse', `--rehearsal-authorization=${w.authorization}`, '--inspect']),
      deps(w, { openSourceIdentity: undefined }))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/read-only source identity session/)
  })
})

describe('the identity query is readable by an ordinary role', () => {
  it('never reads unix_socket_directories', () => {
    // K1.3-D. That is the server's configured LIST, it needs
    // `pg_read_all_settings` to read at all, and it names no session's actual
    // path - so calling it "the endpoint used by a session" was wrong three
    // times over.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect(src).not.toContain('unix_socket_directories')
    expect(src).not.toContain('pg_read_all_settings')
    expect(MEASURED_IDENTITY_SQL).not.toContain('unix_socket_directories')
    // THE SIX REVIEWED FACTS, plus the transport flag.
    expect(MEASURED_IDENTITY_SQL).toContain('pg_control_system()')
    expect(MEASURED_IDENTITY_SQL).toContain('current_database()')
    expect(MEASURED_IDENTITY_SQL).toContain('CURRENT_USER')
    expect(MEASURED_IDENTITY_SQL).toContain('SESSION_USER')
    expect(MEASURED_IDENTITY_SQL).toContain("current_setting('port')")
    expect(MEASURED_IDENTITY_SQL).toContain('inet_server_addr()')
    expect(MEASURED_IDENTITY_SQL).toContain('IS NULL')
    expect(MEASURED_IDENTITY_COLUMNS).toBe(7)
  })

  it('keeps the requested selector apart from what the server reports', async () => {
    const unix = await measureIdentity(sourceIdentity(), '/tmp/asked-for')
    expect(unix.requestedEndpoint).toBe('/tmp/asked-for')
    expect(unix.serverAddress).toBeNull()
    expect(unix.unixTransport).toBe(true)
    expect(unix.currentUser).toBe('ai_capital_v3_export')
    expect(unix.sessionUser).toBe('ai_capital_v3_export')

    const tcp = await measureIdentity(
      sourceIdentity({ 5: '127.0.0.1', 6: 'false' }), 'db.internal')
    expect(tcp.requestedEndpoint).toBe('db.internal')
    expect(tcp.serverAddress).toBe('127.0.0.1')
    expect(tcp.unixTransport).toBe(false)
  })

  it('refuses a row that contradicts itself about its transport', async () => {
    // A Unix session has no server address and a TCP one must have one. A row
    // claiming both, or neither, describes no session that can exist.
    await expect(measureIdentity(sourceIdentity({ 5: '127.0.0.1', 6: 'true' }), '/tmp/s'))
      .rejects.toThrow(/contradicts itself/)
    await expect(measureIdentity(sourceIdentity({ 5: '', 6: 'false' }), '/tmp/s'))
      .rejects.toThrow(/contradicts itself/)
  })

  it('versions the binding shape so the three endpoint facts are unambiguous', () => {
    expect(COPY_BINDING_SHAPE_VERSION).toBe(2)
  })
})

describe('Stage-1 authority governs the copy binding', () => {
  async function chain(w: World): Promise<string[]> {
    await rehearseAndRestore(w)
    expect((await runOpsCli(reviewArgs(w), deps(w))).exitCode).toBe(EXIT_OK)
    return [
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    ]
  }

  it('derives the export role from the manifest, not a later session', async () => {
    // K1.3-E. A live session's `current_user` is whoever the inspection
    // connected as, which has no necessary relationship to whoever ran the
    // export. Changing the session's role must NOT change the binding.
    const w = await ready()
    const common = await chain(w)
    const bundleDir = stage1Bundle(w)
    expect(common.length).toBeGreaterThan(0)
    const digestFor = async (over: Partial<OpsDeps>): Promise<string> =>
      (await bindingOf(w, bundleDir, over)).digest
    const baseline = await digestFor({})
    // THE SOURCE SESSION CONNECTS AS SOMEBODY ELSE. The export role in the
    // binding comes from the manifest, so the digest does not move.
    expect(await digestFor({
      openSourceIdentity: async () => sourceIdentity({ 2: 'someone_else', 3: 'someone_else' }),
    })).toBe(baseline)
  })

  it('refuses a checkout or gitlink the manifest does not record', async () => {
    const w = await ready()
    const common = await chain(w)
    const bundleDir = stage1Bundle(w)
    expect(common.length).toBeGreaterThan(0)
    for (const [label, provenance] of [
      ['head', { head: 'c'.repeat(40), ingestionGitlink: '1'.repeat(40) }],
      ['gitlink', { head: '0'.repeat(40), ingestionGitlink: 'd'.repeat(40) }],
    ] as const) {
      await expect(
        bindingOf(w, bundleDir, { measureRepository: async () => provenance }),
        label,
      ).rejects.toThrow(/not the one the Stage-1 bundle records|not the one the bundle records/)
    }
  })

  it('refuses a manifest with no reviewed authority or provenance fields', async () => {
    const w = await ready()
    for (const missing of ['provenance', 'source_contract']) {
      const dir = publishEvidence({
        root: w.evidence, prefix: 'source-manifest', stamp: STAMP,
        runId: `c${missing.length.toString(16).padStart(7, '0')}`,
        artifacts: [{ path: 'source-contract.json',
                      bytes: Buffer.from('{"pgcopy_schema_contract_version":2}\n', 'utf-8') }],
        manifest: { path: 'manifest.json',
                    bytes: Buffer.from(`${JSON.stringify({ complete: true })}\n`, 'utf-8') },
      }).finalPath
      expect(() => readStage1Authority(dir), missing).toThrow()
    }
  })
})

describe('the passfile object is pinned across psql startup', () => {
  it('inherits the validated descriptor instead of a pathname', () => {
    // K1.3-F. Validating a pathname and then letting the child open that name
    // leaves a window: everything proved was proved about the file that WAS
    // there. An open descriptor cannot be redirected.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const open = src.slice(src.indexOf('export async function openProductionSession'),
                           src.indexOf('export function productionDeps'))
    expect(open).toContain('openReviewedFileDescriptor(passfile)')
    expect(open).toContain('passfileFd: held.fd')
    // AND THE PATHNAME IS NOT ALSO HANDED OVER.
    expect(open).not.toMatch(/\bpassfile\s*\}/)
    // CLOSED ONLY AFTER THE CHILD HAS IT.
    expect(open.indexOf('openPsqlBackend(')).toBeLessThan(open.indexOf('held.close()'))
  })

  it('what the child receives cannot change when the pathname is replaced', () => {
    // THE OBJECT, NOT THE NAME. After validation the pathname is repointed at
    // a different file; the held descriptor still refers to the original inode.
    const d = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(d)
    const path = join(d, 'pgpass')
    writeFileSync(path, 'original\n')
    chmodSync(path, 0o600)
    const held = openReviewedFileDescriptor(path)
    try {
      const before = held.identity.deviceInode
      // SWAP THE NAME for a different file, exactly as an attacker with write
      // access to the directory would.
      rmSync(path)
      writeFileSync(path, 'substituted\n')
      chmodSync(path, 0o600)
      const after = proveReviewedFileMetadata(path)
      // THE NAME NOW RESOLVES TO A DIFFERENT INODE...
      expect(after.deviceInode).not.toBe(before)
      // ...AND THE DESCRIPTOR THE CHILD WOULD INHERIT IS STILL THE FIRST ONE.
      expect(fstatSync(held.fd, { bigint: true }).ino.toString())
        .toBe(before.split(':')[1])
    } finally {
      held.close()
    }
  })

  it('never reads the descriptor and never carries the password', () => {
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function openReviewedFileDescriptor'),
                         src.indexOf('export function openReviewedPlist'))
    expect(fn).toContain('fstatSync(fd')
    expect(fn).toContain('O_NOFOLLOW')
    expect(fn).not.toContain('readFileSync')
    expect(fn).not.toContain('readSync')
    // AND NOTHING IN THE COMMAND PUTS A PASSWORD IN ARGV OR THE ENVIRONMENT.
    const bin = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect(bin).not.toContain('PGPASSWORD')
    expect(bin).not.toContain('--password')
  })
})

describe('the evidence keeps the whole measurement', () => {
  it('publishes the independent process census in full', async () => {
    // K1.3-G. `{name, stopped}` records a conclusion and throws away what
    // produced it: absent, disabled-and-idle, and never-looked-for are three
    // different stories behind one word.
    // THE REAL ADAPTER, against a world whose agents are actually stopped.
    // `disabled AND not running AND no pid AND no process` is what stopped
    // means now, so a world with running agents would - correctly - refuse the
    // gate, and this test would be measuring the refusal instead of the census.
    const w = await ready({ loaded: false, disabled: true })
    const token = await tokenFor(w, 'rehearse')
    expect((await runOpsCli(rehearseArgs(w, token), deps(w, {
      quiescence: launchdQuiescenceAdapter(
        REVIEWED_PRODUCERS, { uid: '501', agentsDir: w.agents, commands: w.commands }),
    }))).exitCode).toBe(EXIT_ACTION_REQUIRED)

    const gate = manifestOf(join(w.evidence, `${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`),
                            'gate-detail.json')
    const rows = gate.producers as Array<Record<string, unknown>>
    expect(rows.length).toBe(REVIEWED_PRODUCERS.length)
    for (const row of rows) {
      for (const k of ['label', 'stopped', 'presence', 'disabled', 'running',
                       'launchd_pid', 'process_pattern', 'process_pids']) {
        expect(Object.prototype.hasOwnProperty.call(row, k), `${String(row.label)}.${k}`)
          .toBe(true)
      }
      expect(Array.isArray(row.process_pids)).toBe(true)
      expect(String(row.process_pattern).length).toBeGreaterThan(0)
    }
  })

  it('preserves both queue samples, in order, with the interval', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse')
    await runOpsCli(rehearseArgs(w, token), deps(w))
    const gate = manifestOf(join(w.evidence, `${RELEASE_GATE_PREFIX}-${STAMP}-${RUN_ID}`),
                            'gate-detail.json')
    const samples = gate.queue_samples as Array<{ ordinal: number; depths: object }>
    expect(samples.length).toBe(2)
    expect(samples.map(x => x.ordinal)).toEqual([1, 2])
    expect(gate.queue_sample_interval_ms).toBe(QUEUE_SAMPLE_INTERVAL_MS)

    // AND THE RESTORATION RECORD KEEPS BOTH TOO.
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).toBe(EXIT_OK)
    const detail = manifestOf(join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`),
                              'producers.json')
    const restored = detail.queue_samples as Array<{ ordinal: number; depths: object }>
    expect(restored.length).toBe(2)
    expect(restored.map(x => x.ordinal)).toEqual([1, 2])
    expect(detail.queue_sample_interval_ms).toBe(QUEUE_SAMPLE_INTERVAL_MS)
  })
})

describe('the gate link agrees about the fence', () => {
  it('refuses a gate whose fenced backend is not the released one', async () => {
    // K1.3-H. A digest, a binding and a run id are necessary and say nothing
    // about WHICH BACKEND. A run that took a fence, lost it, and took another
    // satisfies all three.
    const w = await ready()
    await rehearseAndRestore(w)
    const rehearsalDir = join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)
    const manifest = manifestOf(rehearsalDir, 'rehearsal.json')
    // THE TRUTHFUL PAIR VERIFIES.
    expect(() => verifyGateLink(rehearsalDir, manifest as never)).not.toThrow()
    // THE RELEASED FENCE IS RECORDED, in full.
    const released = manifest.released_fence as Record<string, unknown>
    for (const k of ['supervisor_pid', 'backend_start', 'mechanism',
                     'proving_pid', 'reviewed_relations']) {
      expect(Object.prototype.hasOwnProperty.call(released, k), k).toBe(true)
    }
    // A DIFFERENT BACKEND ON EITHER SIDE REFUSES.
    for (const field of ['supervisor_pid', 'backend_start', 'mechanism', 'proving_pid']) {
      const drifted = {
        ...manifest,
        released_fence: { ...released, [field]: 'somewhere-else' },
      }
      expect(() => verifyGateLink(rehearsalDir, drifted as never), field)
        .toThrow(/describes a different fence/)
    }
    // AND A LINK THAT RECORDS NO FENCE AT ALL REFUSES.
    const { released_fence: _drop, ...without } = manifest
    void _drop
    expect(() => verifyGateLink(rehearsalDir, without as never))
      .toThrow(/records no fence identity/)
  })
})

describe('every connection claim is true', () => {
  // K7-B6.1 F1: the apply inspection - and therefore its two-session claim -
  // is retired. Its truthfulness requirement now belongs to the fenced apply,
  // which opens the target only after Stage 1 has published.
  it('never claims an apply inspection opened anything, because there is none',
    async () => {
      const w = await ready()
      const r = await runOpsCli(base(w, ['--for=apply', '--inspect']), deps(w))
      const text = r.lines.join('\n')
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(text).not.toContain('TWO read-only sessions')
      expect(text).not.toContain('one on the target')
      // AND IT DOES NOT CLAIM TO HAVE OPENED NOTHING EITHER: it says why it
      // refused, and nothing about sessions at all.
      expect(text).not.toContain('opened no database session')
      expect(text).toMatch(/only --for=rehearse is inspectable/)
    })

  it('a rehearsal inspection reports the one session it opened', async () => {
    const w = await ready()
    const r = await runOpsCli(
      base(w, ['--for=rehearse', `--rehearsal-authorization=${w.authorization}`, '--inspect']),
      deps(w))
    const text = r.lines.join('\n')
    expect(text).toContain('ONE read-only session on the source')
    expect(text).toContain('opened no target session')
    expect(text).not.toContain('opened no database session')
  })
})

describe('the hold publishes before it proceeds, and never escapes', () => {
  it('offers no second operation until the first outcome is on disk', async () => {
    // K1.4-B05 (was K1.3-N02). A second database operation on top of an
    // unrecorded first would leave the evidence describing a sequence nobody
    // performed.
    //
    // A CENSUS THAT NEVER RESOLVES, so the hold NEVER ENDS ON ITS OWN. There is
    // no `__maxAttempts` to end it any more and there must not be: the only
    // thing that may is the container, from outside the process. This asserts
    // both halves - what the prompts saw, and that the hold had to be killed.
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: -1 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
    }, { maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    expect(r.ceiling).toBe('bundle-count')
    const prompts = r.report.requests.map(x => x.outcomesOnDisk)
    expect(prompts.length).toBeGreaterThanOrEqual(3)
    // THE FIRST PROMPT SAW NONE; EVERY LATER ONE SAW EXACTLY ONE MORE THAN THE
    // PROMPT BEFORE IT. A prompt that repeated a count would be an operation
    // offered on top of an unrecorded one.
    expect(prompts[0]).toBe(0)
    for (let n = 1; n < prompts.length; n += 1) {
      expect(prompts[n], `prompt ${n + 1}`).toBe((prompts[n - 1] as number) + 1)
    }
    // AND ONE OPERATION PER PROMPT, never two.
    for (const [n, req] of r.report.requests.entries()) {
      expect(req.performedSoFar, `prompt ${n + 1}`).toBe(n)
    }
  }, 180_000)

  it('performs nothing when the intent can NEVER be published', async () => {
    // K1.4-B04 (was K1.3-N03). An unpublishable intent is not a reason to act
    // anyway - and an intent that can never be published is not a reason to ask
    // for a second decision either. The phase stays in the phase.
    //
    // THE INTENT'S RENAME FAILS FOREVER, so this hold cannot end and is not
    // meant to. Its container kills it, and the counters are what the control
    // asserts on.
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      ops: { failRename: 'intervention-intent', failures: -1 },
    }, { wallClockMs: 20_000, maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    // ASKED EXACTLY ONCE. A publication that will not complete is not a new
    // decision.
    expect(r.report.requests.length).toBe(1)
    // AND NOT ONE OPERATION RAN, because not one intent was durable.
    expect(r.report.performed).toBe(0)
    // IT KEPT TRYING THE SAME RECORD, which is what "still holding" means here.
    expect(r.report.renames).toBeGreaterThan(3)
  }, 180_000)

  it('accepts a destination already holding this exact record', async () => {
    // K1.3-N05. An occupied destination means either this exact record already
    // landed - the previous attempt succeeded and its acknowledgement was lost -
    // or something else has the name. The bytes tell them apart.
    const w = await ready()
    // THE SAME RECORD, PUBLISHED TWICE THROUGH THE SAME PATH. The second
    // publication collides; `acceptExistingRecord` compares the bytes and
    // recognises its own.
    const manifest = { record: INTENT_PREFIX, complete: true, attempt: 1 }
    const publish = (): string => publishEvidence({
      root: w.evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json',
                  bytes: Buffer.from(`${canonicalJson(manifest as never)}\n`, 'utf-8') },
    }).finalPath
    const first = publish()
    expect(() => publish()).toThrow()
    // THE BYTES ON DISK ARE THE ONES WE MEANT TO WRITE.
    expect(readFileSync(join(first, 'intent.json'), 'utf-8'))
      .toBe(`${canonicalJson(manifest as never)}\n`)
    // AND A DIFFERENT DOCUMENT AT THE SAME NAME IS NOT OURS.
    expect(readFileSync(join(first, 'intent.json'), 'utf-8'))
      .not.toBe(`${canonicalJson({ ...manifest, attempt: 2 } as never)}\n`)

    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function acceptExistingRecord'))
    expect(fn.length).toBeGreaterThan(300)
    // EVERY PART OF THE BUNDLE, compared as bytes against what was frozen.
    expect(fn).toContain('verifyPublishedEvidence(dir, i.ops)')
    expect(fn).toContain('holdRecordFileSet(manifestFile)')
    expect(fn).toContain('onDisk.equals(intended)')
    // AND THE COMPARISON IS ACTUALLY REACHED. A `publishDurable` that reported
    // every occupied destination as a collision would never consult it, and
    // a retry after a lost acknowledgement would deadlock the hold.
    const durable = src.slice(src.indexOf('async function publishDurable'),
                              src.indexOf('async function publishPhase'))
    expect(durable.length).toBeGreaterThan(400)
    expect(durable).toContain('const already = acceptExistingRecord(')
    expect(durable).toContain('if (already !== null) {')
    expect(durable.indexOf('const already = acceptExistingRecord('))
      .toBeLessThan(durable.indexOf('COLLISION'))
  })

  it('holds when the run-id minter throws', async () => {
    // K1.3-N07. `newRunId` reads the system's random source, which can fail. A
    // throw there used to escape the hold entirely.
    // CONTAINED, with THE MINTER FAILING FOR EVERY HOLD ATTEMPT.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 1 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      runIdMinterThrows: true,
    })
    const evidence = evidenceOf(r)
    // IT KEPT HOLDING, NAMED EVERY ATTEMPT, AND RESOLVED.
    expect(r.report.requests.length).toBe(2)
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    const intents = allBundles(evidence, INTENT_PREFIX)
    expect(intents.length).toBe(2)
    expect(new Set(intents).size).toBe(2)
  }, 180_000)

  it('treats a bundle that does not verify as unpublished', async () => {
    // K1.3-N09. A record that does not read back is a record nobody can act on
    // later, and the terminal resolution is the one thing the loop waits to be
    // able to point at.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('async function publishDurable'),
                         src.indexOf('async function publishPhase'))
    expect(fn.length).toBeGreaterThan(400)
    // VERIFIED BEFORE THE BUNDLE IS RETURNED, so a failure falls into the
    // retry path rather than being reported as a durable record.
    // PRESENT FIRST. `indexOf` returns -1 for a missing needle, which is less
    // than any real index - so an ordering assertion alone passes when the
    // line it is about has been deleted.
    expect(fn).toContain('verifyPublishedEvidence(published.finalPath, i.ops)')
    expect(fn.indexOf('verifyPublishedEvidence(published.finalPath, i.ops)'))
      .toBeLessThan(fn.indexOf('name: basename(published.finalPath)'))

    // AND FUNCTIONALLY: a bundle whose bytes were edited does not verify, so
    // the same call that produced it would not accept it.
    const w = await ready()
    const dir = publishEvidence({
      root: w.evidence, prefix: OUTCOME_PREFIX, stamp: STAMP, runId: 'beefbeef',
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'outcome.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }).finalPath
    execFileSync('/bin/chmod', ['u+w', dir])
    execFileSync('/bin/chmod', ['u+w', join(dir, 'outcome.json')])
    writeFileSync(join(dir, 'outcome.json'), '{"complete":true} \n')
    expect(() => verifyPublishedEvidence(dir)).toThrow()
  })
})

describe('Stage-1 authority and provenance, directly', () => {
  const stage1 = (over: Partial<Stage1Authority> = {}): Stage1Authority => ({
    bundleName: 'source-manifest-20260925T101500Z-a1b2c3d4',
    digestFileDigest: 'a'.repeat(64),
    // K7-B7.1: part of the reviewed authority now.
    runId: 'a1b2c3d4',
    generatedAtUtc: '2026-09-25T10:15:00Z',
    systemIdentifier: '7300000000000000001',
    database: 'ai_capital',
    currentUser: 'ai_capital_v3_export',
    sessionUser: 'ai_capital_v3_export',
    contentRootDigest: 'b'.repeat(64),
    sourceContractDigest: 'c'.repeat(64),
    copySet: COPY_TABLES,
    provenanceHead: '0'.repeat(40),
    ingestionGitlink: '1'.repeat(40),
    ...over,
  })
  const source = async (): Promise<MeasuredIdentity> =>
    await measureIdentity(sourceIdentity(), '/tmp/s')
  const target = async (): Promise<MeasuredIdentity> =>
    await measureIdentity(targetIdentity(), '/Users/x/ai-capital-v3-run')

  it('refuses a measured HEAD the manifest does not record', async () => {
    // K1.3-N23. Asserted directly: through the CLI the operational binding
    // moves too, and the stronger refusal would mask this one.
    await expect(async () => freshCopyBindingFrom(
      stage1(), await source(), await target(),
      { head: 'f'.repeat(40), ingestionGitlink: '1'.repeat(40) },
    )).rejects.toThrow(/measured checkout is not the one the Stage-1 bundle records/)
  })

  it('refuses a measured gitlink the manifest does not record', async () => {
    await expect(async () => freshCopyBindingFrom(
      stage1(), await source(), await target(),
      { head: '0'.repeat(40), ingestionGitlink: 'f'.repeat(40) },
    )).rejects.toThrow(/measured ingestion gitlink is not the one the bundle records/)
  })

  it('takes the export role from the manifest and nothing else', async () => {
    const provenance = { head: '0'.repeat(40), ingestionGitlink: '1'.repeat(40) }
    const a = freshCopyBindingFrom(stage1(), await source(), await target(), provenance)
    // A SESSION CONNECTED AS SOMEBODY ELSE does not move the binding.
    const other = await measureIdentity(
      sourceIdentity({ 2: 'someone_else', 3: 'someone_else' }), '/tmp/s')
    const b = freshCopyBindingFrom(stage1(), other, await target(), provenance)
    expect(b.digest).toBe(a.digest)
    expect(b.binding.sourceExportRole).toBe('ai_capital_v3_export')
    // A DIFFERENT EXPORT ROLE IN THE MANIFEST does.
    const c = freshCopyBindingFrom(
      stage1({ currentUser: 'another_role' }), await source(), await target(), provenance)
    expect(c.digest).not.toBe(a.digest)
  })

  it('refuses a manifest missing any reviewed authority or provenance field', async () => {
    const w = await ready()
    const base = {
      complete: true,
      // K7-B7.1: the run identity the copy chain reads out of the verified
      // manifest. Part of the reviewed authority now, so a manifest without it
      // is refused by the same reader as a missing role.
      run_id: 'bbbbbbbb',
      generated_at_utc: '2026-09-25T10:15:00Z',
      source: {
        system_identifier: '7300000000000000001', database: 'ai_capital',
        role: 'ai_capital_v3_export', session_user: 'ai_capital_v3_export',
      },
      content: { root_digest: 'b'.repeat(64), tables: COPY_TABLES.map(q => ({ qname: q })) },
      source_contract: { digest: 'c'.repeat(64) },
      provenance: { head: '0'.repeat(40), ingestion_gitlink: '1'.repeat(40) },
    }
    const contract = {
      pgcopy_schema_contract_version: 2,
      digest: contractDigest({ migrations: { recognition: 'CURRENT_V10' } } as never),
      payload: { migrations: { recognition: 'CURRENT_V10' } },
      generated_at: '2026-09-25T10:00:00Z',
    }
    let seq = 0
    const publishWith = (doc: Record<string, unknown>): string => {
      seq += 1
      return publishEvidence({
        root: w.evidence, prefix: 'source-manifest', stamp: STAMP,
        runId: `e${seq.toString(16).padStart(7, '0')}`,
        artifacts: [{ path: 'source-contract.json',
                      bytes: Buffer.from(`${serializeArtifact(contract as never)}\n`, 'utf-8') }],
        manifest: { path: 'manifest.json',
                    bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
      }).finalPath
    }
    // THE COMPLETE ONE READS.
    const ok = readStage1Authority(publishWith(base))
    expect(ok.provenanceHead).toBe('0'.repeat(40))
    expect(ok.ingestionGitlink).toBe('1'.repeat(40))
    expect(ok.currentUser).toBe('ai_capital_v3_export')

    // EVERY OMISSION REFUSES, and says which field.
    const omissions: Array<[string, Record<string, unknown>]> = [
      ['provenance', { ...base, provenance: {} }],
      ['head', { ...base, provenance: { ingestion_gitlink: '1'.repeat(40) } }],
      ['gitlink', { ...base, provenance: { head: '0'.repeat(40) } }],
      ['source role', { ...base, source: { ...base.source, role: undefined } }],
      ['content root', { ...base, content: { tables: base.content.tables } }],
      ['copy set', { ...base, content: { root_digest: 'b'.repeat(64), tables: [] } }],
    ]
    for (const [label, doc] of omissions) {
      expect(() => readStage1Authority(publishWith(doc)), label).toThrow()
    }
  })
})

describe('the passfile descriptor is not leaked and reaches the child', () => {
  it('closes the descriptor on every refusal', () => {
    // K1.3-N30. Only a descriptor that passed every check is handed back; a
    // refusal that leaked one would exhaust the process's fd table over a run.
    const d = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(d)
    const wide = join(d, 'wide')
    writeFileSync(wide, 'x')
    chmodSync(wide, 0o644)

    const good = join(d, 'good')
    writeFileSync(good, 'localhost:5432:db:me:secret\n')
    chmodSync(good, 0o600)

    // THE FD NUMBER IS THE MEASUREMENT, and it is deterministic. The kernel
    // hands out the LOWEST free descriptor, so if forty refusals each leaked
    // one, the next successful open would be forty numbers higher. Counting
    // `/dev/fd` entries would be noisier and racier: a worker opens and closes
    // files of its own throughout.
    const first = openReviewedFileDescriptor(good)
    const baseline = first.fd
    first.close()

    for (let n = 0; n < 40; n += 1) {
      expect(() => openReviewedFileDescriptor(wide)).toThrow(/not mode 0600/)
    }

    const held = openReviewedFileDescriptor(good)
    try {
      // THE SAME SLOT IS FREE AGAIN, so nothing was retained.
      expect(held.fd).toBeLessThanOrEqual(baseline + 2)
      expect(fstatSync(held.fd, { bigint: true }).size).toBeGreaterThan(0n)
    } finally {
      held.close()
    }
  })

  it('names the inherited descriptor to the child, not a path', () => {
    // K1.3-N31. The child must receive the descriptor at a known slot and be
    // told about it by that slot - otherwise PGPASSFILE points at a name the
    // child opens for itself, which is the window this closes.
    const backend = strip(readFileSync(
      new URL('../../db/src/pg-copy/psql-backend.ts', import.meta.url), 'utf-8'))
    expect(backend).toContain('if (inherited) stdio.push(o.passfileFd as number)')
    expect(backend).toContain('INHERITED_FD_DIR')
    expect(backend).toContain('PASSFILE_CHILD_FD')
    expect(backend).toContain('sterileBatchEnv(\n    inherited ?')
    expect(INHERITED_FD_DIR).toBe('/dev/fd')
    // AFTER 0, 1 AND 2 - the three pipes - so the child sees /dev/fd/3.
    expect(PASSFILE_CHILD_FD).toBe(3)
  })
})

describe('the provenance in the binding is the measured one', () => {
  it('is interchangeable with the manifest value ONLY because they are compared', () => {
    // WHY K1.2-L18 IS NOW AN EQUIVALENT MUTANT, stated rather than assumed.
    //
    // Substituting `stage1.provenanceHead` for `provenance.head` in the binding
    // changes nothing, because `freshCopyBindingFrom` refuses two lines earlier
    // unless the two are identical. That is the design working: the measured
    // value governs, and a manifest that disagrees with it stops the run.
    //
    // THE EQUIVALENCE IS THEREFORE LOAD-BEARING, so it is asserted. Remove the
    // comparison and the substitution stops being equivalent - which is what
    // the other two controls in this file check.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function freshCopyBindingFrom'),
                         src.indexOf('export async function measuredCopyBinding'))
    expect(fn).toContain('if (provenance.head !== stage1.provenanceHead) {')
    expect(fn).toContain('if (provenance.ingestionGitlink !== stage1.ingestionGitlink) {')
    // AND THE COMPARISONS COME BEFORE THE BINDING IS BUILT.
    expect(fn.indexOf('provenance.head !== stage1.provenanceHead'))
      .toBeLessThan(fn.indexOf('provenanceHead: provenance.head'))
    expect(fn.indexOf('provenance.ingestionGitlink !== stage1.ingestionGitlink'))
      .toBeLessThan(fn.indexOf('ingestionGitlink: provenance.ingestionGitlink'))
  })
})

// ---------------------------------------------------------------------------
// K1.4 CONTROLS
// ---------------------------------------------------------------------------

describe('K1.4: the hold has no finite escape, and containment is external', () => {
  it('leaves no finite production escape and no __maxAttempts token anywhere', () => {
    // K1.4-F01. `__maxAttempts` was a double-underscored dependency that made
    // the loop finite. A hold a dependency can end is not a hold: whatever ends
    // it releases a fence whose state nobody wrote down. The seam is gone from
    // production AND from the suite, and this looks for the token itself as well
    // as for the shape of a ceiling.
    const paths = [
      '../bin/pg-copy-ops.ts',
      './support/ops-world.ts', './support/contained.ts', './support/hold-child.ts',
      './support/hold-spec.ts',
    ]
    for (const rel of paths) {
      // EXECUTABLE TEXT ONLY. `strip` removes the comments, so a file that
      // EXPLAINS why the seam was removed is not mistaken for one that still has
      // it - which is the difference between prose and a dependency.
      const text = strip(readFileSync(new URL(rel, import.meta.url), 'utf-8'))
      // NON-VACUITY FIRST. A path that failed to read would satisfy every
      // "does not contain" below.
      expect(text.length, rel).toBeGreaterThan(300)
      expect(text, rel).not.toContain('__maxAttempts')
      expect(text, rel).not.toContain('HoldAttemptsExceeded')
    }
    // AND THE LOOP ITSELF HAS NO COUNT IN IT. Executable text only, so a comment
    // that discusses attempts is not mistaken for one that limits them.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const hold = src.slice(src.indexOf('export async function holdForIntervention'),
                           src.indexOf('export function attemptRunId'))
    expect(hold.length).toBeGreaterThan(500)
    expect(hold).toContain('for (;;)')
    // THE ONLY `break` IS THE TERMINAL RESOLUTION, and the only `return` is after
    // it. Nothing compares `attempt` with anything.
    expect(hold).not.toMatch(/attempt\s*(>=|>|===|<|<=)/)
    expect(hold).not.toContain('maxAttempts')
    // AND THE PHASE LOOP IS UNBOUNDED TOO.
    const phase = src.slice(src.indexOf('async function publishPhase'),
                            src.indexOf('export function acceptExistingRecord'))
    expect(phase.length).toBeGreaterThan(200)
    expect(phase).toContain('for (;;)')
    expect(phase).not.toMatch(/(>=|>|===|<|<=)\s*PUBLICATION_ATTEMPTS/)
  })

  it('kills an unscripted hold from outside, and leaves zero residue', async () => {
    // K1.4-F02. The default resolver resolves nothing, so this hold cannot end.
    // Nothing inside the process can stop it - SIGTERM is HELD by design - so the
    // container SIGKILLs the process group it owns and removes exactly the roots
    // that child reported.
    const before = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith(ROOT_PREFIX))
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: -1 },
      hold: { kind: 'forbidden' },
    }, { maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    // THE CHILD RECORDED WHY, before it was killed.
    expect(r.report.unscripted).toMatch(/no scripted resolver/)
    // THE ROOTS ARE GONE, and nothing else was touched: the only prefixed
    // directories left are the control directory this call made and whatever was
    // there before it.
    expect(r.roots).toEqual([])
    const after = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith(ROOT_PREFIX))
    // AT MOST ONE MORE THAN BEFORE - the control directory, which `afterEach`
    // removes. No abandoned world survives.
    expect(after.length).toBeLessThanOrEqual(before.length + 1)
    expect(after.filter(n => !n.includes('ctl')).length).toBe(0)
  }, 180_000)

  it('an outcome that never publishes performs once and asks nobody again',
    async () => {
      // K1.4-F03. The operation ran. Its account cannot be written. So this
      // process may not act on the result, may not offer another database action,
      // may not request a second decision, and may not return. It holds until its
      // container kills it, and the counters say exactly that.
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: -1 },
      }, { wallClockMs: 20_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
      // AND IT KEPT TRYING THE SAME RECORD rather than giving up on it.
      expect(r.report.renames).toBeGreaterThan(3)
    }, 180_000)
})

describe('K1.4: a collision is recognised by the WHOLE bundle', () => {
  /** An evidence root and a frozen record to compare a published bundle with. */
  const bench = (): {
    root: string
    inputs: HoldInputs
    frozen: FrozenRecord
    publish: (over?: {
      manifest?: Record<string, unknown>
      detail?: Record<string, unknown>
      extra?: Record<string, string>
    }) => string
  } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(root)
    const evidence = join(root, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    chmodSync(evidence, 0o700)
    const manifest = { record: INTENT_PREFIX, complete: true, attempt: 1 }
    const detail = { offered_actions: ['CENSUS_ONLY'] }
    const frozen = freezeRecord(manifest, detail)
    const inputs = { root: evidence, stamp: STAMP } as unknown as HoldInputs
    const publish = (over: {
      manifest?: Record<string, unknown>
      detail?: Record<string, unknown>
      extra?: Record<string, string>
    } = {}): string => publishEvidence({
      root: evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      artifacts: [
        { path: 'actions.json',
          bytes: Buffer.from(`${canonicalJson((over.detail ?? detail) as never)}\n`, 'utf-8') },
        ...Object.entries(over.extra ?? {}).map(([path, text]) => ({
          path, bytes: Buffer.from(text, 'utf-8'),
        })),
      ],
      manifest: { path: 'intent.json',
                  bytes: Buffer.from(
                    `${canonicalJson((over.manifest ?? manifest) as never)}\n`, 'utf-8') },
    }).finalPath
    return { root: evidence, inputs, frozen, publish }
  }

  it('accepts a destination holding this exact record, bytes for bytes', async () => {
    // K1.4-F04. An occupied destination means either this exact record already
    // landed - the previous attempt succeeded and its acknowledgement was lost -
    // or something else has the name. The first is success.
    const b = bench()
    const dir = b.publish()
    const accepted = acceptExistingRecord(
      b.inputs, 'abcdef01', INTENT_PREFIX, 'intent.json', b.frozen)
    expect(accepted).not.toBeNull()
    expect(accepted?.name).toBe(basename(dir))
    expect(accepted?.digestFileDigest).toMatch(/^[0-9a-f]{64}$/)
  }, 180_000)

  it('rejects the same manifest with a different actions.json', async () => {
    // K1.4-F05. This is the one the old comparison let through: it verified the
    // bundle, found the manifest among its files, compared the manifest's bytes,
    // and never looked at the detail artifact at all. A bundle whose
    // `actions.json` says something else entirely is not this record, and
    // accepting it is accepting somebody else's evidence as this run's.
    const b = bench()
    b.publish({ detail: { offered_actions: ['ABANDON'] } })
    expect(acceptExistingRecord(
      b.inputs, 'abcdef01', INTENT_PREFIX, 'intent.json', b.frozen)).toBeNull()
  })

  it('rejects a bundle carrying an extra file, and one missing a file', async () => {
    // K1.4-F06. The file set is EXACTLY the reviewed set. An extra file is bytes
    // nobody wrote as part of this record; a missing one is a record that is not
    // this record however much of it matches.
    const extra = bench()
    extra.publish({ extra: { 'notes.txt': 'anything\n' } })
    expect(acceptExistingRecord(
      extra.inputs, 'abcdef01', INTENT_PREFIX, 'intent.json', extra.frozen)).toBeNull()

    // MISSING: a bundle published with the detail artifact under another name has
    // the reviewed count but not the reviewed set.
    const missing = bench()
    publishEvidence({
      root: missing.root, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      artifacts: [{ path: 'other.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: missing.frozen.manifestBytes },
    })
    expect(acceptExistingRecord(
      missing.inputs, 'abcdef01', INTENT_PREFIX, 'intent.json', missing.frozen)).toBeNull()
  })

  it('rejects a bundle that does not verify at all', async () => {
    // K1.4-F07. Verification comes FIRST and nothing else is looked at without
    // it: a bundle whose DIGEST does not describe its bytes is not evidence.
    const b = bench()
    const dir = b.publish()
    execFileSync('/bin/chmod', ['-R', 'u+rwX', dir])
    writeFileSync(join(dir, 'actions.json'), '{"offered_actions":["ABANDON"]}\n')
    expect(acceptExistingRecord(
      b.inputs, 'abcdef01', INTENT_PREFIX, 'intent.json', b.frozen)).toBeNull()
  })

  it('names exactly the reviewed file set', () => {
    // K1.4-F08. Named in one place so the writer and the comparison cannot drift.
    expect([...holdRecordFileSet('intent.json')]).toEqual(['DIGEST', 'actions.json', 'intent.json'])
    expect([...holdRecordFileSet('outcome.json')])
      .toEqual(['DIGEST', 'actions.json', 'outcome.json'])
    expect(DETAIL_FILE).toBe('actions.json')
  })
})

describe('K1.4: a derived attempt name carries the fence identity', () => {
  const inputs = (over: Partial<HoldInputs>): HoldInputs => ({
    outerRunId: RUN_ID, stamp: STAMP, operationalDigest: 'a'.repeat(64),
    supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START,
    newRunId: () => { throw new Error('no entropy') },
    ...over,
  } as unknown as HoldInputs)

  it('derives different names for two concurrent holds of different fences', () => {
    // K1.4-F09. Two rehearsals started in the same second against the same
    // reviewed scope share a stamp AND an operational digest - the digest is a
    // property of the configuration, not of a run. Derived from those two and an
    // ordinal alone, their first attempts would compute the SAME name, and the
    // second to publish would find its destination occupied by a record of
    // somebody else's attempt: a collision that reads as evidence tampering.
    const base = attemptRunId(inputs({}), 1)
    expect(base).toMatch(/^[0-9a-f]{8}$/)
    // EVERY IDENTITY FIELD CHANGES IT, one at a time.
    const differs: Array<[string, Partial<HoldInputs>]> = [
      ['outer run id', { outerRunId: 'deadbeef' }],
      ['supervisor pid', { supervisorPid: '41513' }],
      ['backend start', { backendStart: '2026-09-25 10:15:00+00' }],
      ['stamp', { stamp: '20260925T101501Z' }],
      ['operational digest', { operationalDigest: 'b'.repeat(64) }],
    ]
    for (const [what, over] of differs) {
      expect(attemptRunId(inputs(over), 1), what).not.toBe(base)
    }
    // AND SO DOES THE ORDINAL, so one hold's own attempts derive apart too.
    expect(attemptRunId(inputs({}), 2)).not.toBe(base)
    // ALL SIX ARE DISTINCT, not merely different from the first.
    const all = [base, ...differs.map(([, o]) => attemptRunId(inputs(o), 1)),
                 attemptRunId(inputs({}), 2)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('prefers a minted id and only derives when the minter fails', () => {
    // K1.4-F10. The derivation is a fallback, not the normal path.
    expect(attemptRunId(inputs({ newRunId: () => '0123abcd' }), 1)).toBe('0123abcd')
    // AND A MINTER THAT RETURNS SOMETHING MALFORMED IS NOT TRUSTED.
    expect(attemptRunId(inputs({ newRunId: () => 'NOTHEX' }), 1))
      .toBe(attemptRunId(inputs({}), 1))
  })
})

describe('K1.4: Stage-1 authority requires an explicit, agreeing session user', () => {
  /**
   * A REAL, VERIFYING Stage-1 bundle whose `source` object is exactly this.
   *
   * Built through the same publisher the export uses, so the refusals below are
   * about the session user and not about a fixture that fails to verify.
   */
  let seq = 0
  const withSource = (source: Record<string, unknown>): string => {
    seq += 1
    return stage1Bundle(world(), {
      source: { system_identifier: '7300000000000000001', database: 'ai_capital', ...source },
      runId: `abcd00${seq.toString(16).padStart(2, '0')}`,
    })
  }

  it('reads the export role and the session user when they agree', () => {
    // NON-VACUITY. The refusals below have to be about the session user and not
    // about some other field of this fixture.
    const a = readStage1Authority(withSource({ role: 'thanapold', session_user: 'thanapold' }))
    expect(a.currentUser).toBe('thanapold')
    expect(a.sessionUser).toBe('thanapold')
  })

  it('refuses a manifest that states no session user at all', () => {
    // K1.4-F11. This used to read `session_user ?? role`, so a manifest carrying
    // no session user was silently treated as though it had declared the export
    // role - which is the very claim being checked. Every older bundle, and every
    // hand-edited one, satisfied the comparison BY DEFINITION.
    expect(() => readStage1Authority(withSource({ role: 'thanapold' })))
      .toThrow(/no reviewed source session user/)
  })

  it('refuses a session user that differs from the export role', () => {
    // K1.4-F12. They differ exactly when the export ran under a `SET ROLE` or a
    // `SECURITY DEFINER`. An export whose effective role was not the role that
    // logged in was performed under borrowed authority, and its account of what
    // the source contained was produced under privileges the named session does
    // not have.
    expect(() => readStage1Authority(
      withSource({ role: 'postgres', session_user: 'thanapold' })))
      .toThrow(/session user and export role disagree/)
  })

  it('refuses a malformed session user', () => {
    for (const bad of ['', 'Thanapold', '1role', 'role name']) {
      expect(() => readStage1Authority(withSource({ role: 'thanapold', session_user: bad })),
             JSON.stringify(bad)).toThrow()
    }
  })

  it('has no role fallback left in the source', () => {
    // K1.4-F13. The fallback's absence would be invisible otherwise: a manifest
    // that happens to carry both fields passes either way.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // K7-B6.2 C SPLIT THE READER FROM THE PARSER. `readStage1Authority` is now
    // a wrapper around `verifyPublishedStage1` + `stage1AuthorityOf`, so the
    // BODY this property is about - the authority parse - lives in the latter.
    // Slicing the wrapper would have measured three lines and passed for the
    // wrong reason; the length assertion below is what caught that.
    const fn = src.slice(src.indexOf('export function stage1AuthorityOf'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body.length).toBeGreaterThan(300)
    expect(body).not.toContain('session_user ?? ')
    expect(body).toContain("need(doc.source?.session_user, 'source session user'")
    expect(body).toContain('sessionUser !== exportRole')
  })
})

// ---------------------------------------------------------------------------
// K1.5 CONTROLS
// ---------------------------------------------------------------------------

describe('K1.5: the unbounded hold has bounded scratch space', () => {
  /**
   * WHAT "BOUNDED" IS ASSERTED AS.
   *
   * Two reviewed temporary directories per record, whatever the retry count - the
   * preserved diagnostic directory and the one stable retry scratch - and bytes
   * that stop growing with them. The number of CYCLES is deliberately large and
   * deliberately not bounded: the hold must not stop, and these controls exist to
   * prove that its filesystem consumption does.
   */
  const REVIEWED_SCRATCH_DIRS = 2

  /** Every census sample after the bound, checked one at a time. */
  const assertBounded = (r: ContainedResult, dirs: number): void => {
    const census = r.report.scratchCensus
    // NON-VACUITY FIRST. An empty census satisfies every "never exceeds" below.
    expect(census.length, 'no census samples were taken').toBeGreaterThan(3)
    const settled = census.slice(2)
    const bytes = settled.map(x => x.bytes)
    for (const s of settled) {
      expect(s.temporaryDirs, `attempt ${s.attempt}: ${s.temporaryNames.join(', ')}`)
        .toBeLessThanOrEqual(dirs)
      // AND EVERY ONE OF THEM IS A NAME THIS RECORD IS ALLOWED TO USE.
      for (const n of s.temporaryNames) {
        expect(n, `attempt ${s.attempt}`).toMatch(/^\.tmp-intervention-outcome-[0-9a-f]{8}(-retry)?$/)
      }
    }
    // BYTES STOP GROWING TOO. A scheme that reused two names but appended to them
    // would satisfy a directory count and still fill a volume.
    //
    // NOT "CONSTANT": OSCILLATING. A cycle that clears the retry scratch and
    // rebuilds it is between one directory and two depending on where the sample
    // lands, so the honest assertion is that the LATER samples never exceed the
    // early ones - no growth over time, which is what a bound means here.
    const early = Math.max(...bytes.slice(0, Math.min(10, bytes.length)))
    const later = Math.max(...bytes.slice(Math.floor(bytes.length / 2)))
    expect(later, `early ${early} later ${later}`).toBeLessThanOrEqual(early)
  }

  it('survives thousands of retry cycles of a persistent rename failure, bounded',
    async () => {
      // K1.5-A01. THE DEFECT THIS ORDER EXISTS FOR. Under K1.4 every failed
      // publication incremented a counter and preserved the directory it had just
      // built, so a rename that keeps failing - a read-only device, a full
      // volume - produced one more preserved directory per cycle for as long as
      // the fence was held, which is for ever.
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: -1 },
      }, { wallClockMs: 15_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      // FAR MORE THAN A HUNDRED CYCLES, which is the point: the hold did not stop.
      expect(r.report.renames).toBeGreaterThan(100)
      assertBounded(r, REVIEWED_SCRATCH_DIRS)
      // AND STILL EXACTLY ONE DECISION AND ONE OPERATION across all of them.
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
    }, 180_000)

  it('bounds a persistent freeze failure, which can never leave a complete record',
    async () => {
      // K1.5-A02. A freeze that will not take fails at step 7, so the scratch
      // directory can NEVER verify - the permanent-incomplete case, where every
      // cycle has to clear the retry scratch and rebuild it. That is the path that
      // actually exercises `discardScratch`, thousands of times over.
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: 0, failFileChmod: true },
      }, { wallClockMs: 15_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      // REBUILT THOUSANDS OF TIMES, and never once accumulated.
      expect(r.report.publishAttempts).toBeGreaterThan(100)
      assertBounded(r, REVIEWED_SCRATCH_DIRS)
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
      // AND THE DIAGNOSTIC DIRECTORY IS STILL THERE, IN EVERY SAMPLE.
      //
      // Requirement 2 is that the FIRST failure's directory is preserved, and a
      // count of two proves nothing about that on its own - a scheme that cleared
      // the diagnostic directory and kept two others would satisfy it. So the
      // untagged name is required to be present every single time, which is what
      // "preserved" means: the person debugging a persistent publication failure
      // still has the first attempt's wreckage to look at.
      const settled = r.report.scratchCensus.slice(2)
      expect(settled.length).toBeGreaterThan(3)
      for (const sample of settled) {
        expect(sample.temporaryNames, `attempt ${sample.attempt}`)
          .toContain(`.tmp-${OUTCOME_PREFIX}-${RUN_ID}`)
      }
    }, 180_000)

  it('bounds a persistent fsync failure at ONE directory, by re-renaming it',
    async () => {
      // K1.5-A03. An fsync that will not take fails at step 9, AFTER the bytes are
      // written and frozen - so what it leaves behind holds the complete record.
      // The retry renames THAT, and a rename needs no second directory: the bound
      // here is one, not two, and the record is built exactly once however many
      // times its publication is retried.
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: -1, failFsync: true },
      }, { wallClockMs: 15_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      expect(r.report.renames).toBeGreaterThan(100)
      // BUILT ONCE. Not once per retry.
      expect(r.report.publishAttempts).toBe(1)
      assertBounded(r, 1)
    }, 180_000)

  it('renames a complete retained directory rather than rebuilding it', async () => {
    // K1.5-A04. Requirement 6, and it was UNREACHABLE when first written: a
    // scratch directory is 0700 until after its rename, and asking
    // `verifyPublishedEvidence` about it failed on the root mode alone. Measured,
    // then fixed - see `verifyFrozenTree`.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      ops: { failRename: 'intervention-outcome', failures: 0, failFsync: true },
    })
    const evidence = evidenceOf(r)
    // IT PUBLISHED, and it did so from the directory the first attempt built:
    // exactly one scratch directory was ever created, and exactly one rename ran.
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    expect(r.report.publishAttempts).toBe(1)
    expect(r.report.renames).toBe(1)
    // EXACTLY ONCE, UNDER THE ORIGINAL FINAL NAME, and with no scratch left over.
    expect(bundles(evidence, OUTCOME_PREFIX)).toEqual(
      [`${OUTCOME_PREFIX}-${STAMP}-${RUN_ID}`])
    expect(readdirSync(evidence).filter(n => n.startsWith('.tmp-'))).toEqual([])
    // AND THE BYTES IT PUBLISHED ARE THE FROZEN ONES: the record verifies and
    // says it is complete.
    const dir = join(evidence, onlyBundle(evidence, OUTCOME_PREFIX))
    expect(verifyPublishedEvidence(dir).length).toBeGreaterThan(0)
    expect(manifestOf(dir, 'outcome.json').complete).toBe(true)
  }, 180_000)

  it('publishes the exact frozen bytes after a transient failure clears', async () => {
    // K1.5-A05. Two failed renames and then a success: one decision, one
    // operation, one published record, and its bytes are the ones frozen before
    // the first attempt.
    const r = await contained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      ops: { failRename: 'intervention-outcome', failures: 2 },
    })
    const evidence = evidenceOf(r)
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)
    expect(r.report.requests.length).toBe(1)
    expect(r.report.performed).toBe(1)
    expect(r.report.renames).toBe(3)
    const dir = join(evidence, onlyBundle(evidence, OUTCOME_PREFIX))
    const m = manifestOf(dir, 'outcome.json')
    // ONE ATTEMPT, NOT THREE. A record re-minted per retry would say otherwise.
    expect(m.attempt).toBe(1)
    expect(m.complete).toBe(true)
    // AND NO SCRATCH SURVIVED A SUCCESSFUL PUBLICATION.
    expect(readdirSync(evidence).filter(n => n.startsWith('.tmp-'))).toEqual([])
  }, 180_000)

  it('never renames twice or deletes anything after an unreported rename',
    async () => {
      // K1.5-A06. The helper can complete the rename and be killed before its exit
      // code is observed, and here the two paths that would resolve that cannot be
      // examined either. A second rename could publish twice; a removal could
      // remove something that is already evidence under another name. So neither
      // happens, and the hold stays until its container ends it.
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: 0, renameIndeterminate: true },
      }, { wallClockMs: 20_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      // EXACTLY ONE RENAME EVER ATTEMPTED, across the whole remaining hold.
      expect(r.report.renames).toBe(1)
      // AND THE DIRECTORY IS STILL THERE: nothing was removed.
      const census = r.report.scratchCensus
      expect(census.length).toBeGreaterThan(0)
      expect((census[census.length - 1] as { temporaryDirs: number }).temporaryDirs).toBe(1)
      // ONE DECISION, ONE OPERATION. An unproved publication is not a new attempt.
      expect(r.report.requests.length).toBe(1)
      expect(r.report.performed).toBe(1)
      // AND NOTHING WAS PUBLISHED EITHER: an unreported rename is not a second
      // chance to publish, so the outcome record never appears under its final
      // name while the state is unproved.
      const last = census[census.length - 1] as { publishedDirs: number }
      expect(last.publishedDirs).toBe(2)
    }, 180_000)

  it('performs nothing at all when the INTENT can never be published', async () => {
    // K1.5-A07. The intent phase, bounded the same way, and still zero operations.
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      ops: { failRename: 'intervention-intent', failures: -1 },
    }, { wallClockMs: 20_000, maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    expect(r.report.renames).toBeGreaterThan(100)
    expect(r.report.requests.length).toBe(1)
    // NOT ONE OPERATION, because not one intent was durable.
    expect(r.report.performed).toBe(0)
    const census = r.report.scratchCensus
    expect(census.length).toBeGreaterThan(3)
    for (const s of census.slice(2)) {
      expect(s.temporaryDirs, `attempt ${s.attempt}`).toBeLessThanOrEqual(REVIEWED_SCRATCH_DIRS)
      for (const n of s.temporaryNames) {
        expect(n).toMatch(/^\.tmp-intervention-intent-[0-9a-f]{8}(-retry)?$/)
      }
    }
  }, 180_000)

  it('modifies no published bundle while it retries, and leaves zero residue',
    async () => {
      // K1.5-A08. The release-gate record and the intent record are already
      // published when the outcome's publication starts failing. Neither may be
      // touched by thousands of retry cycles - and when the container kills the
      // child, nothing at all may be left behind.
      const before = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith(ROOT_PREFIX))
      const r = await runContained({
        supervisor: { releaseError: true },
        prover: { kind: 'locks-until', resolveAfter: 0 },
        hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
        ops: { failRename: 'intervention-outcome', failures: -1 },
      }, { wallClockMs: 10_000, maxBundles: 12 })
      expect(r.outcome).toBe('killed')
      const census = r.report.scratchCensus
      expect(census.length).toBeGreaterThan(3)
      // THE PUBLISHED COUNT NEVER MOVES: the gate and the intent, and nothing
      // else appears or disappears while the outcome cannot land.
      const published = census.slice(2).map(x => x.publishedDirs)
      expect(Math.max(...published)).toBe(Math.min(...published))
      expect(published[0]).toBe(2)
      // ZERO RESIDUE AFTER A KILL. The container removed exactly the roots the
      // child reported, and reported none it did not own.
      expect(r.roots).toEqual([])
      const after = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith(ROOT_PREFIX))
      expect(after.filter(n => !n.includes('ctl')).length).toBe(0)
      expect(after.length).toBeLessThanOrEqual(before.length + 1)
    }, 180_000)
})

describe('K1.5: nothing is removed that was not proved to be ours', () => {
  /** An evidence root and the reviewed scratch input for one record in it. */
  const bench = (): {
    evidence: string; input: ScratchInput; temp: string; receipt: () => string | null
  } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(root)
    const evidence = join(root, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    chmodSync(evidence, 0o700)
    const input: ScratchInput = {
      root: evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      temporaryTag: EVIDENCE_RETRY_SCRATCH,
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }
    const temp = join(evidence, `.tmp-${INTENT_PREFIX}-abcdef01-${EVIDENCE_RETRY_SCRATCH}`)
    /**
     * THE RECEIPT FOR A TREE THIS TEST ITSELF MADE.
     *
     * Read after the directory exists, which is the only honest way for a test to
     * hold one: production gets it from the publisher's own `mkdir`, and a test that
     * built the directory is entitled to the same claim. `null` when nothing is
     * there, which is what a missing receipt looks like.
     */
    const receipt = (): string | null => {
      try {
        const st = statSync(temp, { bigint: true })
        return `${String(st.dev)}:${String(st.ino)}`
      } catch { return null }
    }
    return { evidence, input, temp, receipt }
  }

  it('clears a scratch directory that IS ours, entry by entry', () => {
    // NON-VACUITY. Every refusal below has to be a refusal about the thing it
    // names, not about a `discardScratch` that refuses everything.
    const b = bench()
    mkdirSync(b.temp, { mode: 0o700 })
    writeFileSync(join(b.temp, 'intent.json'), '{"complete":true}\n')
    chmodSync(join(b.temp, 'intent.json'), 0o400)
    chmodSync(b.temp, 0o500)
    expect(inspectScratch(b.input)).toBe('incomplete')
    expect(discardScratch(b.input, b.receipt())).toBe('discarded')
    expect(existsSync(b.temp)).toBe(false)
  }, 180_000)

  it('reports an absent scratch directory as absent, and removes nothing', () => {
    const b = bench()
    expect(inspectScratch(b.input)).toBe('absent')
    expect(discardScratch(b.input, b.receipt())).toBe('absent')
  })

  it('never removes a SYMLINK standing where the scratch directory would be', () => {
    // K1.5-B01. Following it would delete whatever it points at.
    const b = bench()
    const decoy = join(b.evidence, 'decoy')
    mkdirSync(decoy, { mode: 0o700 })
    writeFileSync(join(decoy, 'keep.txt'), 'keep\n')
    symlinkSync(decoy, b.temp)
    expect(inspectScratch(b.input)).toBe('foreign')
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    // THE LINK AND ITS TARGET BOTH SURVIVE.
    expect(existsSync(b.temp)).toBe(true)
    expect(readFileSync(join(decoy, 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('never removes a PUBLISHED directory, even asked under a scratch name', () => {
    // K1.5-B02. Identity, not name: a hard link would make one object answer to
    // two names, and a name comparison would miss it.
    const b = bench()
    const published = publishEvidence({
      root: b.evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }).finalPath
    // ASKED ABOUT THE PUBLISHED PATH ITSELF, by giving it as the scratch name.
    const asPublished: ScratchInput = { ...b.input, temporaryTag: undefined }
    // The untagged temporary name is NOT the final name, so this is absent...
    expect(discardScratch(asPublished, b.receipt())).toBe('absent')
    // ...and the published bundle is untouched and still verifies.
    expect(verifyPublishedEvidence(published).length).toBeGreaterThan(0)
  })

  it('never removes anything for a path outside the evidence root', () => {
    // K1.5-B03. The root is proved by `assertEvidenceRoot` before a name is even
    // derived, so a root that is not an owned 0700 directory refuses outright.
    const b = bench()
    const outside = join(b.evidence, '..', 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    expect(discardScratch({ ...b.input, root: join(b.evidence, 'nope') }, b.receipt())).toBe('refused-untouched')
    expect(discardScratch({ ...b.input, root: outside }, b.receipt())).toBe('refused-untouched')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('never removes a scratch directory holding something it did not build', () => {
    // K1.5-B04. `rmdir` fails on a directory that is not empty, and the only
    // entries this function will unlink are regular files it just lstat'ed. A
    // subdirectory nobody expected makes the removal FAIL rather than widen.
    const b = bench()
    mkdirSync(b.temp, { mode: 0o700 })
    mkdirSync(join(b.temp, 'unexpected'), { mode: 0o700 })
    writeFileSync(join(b.temp, 'unexpected', 'keep.txt'), 'keep\n')
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    expect(readFileSync(join(b.temp, 'unexpected', 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('refuses a WRONG NAME, a wrong device and an unreadable state', () => {
    // K1.5-B05. Each of the remaining guards, through the injectable ops - the
    // only way to make a device differ or an lstat fail on demand.
    const b = bench()
    mkdirSync(b.temp, { mode: 0o700 })
    writeFileSync(join(b.temp, 'intent.json'), '{"complete":true}\n')

    // WRONG NAME. A tag that is not the reviewed one cannot even be derived.
    expect(discardScratch({ ...b.input, temporaryTag: 'something-else' }, b.receipt())).toBe('refused-untouched')
    expect(inspectScratch({ ...b.input, temporaryTag: 'something-else' })).toBe('unproved')
    expect(existsSync(b.temp)).toBe(true)

    // WRONG DEVICE. The scratch directory answers with a device the root does not.
    const movedDevice: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((p: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(p as never, o) as unknown as
          Record<string, unknown>
        if (p === b.temp && o !== undefined) {
          return { ...st, dev: 999_999n, isDirectory: () => true,
                   isFile: () => false, isSymbolicLink: () => false }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(inspectScratch(b.input, movedDevice)).toBe('foreign')
    expect(discardScratch(b.input, b.receipt(), movedDevice)).toBe('refused-untouched')
    expect(existsSync(b.temp)).toBe(true)

    // WRONG OWNER.
    const otherOwner: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((p: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(p as never, o) as unknown as
          Record<string, unknown>
        if (p === b.temp && o !== undefined) {
          return { ...st, uid: 4_242n, isDirectory: () => true,
                   isFile: () => false, isSymbolicLink: () => false }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(inspectScratch(b.input, otherOwner)).toBe('foreign')
    expect(discardScratch(b.input, b.receipt(), otherOwner)).toBe('refused-untouched')
    expect(existsSync(b.temp)).toBe(true)

    // AN UNANSWERED QUESTION IS NOT AN ABSENT DIRECTORY. `EACCES`, not `ENOENT`.
    const unreadable: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((p: string, o?: never) => {
        if (p === b.temp) {
          const e = new Error('EACCES') as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        return REAL_EVIDENCE_OPS.lstatSync(p as never, o)
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(inspectScratch(b.input, unreadable)).toBe('unproved')
    expect(discardScratch(b.input, b.receipt(), unreadable)).toBe('refused-untouched')
    expect(existsSync(b.temp)).toBe(true)
  })

  it('never removes a directory that IS the published bundle, by identity', () => {
    // K1.5-B07. TWO NAMES CAN BE ONE OBJECT. The guard compares the scratch
    // directory's device:inode with the published path's, not their names, because
    // a name comparison misses an alias - and what follows a `true` here is a
    // removal of something that is already evidence.
    //
    // THE ALIAS IS INJECTED, because macOS will not hard-link a directory for an
    // ordinary user, so there is no way to build this condition with real syscalls.
    // The identity of the published bundle is read for real and then reported as
    // the scratch directory's own.
    const b = bench()
    const published = publishEvidence({
      root: b.evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }).finalPath
    mkdirSync(b.temp, { mode: 0o700 })
    const real = statSync(published, { bigint: true })
    const aliased: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
          Record<string, unknown>
        // THE SCRATCH PATH ANSWERS WITH THE PUBLISHED BUNDLE'S IDENTITY.
        if (pth === b.temp) {
          return { ...st, dev: real.dev, ino: real.ino, uid: real.uid,
                   isDirectory: () => true, isFile: () => false,
                   isSymbolicLink: () => false }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    // NON-VACUITY: without the alias this directory IS ours and would be cleared.
    expect(discardScratch(b.input, b.receipt())).toBe('discarded')
    mkdirSync(b.temp, { mode: 0o700 })
    expect(inspectScratch(b.input, aliased)).toBe('foreign')
    expect(discardScratch(b.input, b.receipt(), aliased)).toBe('refused-untouched')
    // AND THE PUBLISHED BUNDLE IS UNTOUCHED.
    expect(verifyPublishedEvidence(published).length).toBeGreaterThan(0)
    expect(existsSync(b.temp)).toBe(true)
  })

  it('names exactly two temporary directories per record, and no counter', () => {
    // K1.5-B06. The bound, in the names themselves.
    expect(EVIDENCE_RETRY_SCRATCH).toBe('retry')
    const untagged = evidenceNames(INTENT_PREFIX, STAMP, 'abcdef01')
    const retry = evidenceNames(INTENT_PREFIX, STAMP, 'abcdef01', EVIDENCE_RETRY_SCRATCH)
    expect(untagged.temporaryName).toBe(`.tmp-${INTENT_PREFIX}-abcdef01`)
    expect(retry.temporaryName).toBe(`.tmp-${INTENT_PREFIX}-abcdef01-retry`)
    // THE FINAL NAME NEVER MOVES.
    expect(retry.finalName).toBe(untagged.finalName)
    // AND THERE IS NO NUMBERED SCHEME LEFT: a digit tag is not a reviewed name.
    for (const bad of ['1', '2', '12', '0', 'r1', 'RETRY', '']) {
      expect(() => evidenceNames(INTENT_PREFIX, STAMP, 'abcdef01', bad),
             JSON.stringify(bad)).toThrow()
    }
    // THE PUBLICATION PATH NAMES NO ORDINAL EITHER. Executable text only.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const durable = src.slice(src.indexOf('async function publishDurable'),
                              src.indexOf('async function publishPhase'))
    expect(durable.length).toBeGreaterThan(400)
    expect(durable).not.toContain('ordinal')
    expect(durable).not.toContain('String(ordinal.value)')
    expect(durable).toContain('choosePublication(')
  })
})

// ---------------------------------------------------------------------------
// K1.5.1 CONTROLS
// ---------------------------------------------------------------------------

describe('K1.5.1: scratch cleanup proves the whole tree before it touches any of it', () => {
  /** An evidence root, the reviewed scratch input, and a snapshot helper. */
  const bench = (): {
    evidence: string
    input: ScratchInput
    temp: string
    build: () => void
    snapshot: () => string
    receipt: () => string | null
  } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(root)
    const evidence = join(root, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    chmodSync(evidence, 0o700)
    const input: ScratchInput = {
      root: evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      temporaryTag: EVIDENCE_RETRY_SCRATCH,
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }
    const temp = join(evidence, `.tmp-${INTENT_PREFIX}-abcdef01-${EVIDENCE_RETRY_SCRATCH}`)
    /**
     * THE RECEIPT FOR A TREE THIS TEST ITSELF MADE.
     *
     * Read after the directory exists, which is the only honest way for a test to
     * hold one: the production path gets it from the publisher's own `mkdir`, and
     * a test that built the directory is entitled to the same claim.
     */
    const receipt = (): string | null => {
      try {
        const st = statSync(temp, { bigint: true })
        return `${String(st.dev)}:${String(st.ino)}`
      } catch { return null }
    }
    /** A half-built tree: the reviewed entries, frozen, and no DIGEST. */
    const build = (): void => {
      mkdirSync(temp, { mode: 0o700 })
      chmodSync(temp, 0o700)
      for (const [name, text] of [['intent.json', '{"complete":true}\n'],
                                  ['actions.json', '{}\n']] as const) {
        writeFileSync(join(temp, name), text, { mode: 0o600 })
        chmodSync(join(temp, name), 0o400)
      }
    }
    /**
     * EVERYTHING A REFUSAL MUST LEAVE ALONE, in one comparable string: the
     * directory's mode, every entry's name, mode, size and device:inode.
     */
    const snapshot = (): string => {
      const lines: string[] = []
      const walk = (abs: string, rel: string): void => {
        const st = statSync(abs, { bigint: true })
        lines.push(`${rel || '.'} mode=${String(st.mode & 0o7777n)} ` +
                   `id=${String(st.dev)}:${String(st.ino)} size=${String(st.size)}`)
        if (!st.isDirectory()) return
        for (const n of readdirSync(abs).sort()) walk(join(abs, n), rel === '' ? n : `${rel}/${n}`)
      }
      try { walk(temp, '') } catch { lines.push('ABSENT') }
      return lines.join('\n')
    }
    return { evidence, input, temp, build, snapshot, receipt }
  }

  it('clears a validated half-built tree, bottom-up', () => {
    // NON-VACUITY for every refusal below: this is the tree they are variations of.
    const b = bench()
    b.build()
    expect(inspectScratch(b.input)).toBe('incomplete')
    expect(discardScratch(b.input, b.receipt())).toBe('discarded')
    expect(existsSync(b.temp)).toBe(false)
  })

  it('refuses a SYMLINK under an expected name, and unlink would have removed it',
    () => {
      // K1.5.1-C01. THE CONTROL THAT WAS MISSING, and the reason Q14 was not an
      // equivalent mutant. `unlink` refuses a DIRECTORY; it removes a symlink
      // perfectly happily. So the entry-type check is the only thing standing
      // between a planted link and its deletion - and what the link names tells you
      // what somebody wanted deleted.
      const b = bench()
      mkdirSync(b.temp, { mode: 0o700 })
      const target = join(b.evidence, 'precious')
      mkdirSync(target, { mode: 0o700 })
      writeFileSync(join(target, 'keep.txt'), 'keep\n')
      // UNDER AN ALLOWED NAME, AND AT A PERMITTED MODE, so nothing but the type
      // check can refuse it.
      //
      // WITHOUT THE MODE, THIS CONTROL TESTS THE WRONG THING. A symlink's own mode
      // is 0755, which the file-mode check refuses - so the control passed even with
      // the type discrimination removed, and the mutation matrix reported the type
      // check as unkillable. `chmod -h` sets the LINK's mode rather than its
      // target's, which is what makes the type gate the only thing left.
      symlinkSync(target, join(b.temp, 'intent.json'))
      execFileSync('/bin/chmod', ['-h', '400', join(b.temp, 'intent.json')])
      const before = b.snapshot()
      expect(inspectScratch(b.input)).toBe('incomplete')
      expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
      // NOTHING CHANGED, AND THE LINK IS STILL THERE.
      expect(b.snapshot()).toBe(before)
      expect(lstatSync(join(b.temp, 'intent.json')).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep\n')
    })

  it('refuses a FIFO under an expected name, which unlink also removes', () => {
    // K1.5.1-C02. A FIFO is not a directory either, so `unlink` removes it. Same
    // class of defect as the symlink, different node type - and `isFile()` is false
    // for both, which is exactly what the check tests.
    const b = bench()
    mkdirSync(b.temp, { mode: 0o700 })
    execFileSync('/usr/bin/mkfifo', [join(b.temp, 'actions.json')])
    // A PERMITTED MODE, for the same reason as the symlink above: otherwise the
    // mode check refuses it and the type check is never the thing under test.
    chmodSync(join(b.temp, 'actions.json'), 0o400)
    const before = b.snapshot()
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    expect(b.snapshot()).toBe(before)
    expect(existsSync(join(b.temp, 'actions.json'))).toBe(true)
  })

  it('refuses an injected non-regular entry that is neither file nor directory', () => {
    // K1.5.1-C03. A socket or a device node, through the injectable ops - the one
    // way to present a node type a test cannot create.
    const b = bench()
    b.build()
    const before = b.snapshot()
    const asSocket: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
          Record<string, unknown>
        if (pth === join(b.temp, 'actions.json')) {
          return { ...st, isFile: () => false, isDirectory: () => false,
                   isSymbolicLink: () => false, isSocket: () => true }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(discardScratch(b.input, b.receipt(), asSocket)).toBe('refused-untouched')
    expect(b.snapshot()).toBe(before)
  })

  it('refuses an UNEXPECTED REGULAR FILE, which no type check would catch', () => {
    // K1.5.1-C04. A regular file passes every type and ownership test there is.
    // What refuses it is the allow-list derived from the artifacts, the manifest
    // and DIGEST - and a scratch directory holding bytes this record did not write
    // is not this record's scratch directory.
    const b = bench()
    b.build()
    writeFileSync(join(b.temp, 'notes.txt'), 'somebody else\n', { mode: 0o600 })
    const before = b.snapshot()
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    expect(b.snapshot()).toBe(before)
    expect(readFileSync(join(b.temp, 'notes.txt'), 'utf-8')).toBe('somebody else\n')
  })

  it('refuses a LATE unexpected directory with the valid entries untouched', () => {
    // K1.5.1-C05. THE ORDERING IS THE POINT. The two valid entries are walked
    // first; the offending directory is found last. The previous version had
    // already chmod'ed the scratch root and unlinked both files by the time it got
    // there, and then returned "refused" - a refusal that had already destroyed
    // what it was refusing to touch.
    const b = bench()
    b.build()
    // 'zz-late' sorts after both reviewed names, so it is reached last.
    mkdirSync(join(b.temp, 'zz-late'), { mode: 0o700 })
    writeFileSync(join(b.temp, 'zz-late', 'keep.txt'), 'keep\n')
    const before = b.snapshot()
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    // BOTH VALID ENTRIES SURVIVE, the directory's mode is unchanged, and so is
    // every identity and every byte.
    expect(b.snapshot()).toBe(before)
    expect(existsSync(join(b.temp, 'intent.json'))).toBe(true)
    expect(existsSync(join(b.temp, 'actions.json'))).toBe(true)
    expect((statSync(b.temp).mode & 0o777)).toBe(0o700)
    expect(readFileSync(join(b.temp, 'zz-late', 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('refuses a frozen tree without unfreezing it first', () => {
    // K1.5.1-C06. A frozen scratch directory is 0500, and making it writable is the
    // one mutation removal needs - so a refusal must happen BEFORE that. Here the
    // tree is frozen and carries an unexpected file: the mode must come back
    // unchanged, which it cannot if the chmod happened during the walk.
    const b = bench()
    b.build()
    writeFileSync(join(b.temp, 'notes.txt'), 'x\n', { mode: 0o600 })
    chmodSync(b.temp, 0o500)
    const before = b.snapshot()
    expect(discardScratch(b.input, b.receipt())).toBe('refused-untouched')
    expect(b.snapshot()).toBe(before)
    expect((statSync(b.temp).mode & 0o777)).toBe(0o500)
  })

  it('refuses a node whose type is wrong at PREFLIGHT, even if it looks right later',
    () => {
      // K1.5.1-C13. THE PHASE-1 GATE, ON ITS OWN. The type is checked twice - once
      // while planning and once immediately before removal - and for a real symlink
      // or FIFO either check alone prevents the harm, so neither can be pinned by a
      // fixture built from real filesystem objects.
      //
      // This one separates them: the node reports a SYMLINK to the preflight and a
      // regular file to everything after it. Only the preflight gate can refuse
      // that, and with it gone the file is unlinked.
      const b = bench()
      b.build()
      let seen = 0
      const linkAtPreflight: EvidenceOps = {
        ...REAL_EVIDENCE_OPS,
        lstatSync: ((pth: string, o?: never) => {
          const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
            Record<string, unknown>
          if (pth === join(b.temp, 'actions.json')) {
            seen += 1
            const link = seen === 1
            return { ...st, isSymbolicLink: () => link, isFile: () => !link,
                     isDirectory: () => false }
          }
          return st
        }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
      }
      expect(discardScratch(b.input, b.receipt(), linkAtPreflight)).toBe('refused-untouched')
      expect(existsSync(join(b.temp, 'actions.json'))).toBe(true)
    })

  it('re-proves each node TYPE immediately before removing it', () => {
    // K1.5.1-C12. The identity is not the only thing re-checked: a path that was a
    // regular file when it was planned and is something else by the time it is
    // removed must not be removed. Phase 1 sees a regular file; phase 2 is told it
    // is not one.
    const b = bench()
    b.build()
    let seen = 0
    const retyped: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
          Record<string, unknown> & { isFile: () => boolean }
        if (pth === join(b.temp, 'actions.json')) {
          seen += 1
          if (seen > 1) {
            return { ...st, isFile: () => false, isDirectory: () => false,
                     isSymbolicLink: () => false }
          }
          return { ...st, isFile: () => true, isDirectory: () => false,
                   isSymbolicLink: () => false }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(discardScratch(b.input, b.receipt(), retyped)).toBe('refused-untouched')
    expect(existsSync(join(b.temp, 'actions.json'))).toBe(true)
  })

  it('re-proves each node immediately before removing it', () => {
    // K1.5.1-C07. The identity captured while planning is compared again at the
    // moment of removal, so a node swapped for another object between the two
    // phases is not the node that gets removed.
    const b = bench()
    b.build()
    let planned = 0
    const swapped: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
          Record<string, unknown>
        // THE FIRST READS ARE THE PLAN; a later read of the same file reports a
        // different inode, as a swap would.
        if (pth === join(b.temp, 'actions.json')) {
          planned += 1
          // THE TYPE METHODS ARE CARRIED OVER DELIBERATELY. `{...stats}` drops
          // them - they live on the prototype - and a stat with no `isFile` makes
          // the caller throw, which the caller catches as a refusal. This control
          // passed that way for a while: refusing for a TypeError, not for the
          // identity mismatch it claims to be about. Found by mutation testing,
          // which reported the identity check as unkillable.
          if (planned > 1) {
            return { ...st, ino: 987_654_321n,
                     isFile: () => true, isDirectory: () => false,
                     isSymbolicLink: () => false }
          }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(discardScratch(b.input, b.receipt(), swapped)).toBe('refused-untouched')
    // THE FILE IS STILL THERE: the removal did not proceed on a changed identity.
    expect(existsSync(join(b.temp, 'actions.json'))).toBe(true)
  })
}, 120_000)

describe('K1.5.1: only a scratch directory this process created may be cleared', () => {
  it('preserves a pre-existing incomplete retry scratch it did not create', async () => {
    // K1.5.1-C08. "Same owner, same device" is true of every directory this user
    // has ever left anywhere - including the retry scratch of an EARLIER run of
    // this same command against this same record, which is somebody's
    // evidence-in-progress or somebody's diagnostic wreckage and not this
    // process's to delete.
    //
    // THE CHILD FINDS ONE ALREADY THERE, planted before the hold begins under the
    // exact reviewed name, owned by this user, on this device, half-built. It must
    // be preserved and the hold must keep holding.
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      // A FREEZE FAILURE, NOT A RENAME FAILURE. A rename-only failure leaves the
      // UNTAGGED directory complete and re-renames it for ever, so the retry
      // scratch is never consulted and a planted one is never even looked at - the
      // control would have passed without testing anything. Measured: it did.
      ops: { failRename: 'intervention-outcome', failures: 0, failFileChmod: true },
      plantRetryScratch: 'intervention-outcome',
    }, { wallClockMs: 20_000, maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    // IT WAS NEVER CLEARED: the planted marker is in every census sample, and the
    // directory count never grows past the two reviewed names.
    const census = r.report.scratchCensus
    expect(census.length).toBeGreaterThan(3)
    for (const s of census.slice(2)) {
      expect(s.temporaryNames, `attempt ${s.attempt}`)
        .toContain(`.tmp-${OUTCOME_PREFIX}-${RUN_ID}-${EVIDENCE_RETRY_SCRATCH}`)
      expect(s.temporaryDirs, `attempt ${s.attempt}`).toBeLessThanOrEqual(2)
    }
    // AND THE PLANTED BYTES ARE STILL THERE, untouched, at the end.
    expect(r.report.plantedSurvived).toBe(true)
    // ONE DECISION, ONE OPERATION, and it kept holding rather than deleting.
    expect(r.report.requests.length).toBe(1)
    expect(r.report.performed).toBe(1)
  }, 180_000)
}, 240_000)

describe('K1.5.1: retained publication proves completeness for itself', () => {
  const bench = (): { evidence: string; input: ScratchInput; temp: string; final: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(root)
    const evidence = join(root, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    chmodSync(evidence, 0o700)
    const input: ScratchInput = {
      root: evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      temporaryTag: EVIDENCE_RETRY_SCRATCH,
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }
    return {
      evidence, input,
      temp: join(evidence, `.tmp-${INTENT_PREFIX}-abcdef01-${EVIDENCE_RETRY_SCRATCH}`),
      final: join(evidence, `${INTENT_PREFIX}-${STAMP}-abcdef01`),
    }
  }

  /** Build a COMPLETE scratch tree the way the publisher does, minus the rename. */
  const complete = (b: ReturnType<typeof bench>): void => {
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      renameNoReplace: () => 'failed',
    }
    expect(() => publishEvidence({
      root: b.evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      temporaryTag: EVIDENCE_RETRY_SCRATCH,
      artifacts: b.input.artifacts, manifest: b.input.manifest,
    }, ops)).toThrow()
  }

  it('publishes a complete retained directory under the original final name', () => {
    // NON-VACUITY: the refusals below are about completeness, not about a path that
    // could never publish.
    const b = bench()
    complete(b)
    expect(inspectScratch(b.input)).toBe('complete')
    const published = publishRetainedScratch(b.input)
    expect(published.finalPath).toBe(b.final)
    expect(verifyPublishedEvidence(b.final).length).toBeGreaterThan(0)
    expect(existsSync(b.temp)).toBe(false)
  })

  it('refuses an INCOMPLETE scratch and leaves the final path absent', () => {
    // K1.5.1-C09. Called DIRECTLY, with no prior caller-side inspection. The one
    // mutation this function performs turns a directory into published, immutable
    // evidence, so it proves for itself what it is about to publish.
    // A COMPLETE TREE WITH ONE FILE TAKEN AWAY, so it still carries a DIGEST.
    //
    // WHY THAT MATTERS. A tree with no DIGEST is refused by the digest read a line
    // later, which would mask the self-check entirely - measured: the mutation
    // removing the self-check survived this control until the fixture kept its
    // DIGEST. Now the ONLY thing that refuses is the completeness proof.
    const b = bench()
    complete(b)
    execFileSync('/bin/chmod', ['-R', 'u+rwX', b.temp])
    rmSync(join(b.temp, 'actions.json'))
    expect(existsSync(join(b.temp, 'DIGEST'))).toBe(true)
    expect(inspectScratch(b.input)).toBe('incomplete')
    expect(() => publishRetainedScratch(b.input)).toThrow(EvidenceRefused)
    expect(existsSync(b.final)).toBe(false)
    // AND THE SCRATCH DIRECTORY IS STILL THERE, unrenamed.
    expect(existsSync(b.temp)).toBe(true)
  })

  it('refuses an ALTERED complete scratch and leaves the final path absent', () => {
    // K1.5.1-C10. Byte-for-byte: a tree that verified a moment ago and has since
    // been edited is not the record, and publishing it would make somebody else's
    // bytes this run's evidence.
    const b = bench()
    complete(b)
    execFileSync('/bin/chmod', ['-R', 'u+rwX', b.temp])
    writeFileSync(join(b.temp, 'actions.json'), '{"tampered":true}\n')
    chmodSync(join(b.temp, 'actions.json'), 0o400)
    expect(inspectScratch(b.input)).toBe('incomplete')
    expect(() => publishRetainedScratch(b.input)).toThrow(EvidenceRefused)
    expect(existsSync(b.final)).toBe(false)
  })

  it('refuses a FOREIGN scratch directory and leaves the final path absent', () => {
    // K1.5.1-C11. A symlink where the scratch directory should be.
    const b = bench()
    const decoy = join(b.evidence, 'decoy')
    mkdirSync(decoy, { mode: 0o700 })
    symlinkSync(decoy, b.temp)
    expect(inspectScratch(b.input)).toBe('foreign')
    expect(() => publishRetainedScratch(b.input)).toThrow(EvidenceRefused)
    expect(existsSync(b.final)).toBe(false)
    expect(lstatSync(b.temp).isSymbolicLink()).toBe(true)
  })
}, 120_000)

// ---------------------------------------------------------------------------
// K1.5.2 CONTROLS
// ---------------------------------------------------------------------------

describe('K1.5.2: the creation receipt comes from the publisher, not from a guess', () => {
  /** An evidence root and the reviewed scratch input for one record in it. */
  const bench = (): { evidence: string; input: ScratchInput; temp: string; final: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
    ROOTS.push(root)
    const evidence = join(root, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    chmodSync(evidence, 0o700)
    const input: ScratchInput = {
      root: evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
      temporaryTag: EVIDENCE_RETRY_SCRATCH,
      artifacts: [{ path: 'actions.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: 'intent.json', bytes: Buffer.from('{"complete":true}\n', 'utf-8') },
    }
    return {
      evidence, input,
      temp: join(evidence, `.tmp-${INTENT_PREFIX}-abcdef01-${EVIDENCE_RETRY_SCRATCH}`),
      final: join(evidence, `${INTENT_PREFIX}-${STAMP}-abcdef01`),
    }
  }

  /** Publish with the rename broken, so the scratch directory is retained. */
  const publishFailing = (b: ReturnType<typeof bench>, over: Partial<EvidenceOps> = {}):
  LifecycleEvidenceFailed => {
    try {
      publishLifecycleBundle({
        root: b.evidence, prefix: INTENT_PREFIX, stamp: STAMP, runId: 'abcdef01',
        temporaryTag: EVIDENCE_RETRY_SCRATCH,
        manifestFile: 'intent.json', detailFile: 'actions.json',
        manifest: { complete: true } as never, detail: {} as never,
        ops: { ...REAL_EVIDENCE_OPS, renameNoReplace: () => 'failed', ...over },
      })
    } catch (e) {
      if (e instanceof LifecycleEvidenceFailed) return e
      throw e
    }
    throw new Error('the publication was expected to fail')
  }

  /** Mode, entries, bytes and identities of a tree, as one comparable string. */
  const snapshotOf = (root: string): string => {
    const lines: string[] = []
    const walk = (abs: string, rel: string): void => {
      const st = statSync(abs, { bigint: true })
      lines.push(`${rel || '.'} mode=${String(st.mode & 0o7777n)} ` +
                 `id=${String(st.dev)}:${String(st.ino)} size=${String(st.size)}`)
      if (!st.isDirectory()) return
      for (const n of readdirSync(abs).sort()) walk(join(abs, n), rel === '' ? n : `${rel}/${n}`)
    }
    try { walk(root, '') } catch { lines.push('ABSENT') }
    return lines.join('\n')
  }

  const identityOf = (path: string): string | null => {
    try {
      const st = statSync(path, { bigint: true })
      return `${String(st.dev)}:${String(st.ino)}`
    } catch { return null }
  }

  it('propagates the EXACT identity of the directory its own mkdir created', () => {
    // K1.5.2-C01 (required test 3). The publisher's `mkdir` succeeded and a later
    // step failed, so the receipt names precisely the object it made - and it is
    // the caller's only permission to clear that object.
    const b = bench()
    const failure = publishFailing(b)
    expect(failure.publication).toBe('retained-temporary')
    expect(failure.creationReceipt).not.toBeNull()
    expect(failure.creationReceipt).toBe(identityOf(b.temp))
    // AND IT IS THE RECEIPT THAT LETS THE TREE BE CLEARED.
    expect(discardScratch(b.input, failure.creationReceipt)).toBe('discarded')
    expect(existsSync(b.temp)).toBe(false)
  })

  it('issues NO receipt when a directory appeared before the publisher’s mkdir', () => {
    // K1.5.2-C02 (required tests 1 and 2). THE RACE THIS ORDER IS ABOUT. A caller
    // that observed the path absent and then stat'ed it in its catch block would
    // adopt whatever turned up in between - which is the one directory it must never
    // delete. Here something is already there when `mkdir` runs: it fails with
    // EEXIST, which is a failure BEFORE the creation, so no receipt is issued.
    const b = bench()
    mkdirSync(b.temp, { mode: 0o700 })
    writeFileSync(join(b.temp, 'intent.json'), 'somebody else\n', { mode: 0o600 })
    const failure = publishFailing(b)
    expect(failure.creationReceipt).toBeNull()
    // AND WITHOUT A RECEIPT NOTHING IS CLEARED, even though the directory is this
    // user's, on this device, under the exact reviewed name, and incomplete.
    expect(inspectScratch(b.input)).toBe('incomplete')
    expect(discardScratch(b.input, failure.creationReceipt)).toBe('refused-untouched')
    expect(readFileSync(join(b.temp, 'intent.json'), 'utf-8')).toBe('somebody else\n')
  })

  it('refuses a root replaced between the preflight and the first mutation', () => {
    // K1.5.2-C03 (required tests 4 and 5). The receipt names an object, not a name.
    // A root swapped after it was validated is a different object under the same
    // name, and the re-check immediately before the first chmod is what notices.
    const b = bench()
    const failure = publishFailing(b)
    const real = failure.creationReceipt
    expect(real).not.toBeNull()
    // A RECEIPT FOR SOMETHING ELSE is the same situation from the other side.
    expect(discardScratch(b.input, '1:999999999')).toBe('refused-untouched')
    expect(existsSync(b.temp)).toBe(true)
    // AND A ROOT WHOSE IDENTITY CHANGES between the preflight and phase two.
    let reads = 0
    const replaced: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        const st = REAL_EVIDENCE_OPS.lstatSync(pth as never, o) as unknown as
          Record<string, unknown> & { ino: bigint }
        // THE LAST READ BEFORE PHASE TWO reports a different object.
        if (pth === b.temp && o !== undefined) {
          reads += 1
          if (reads > 2) {
            return { ...st, ino: 123_456_789n, isDirectory: () => true,
                     isFile: () => false, isSymbolicLink: () => false }
          }
        }
        return st
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(discardScratch(b.input, real, replaced)).toBe('refused-untouched')
    expect(existsSync(join(b.temp, 'intent.json'))).toBe(true)
  })

  it('keeps holding when the receipt cannot be examined at all', async () => {
    // K1.5.2-C04 (required test 6). A receipt that cannot be read is not a
    // resolution: nothing is removed, nothing throws out of the hold, and the fence
    // stays exactly where it is.
    const b = bench()
    const failure = publishFailing(b)
    const blind: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        if (pth === b.temp) {
          const e = new Error('EIO') as NodeJS.ErrnoException
          e.code = 'EIO'
          throw e
        }
        return REAL_EVIDENCE_OPS.lstatSync(pth as never, o)
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    expect(() => discardScratch(b.input, failure.creationReceipt, blind)).not.toThrow()
    expect(discardScratch(b.input, failure.creationReceipt, blind)).toBe('refused-untouched')
    expect(existsSync(b.temp)).toBe(true)

    // AND IN THE HOLD ITSELF: a publication whose receipt never arrives keeps
    // holding rather than unwinding, and performs exactly once.
    const r = await runContained({
      supervisor: { releaseError: true },
      prover: { kind: 'locks-until', resolveAfter: 0 },
      hold: { kind: 'script', actions: ['CENSUS_ONLY'] },
      ops: { failRename: 'intervention-outcome', failures: 0, failFileChmod: true },
      plantRetryScratch: 'intervention-outcome',
    }, { wallClockMs: 20_000, maxBundles: 12 })
    expect(r.outcome).toBe('killed')
    expect(r.report.requests.length).toBe(1)
    expect(r.report.performed).toBe(1)
    expect(r.report.plantedSurvived).toBe(true)
  }, 180_000)

  it('refuses untouched when the receipt-comparison probe itself throws', () => {
    // K1.5.2.1-C01. `pathIdentity` REFUSES rather than guesses when a path cannot be
    // examined, and the receipt comparison called it with no catch - so a single EIO
    // on that one lstat threw straight out of `discardScratch` and out of the hold.
    // A filesystem error on a probe is not a reason to unwind a held fence.
    //
    // THE FIXTURE IS ORDERED SO THE PROBE IS WHAT FAILS. `scratchIsOurs` reads the
    // scratch root first and must SUCCEED; only the next bigint read of that same
    // path - the receipt probe - throws. Both facts are asserted, so this cannot
    // pass by refusing somewhere earlier.
    const b = bench()
    const failure = publishFailing(b)
    const receipt = failure.creationReceipt
    expect(receipt).not.toBeNull()
    const before = snapshotOf(b.temp)

    let bigintReads = 0
    let ownershipRead = false
    const probeThrows: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((pth: string, o?: never) => {
        if (pth === b.temp && o !== undefined) {
          bigintReads += 1
          // 1 and 2 belong to `scratchIsOurs` (the root, then the evidence root);
          // the probe is the next read of the scratch root.
          if (bigintReads === 1) ownershipRead = true
          if (bigintReads === 2) {
            const e = new Error('EIO') as NodeJS.ErrnoException
            e.code = 'EIO'
            throw e
          }
        }
        return REAL_EVIDENCE_OPS.lstatSync(pth as never, o)
      }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
    }
    // NOTHING THROWS OUT.
    let outcome: string | null = null
    expect(() => { outcome = discardScratch(b.input, receipt, probeThrows) }).not.toThrow()
    // THE OWNERSHIP READ SUCCEEDED FIRST, so the refusal is the probe's.
    expect(ownershipRead).toBe(true)
    expect(bigintReads).toBeGreaterThanOrEqual(2)
    expect(outcome).toBe('refused-untouched')
    // AND NOTHING MOVED: mode, entries, bytes and identities all as they were.
    expect(snapshotOf(b.temp)).toBe(before)
  })

  it('reports partial-or-unknown when a later unlink fails, never "untouched"', () => {
    // K1.5.2-C05 (required test 7). THE TRUTHFULNESS REQUIREMENT. Once one `unlink`
    // has returned, those bytes are gone; a multi-entry deletion cannot be rolled
    // back. Reporting that as a refusal tells an operator nothing was removed while
    // something was.
    const b = bench()
    const failure = publishFailing(b)
    let unlinks = 0
    const secondFails: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      unlinkSync: ((pth: string) => {
        unlinks += 1
        if (unlinks === 2) {
          const e = new Error('EIO') as NodeJS.ErrnoException
          e.code = 'EIO'
          throw e
        }
        return REAL_EVIDENCE_OPS.unlinkSync(pth as never)
      }) as unknown as typeof REAL_EVIDENCE_OPS.unlinkSync,
    }
    const outcome = discardScratch(b.input, failure.creationReceipt, secondFails)
    expect(outcome).toBe('partial-or-unknown')
    // THE FIRST ENTRY IS GONE AND THE REST IS STILL THERE: neither state this
    // could honestly call "untouched".
    expect(unlinks).toBe(2)
    expect(existsSync(b.temp)).toBe(true)
    expect(readdirSync(b.temp).length).toBeGreaterThan(0)
  })

  it('never says "Nothing was removed" for a partial cleanup', () => {
    // K1.5.2-C06. The wording is asserted on the executable text, because the
    // untruthful sentence and the truthful one live one branch apart.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const choose = src.slice(src.indexOf('function choosePublication'))
    const body = choose.slice(0, choose.indexOf('\n}\n'))
    expect(body.length).toBeGreaterThan(400)
    // THE FOUR OUTCOMES ARE DISTINGUISHED.
    expect(body).toContain("cleanup === 'refused-untouched'")
    expect(body).toContain("cleanup === 'partial-or-unknown'")
    // AND ONLY THE UNTOUCHED BRANCH CLAIMS NOTHING WAS REMOVED.
    const untouched = body.slice(body.indexOf("cleanup === 'refused-untouched'"),
                                 body.indexOf("cleanup === 'partial-or-unknown'"))
    // THE PARTIAL BRANCH ONLY, up to its own `return`. Slicing to the end of the
    // function would swallow the `foreign`/`unproved` message, which says "Nothing
    // was removed or created" and is TRUE of that outcome - a different branch
    // making a different claim about a different situation.
    const fromPartial = body.slice(body.indexOf("cleanup === 'partial-or-unknown'"))
    const partial = fromPartial.slice(0, fromPartial.indexOf('return null') + 11)
    expect(untouched).toContain('Nothing was removed')
    expect(partial.length).toBeGreaterThan(80)
    expect(partial).not.toContain('Nothing was removed')
    expect(partial).toContain('PARTIALLY removed')
    // AND THE OTHER BRANCH'S CLAIM IS STILL THE TRUE ONE for its own outcome.
    expect(body).toContain('Nothing was removed or created')
  })

  it('mints the receipt without letting an unreadable inode fail the publication',
    () => {
      // K1.5.2-C08 (required test 6, the minting half), BEHAVIOURAL.
      //
      // A receipt is a permission, and NOT having one is a perfectly good answer: it
      // means no later cleanup may touch that directory. So an inode that cannot be
      // read at mint time must leave the receipt null and let the publication carry
      // on to fail for its REAL reason.
      //
      // THE FIRST READ ONLY. `pathIdentity` is called once, immediately after
      // `mkdir`; failing only that read and letting later reads succeed is what makes
      // the guard's effect visible. WITH the guard the publication continues and
      // writes the whole scratch tree before the injected rename failure stops it.
      // WITHOUT it, `pathIdentity` throws where it is called - one line after the
      // `mkdir` - and the directory is left EMPTY. That is the difference this
      // asserts, and it needs no source text at all.
      const b = bench()
      let identityReads = 0
      const blindFirstRead: EvidenceOps = {
        ...REAL_EVIDENCE_OPS,
        renameNoReplace: () => 'failed',
        lstatSync: ((pth: string, o?: never) => {
          // `pathIdentity` is the only bigint lstat of the scratch root at this
          // point, so this is precisely the receipt probe.
          if (pth === b.temp && o !== undefined) {
            identityReads += 1
            if (identityReads === 1) {
              const e = new Error('EIO') as NodeJS.ErrnoException
              e.code = 'EIO'
              throw e
            }
          }
          return REAL_EVIDENCE_OPS.lstatSync(pth as never, o)
        }) as unknown as typeof REAL_EVIDENCE_OPS.lstatSync,
      }
      const failure = publishFailing(b, blindFirstRead)
      // THE PROBE REALLY RAN, so this is not vacuous.
      expect(identityReads).toBeGreaterThanOrEqual(1)
      // NO RECEIPT, so nothing may be cleared.
      expect(failure.creationReceipt).toBeNull()
      expect(discardScratch(b.input, failure.creationReceipt)).toBe('refused-untouched')
      // THE PUBLICATION GOT PAST MINTING: the whole expected scratch file set is on
      // disk, which only happens if the artifacts, the manifest and DIGEST were all
      // written after the failed probe.
      expect(readdirSync(b.temp).sort()).toEqual(['DIGEST', 'actions.json', 'intent.json'])
      // AND THE FAILURE REPORTED IS THE LATER, INJECTED ONE - the rename - not the
      // probe.
      expect(failure.publication).toBe('retained-temporary')
      expect(failure.evidencePhase).toBe('publish')
    })

  it('takes the receipt from the publisher and never mints one by statting', () => {
    // K1.5.2-C07. The defect this order names: inferring creation from an earlier
    // absence plus a later stat of a predictable path. Asserted on executable text
    // because the absence of a re-derivation is not otherwise observable.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const durable = src.slice(src.indexOf('async function publishDurable'),
                              src.indexOf('async function publishPhase'))
    expect(durable.length).toBeGreaterThan(400)
    // THE RECEIPT COMES OFF THE ERROR.
    expect(durable).toContain('e.creationReceipt')
    expect(durable).toContain('scratch.retryReceipt = e.creationReceipt')
    // AND NOTHING IN THE PUBLICATION PATH STATS A TEMPORARY NAME TO INVENT ONE.
    expect(durable).not.toContain('pathIdentity(')
    expect(src.slice(src.indexOf('function choosePublication'))).not.toContain('pathIdentity(')
    // THE CLEANUP REQUIRES IT, and the caller's own check is not the authority.
    expect(src).toContain('discardScratch(retry, scratch.retryReceipt, ops)')
  })
}, 240_000)

describe('K8-E3: the operator can see the question they are being asked', () => {
  /**
   * CONTAINED, AND NOT OPTIONALLY SO.
   *
   * These two cases drive the PRODUCTION `holdForIntervention` through the
   * production `processHold`, with only its transport injected. A Vitest worker
   * cannot host that: the hold is unbounded by design, and a `testTimeout`
   * abandons the promise while the loop keeps running - see `support/contained.ts`.
   * K8-E2 tried it in-process twice and wedged the worker both times.
   */
  const snapshotAt = (r: ContainedResult, n: number): {
    sinkLength: number; hadIntervention: boolean; hadFenceState: boolean
    hadReplyWith: boolean; tokenFromSink: string | null; replied: string
  } => {
    const snaps = r.report.channelSnapshots
    expect(snaps.length, 'the operator was never asked').toBeGreaterThan(n)
    return snaps[n] as never
  }

  it('T1 a rehearse hold shows its prompt and token before it waits', async () => {
    // A queue that is only non-empty under the fence: the gate refuses while the
    // source is frozen, which is a hold and not an exit-2 refusal.
    const r = await contained({
      fencedQueueBusy: REVIEWED_QUEUES[0] as string,
      prover: { kind: 'gone-after-first-decision' },
      hold: { kind: 'channel', actions: ['CENSUS_ONLY'] },
    })
    const evidence = evidenceOf(r)

    // THE RUN COMPLETED, AND THE HOLD RESOLVED.
    expect(r.report.exitCode).toBe(EXIT_INTERVENTION_RESOLVED)

    // AND AT THE FIRST PROMPT THE OPERATOR COULD ALREADY SEE ALL THREE LINES.
    const first = snapshotAt(r, 0)
    expect(first.hadIntervention).toBe(true)
    expect(first.hadFenceState).toBe(true)
    expect(first.hadReplyWith).toBe(true)
    expect(first.sinkLength).toBeGreaterThan(0)

    // THE REASON NAMES THE QUEUE REFUSAL.
    const reason = r.report.sink.find(l => l.includes('INTERVENTION REQUIRED')) ?? ''
    expect(reason.toLowerCase()).toMatch(/queue|depth|not empty|drain/)

    // THE REVIEWED OPERATIONS FOR A HELD FENCE, verbatim.
    expect(r.report.sink).toContain(
      `FENCE STATE: held. Reviewed operations: ${HOLD_ACTIONS.held.join(', ')}`)

    // THE TOKEN REPLIED WITH IS THE ONE ON THAT LINE, and the one the hold minted.
    expect(first.tokenFromSink).toMatch(/^PGCOPY-RESOLVE-[0-9a-f]+$/)
    expect(first.replied).toBe(`CENSUS_ONLY k8-operator ${first.tokenFromSink ?? ''}`)
    // The token on the streamed line is the one the reply carried. `report.requests`
    // is deliberately NOT used here: it is the scripted resolver's record, and a
    // `channel` case runs the production hold instead.
    const onLine = /(PGCOPY-RESOLVE-[0-9a-f]+)/.exec(
      r.report.sink.find(l => l.includes('Reply with: <OPERATION>')) ?? '')
    expect(onLine?.[1]).toBe(first.tokenFromSink)

    // WHAT WAS STREAMED IS WHAT WAS RETURNED, exactly once each.
    expect(r.report.sink).toEqual([...r.report.lines])
    expect(new Set(r.report.sink).size).toBe(r.report.sink.length)

    // AND THE ATTEMPT IS ON DISK, intent then outcome, with the chosen action.
    expect(bundles(evidence, INTENT_PREFIX).length).toBe(1)
    expect(bundles(evidence, OUTCOME_PREFIX).length).toBe(1)
    const intent = manifestOf(
      join(evidence, allBundles(evidence, INTENT_PREFIX)[0] as string), 'intent.json')
    expect((intent as { chosen_action?: unknown }).chosen_action).toBe('CENSUS_ONLY')
  })

  it('T2 a rehearse hold for an unstopped producer is a hold, not a refusal', async () => {
    // A producer somebody started during the window: quiescent before the fence,
    // running once it is held, found by the gate's own census.
    const r = await contained({
      producerRunningUnderFence: REVIEWED_PRODUCERS[0] as string,
      prover: { kind: 'gone-after-first-decision' },
      hold: { kind: 'channel', actions: ['CENSUS_ONLY'] },
    })

    // A HOLD WAS ENTERED. If this is 2 the code refused instead of holding, and
    // that is a code defect to report rather than a test to adjust.
    expect(r.report.exitCode, `refused instead of holding: ${r.report.lines.join(' | ')}`)
      .not.toBe(EXIT_REFUSED)
    expect(r.report.channelSnapshots.length).toBeGreaterThan(0)

    const first = snapshotAt(r, 0)
    expect(first.hadIntervention).toBe(true)
    expect(first.hadFenceState).toBe(true)
    expect(first.hadReplyWith).toBe(true)
    expect(first.tokenFromSink).toMatch(/^PGCOPY-RESOLVE-[0-9a-f]+$/)
    expect(r.report.sink).toEqual([...r.report.lines])
  })
})

describe('K8-E3 T5: every mode returns exactly what it streamed', () => {
  /**
   * DRIVEN DOWN THE SUCCESS PATHS, which is what the K8-E2 version failed to do.
   *
   * That version called `base(w, [mode, …])` with no `--run-id`, so both modes
   * were refused at `runOf` (pg-copy-ops.ts:2950) before a single mode line was
   * said - and a sink that matches an empty mode is vacuous. Four of the five
   * dispatch arms were therefore unpinned. These use the suite's own
   * `restoreArgs` and `reviewArgs`, which supply the run identity.
   */
  it('--verify-restoration and --review-rehearsal stream what they return', async () => {
    const w = await ready()
    const token = await tokenFor(w, 'rehearse', deps(w))
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)

    // --verify-restoration, down its success path.
    const restoreSink: string[] = []
    const restore = await runOpsCli(
      restoreArgs(w), deps(w, { sink: (l: string) => { restoreSink.push(l) } }))
    expect(restore.exitCode, restore.lines.join('\n')).toBe(EXIT_OK)
    expect(restoreSink).toEqual([...restore.lines])
    // A LINE SAID INSIDE THE MODE (pg-copy-ops.ts:3768), exactly once.
    const restoreSaid = restoreSink.filter(l => l.startsWith('producer restoration published '))
    expect(restoreSaid).toHaveLength(1)

    // --review-rehearsal, down its success path.
    const reviewSink: string[] = []
    const review = await runOpsCli(
      reviewArgs(w), deps(w, { sink: (l: string) => { reviewSink.push(l) } }))
    expect(review.exitCode, review.lines.join('\n')).toBe(EXIT_OK)
    expect(reviewSink).toEqual([...review.lines])
    // A LINE SAID INSIDE THE MODE (pg-copy-ops.ts:4507), exactly once.
    const reviewSaid = reviewSink.filter(l => l.startsWith('rehearsal review published '))
    expect(reviewSaid).toHaveLength(1)
    expect(reviewSink.filter(l => l.startsWith('An apply may now reference'))).toHaveLength(1)
  })
})

describe('K8-E5 R1: a terminal signal under the fence cannot release it', () => {
  /**
   * THE WINDOW THIS CASE IS ABOUT.
   *
   * `--apply` has always armed its held-signal lease before Stage 1, because
   * from that moment a fence may exist. `--rehearse` armed only inside an
   * intervention hold - so between `acquire` returning a fence and either the
   * release being proved or a hold arming, no handler was installed. A Ctrl-C or
   * a window close in that window reaches node, which is in the terminal's
   * foreground group, and node dies on the default action. `detached: true` keeps
   * the signal off the psql child but not the consequence: the child's stdin is a
   * pipe only node writes, so node's death closes it, psql reads EOF, and the
   * backend takes the fence with it.
   *
   * NOTHING IS INJECTED. No `hold` and no `operatorChannel`, so the production
   * `processHold` is built over the production `operatorChannel` - the only
   * object that installs real handlers. A case that injected the transport would
   * replace the thing under test and pass against any tree.
   *
   * WHAT IT CANNOT SHOW. There is no real psql in this harness; the sessions are
   * stubs. That the psql CHILD survives a group signal is E4's D1/D2, and the
   * two halves together are the property. This case owns the parent's half.
   */
  it('survives SIGINT and SIGHUP taken between acquire and the gate, and still releases itself',
     async () => {
    const r = await contained({
      hold: { kind: 'production' },
      signalSelfWhenFenced: ['SIGINT', 'SIGHUP'],
    })

    // BOTH SIGNALS WERE ACTUALLY DELIVERED, to this child's own pid, at the fence.
    expect(r.report.selfSignalsSent).toEqual(['SIGINT', 'SIGHUP'])

    // THE LEASE WAS ALREADY IN PLACE WHEN THE FENCE CAME INTO EXISTENCE. This is
    // the direct observation: on the pre-change tree it is 0 and the process dies.
    expect(r.report.sigintListenersAtFence).not.toBeNull()
    expect(r.report.sigintListenersAtFence as number).toBeGreaterThanOrEqual(1)

    // IT DID NOT EXIT EARLY. Reaching exit 4 at all means the process outlived
    // both signals and finished its own release.
    expect(r.report.exitCode, r.report.lines.join(' | ')).toBe(EXIT_ACTION_REQUIRED)

    // AND IT SAID SO, ONCE PER SIGNAL, rather than dying quietly.
    const ignored = r.report.sink.filter(l => l.includes('IGNORED: this process is holding'))
    expect(ignored).toHaveLength(2)
    expect(ignored.some(l => l.startsWith('SIGINT '))).toBe(true)
    expect(ignored.some(l => l.startsWith('SIGHUP '))).toBe(true)

    // THE FENCE WAS RELEASED BY THE RUN, NOT BY THE SIGNAL: the success bundle
    // exists, which is published only after the release is proved.
    const evidence = evidenceOf(r)
    expect(bundles(evidence, REHEARSAL_PREFIX).length).toBe(1)
    // And no hold was ever entered, so nothing was published for one.
    expect(bundles(evidence, INTENT_PREFIX).length).toBe(0)
    expect(bundles(evidence, OUTCOME_PREFIX).length).toBe(0)
  })
})

describe('K8-E5 R2: a dead operator channel publishes once, then holds quietly', () => {
  /**
   * WHAT THE OLD LOOP DID. Once stdin has hit EOF, every attempt fails at once in
   * `nextLine`. Each one minted a token nobody could read, published an outcome
   * bundle, slept five seconds and asked again - about twelve bundles a minute,
   * for as long as the process lived, into the production evidence root, with no
   * resolution path and no bound.
   *
   * THE RUN NEVER RETURNS, AND MUST NOT. Returning is what releases the fence. So
   * this case is read from the child's progress file and ends at its container's
   * wall clock, which is the established shape for a hold that is correct to be
   * unbounded. The injected clock is parked after four idle periods so the case
   * measures the code rather than how fast the harness can spin.
   */
  it('publishes exactly one outcome, no intent, and never asks or publishes again',
     async () => {
    const r = await runContained({
      // A queue that is only non-empty under the fence: the gate refuses while
      // the source is frozen, which is a hold rather than an exit-2 refusal.
      fencedQueueBusy: REVIEWED_QUEUES[0] as string,
      prover: { kind: 'locks-until', resolveAfter: -1 },
      hold: { kind: 'dead-channel' },
      recordSleeps: true,
      parkAfterIdleSleeps: 4,
    }, { wallClockMs: 12_000 })

    // THE CEILING THAT STOPPED IT WAS THE CLOCK, NOT A FLOOD. K8-E6 makes this
    // the first assertion: a mutant that publishes per attempt trips the bundle
    // or byte ceiling instead, and "killed" alone does not tell them apart.
    expect(r.ceiling, r.stderr).toBe('wall-clock')
    expect(r.outcome, `${r.ceiling ?? 'no ceiling'}: ${r.stderr}`).toBe('killed')

    // AND EXACTLY ONE ATTEMPT WAS EVER MADE. The sink is flushed synchronously,
    // so this COUNTS a flood rather than sampling for one.
    const attempts = r.report.sink.filter(l => /^ATTEMPT \d+:/.test(l))
    expect(attempts, r.report.sink.join(' | ')).toHaveLength(1)

    expect(r.report.exitCode).toBeNull()

    expect(r.report.evidence, r.stderr).not.toBeNull()

    // READ FROM THE CHILD'S OWN RECORD, NOT FROM DISK. A container that kills a
    // run removes its roots on the way out (contained.ts:365), so by the time
    // this assertion runs the evidence directory is gone. `evidenceEntries` is
    // flushed as it changes, which is why it exists.
    const entries = r.report.evidenceEntries
    const named = (prefix: string): readonly string[] =>
      entries.filter(e => e.startsWith(`${prefix}-`))

    // EXACTLY ONE OUTCOME, AND NO INTENT. The outcome for the failed attempt is
    // owed and is written; `decision` stayed null, so no intent was.
    expect(named(OUTCOME_PREFIX), entries.join(', ')).toHaveLength(1)
    expect(named(INTENT_PREFIX), entries.join(', ')).toHaveLength(0)

    // AND STILL ONE AFTER SEVERAL IDLE PERIODS have gone by.
    expect(r.report.deadChannelIdleSleeps).toBeGreaterThanOrEqual(3)

    // THE RETRY PACE IS GONE. Nothing slept the asking interval, and nothing said
    // it was about to ask again.
    expect(r.report.sleeps.filter(ms => ms === HOLD_RETRY_INTERVAL_MS)).toHaveLength(0)
    expect(r.report.sink.filter(l => l.includes('before asking again'))).toHaveLength(0)
    expect(r.report.sleeps.filter(ms => ms === DEAD_CHANNEL_IDLE_MS).length)
      .toBeGreaterThanOrEqual(3)

    // THE OPERATOR WAS TOLD, ONCE, WHAT IS TRUE AND WHAT TO DO ABOUT IT.
    const dead = r.report.sink.filter(l => l.startsWith('THE OPERATOR CHANNEL IS DEAD'))
    expect(dead).toHaveLength(1)
    expect(r.report.sink.filter(l => l.includes('kill -9'))).toHaveLength(1)
    expect(r.report.sink.filter(l => l.includes('publish nothing further'))).toHaveLength(1)

    // AND THE FENCE WAS NEVER RELEASED: the supervisor is still open.
    expect(r.report.supervisorClosed).toBe(0)
    // AND THE CONTAINER, NOT A VITEST TIMEOUT, IS WHAT STOPPED IT. A test
    // timeout would reject this case and abandon the promise while the child
    // went on holding (contained.ts:105-113), so the ceiling below is set well
    // above the container's own.
  }, 120_000)
})

describe('K8-E6: the PRODUCTION transport classifies a dead stdin', () => {
  /**
   * WHY THESE EXIST, WHEN R2 ALREADY COVERS THE QUIET HOLD.
   *
   * R2 injects a transport whose `nextLine` throws `OperatorChannelDead`
   * directly, so it proves what the HOLD does with that class and nothing about
   * which conditions actually raise it. The production `operatorChannel.nextLine`
   * raises it at three sites - no TTY, the readline iterator rejecting, and the
   * iterator reporting `done` - and the hold goes quiet only on
   * `e instanceof OperatorChannelDead`. Reverting any one of those three to a
   * plain `OpsRefused` would restore the five-second publish-and-retry flood with
   * every other test still green. Round 45 found that gap; these three close it,
   * one per site, against the real transport.
   *
   * All three are contained: they reach a real hold, and two of them replace
   * `process.stdin`, neither of which may happen in a Vitest worker.
   */
  const deadChannelScenario = {
    // A queue that is only non-empty under the fence: the gate refuses while the
    // source is frozen, which is a hold rather than an exit-2 refusal.
    fencedQueueBusy: REVIEWED_QUEUES[0] as string,
    prover: { kind: 'locks-until' as const, resolveAfter: -1 },
    recordSleeps: true,
    parkAfterIdleSleeps: 4,
  }

  /** Everything that must hold however the channel died. */
  const assertQuietHold = (r: ContainedResult, reasonFragment: string): void => {
    expect(r.ceiling, r.stderr).toBe('wall-clock')
    expect(r.outcome, `${r.ceiling ?? 'no ceiling'}: ${r.stderr}`).toBe('killed')

    // ONE ATTEMPT, AND ITS REASON NAMES THE SITE THAT RAISED THE CLASS.
    const attempts = r.report.sink.filter(l => /^ATTEMPT \d+:/.test(l))
    expect(attempts, r.report.sink.join(' | ')).toHaveLength(1)
    expect(attempts[0] as string).toContain(reasonFragment)

    // ONE OUTCOME, NO INTENT. Read from the child's own record: a killed
    // container removes the roots on its way out (contained.ts:365).
    const entries = r.report.evidenceEntries
    const named = (prefix: string): readonly string[] =>
      entries.filter(e => e.startsWith(`${prefix}-`))
    expect(named(OUTCOME_PREFIX), entries.join(', ')).toHaveLength(1)
    expect(named(INTENT_PREFIX), entries.join(', ')).toHaveLength(0)

    // SEVERAL IDLE PERIODS PASSED AND NOTHING CHANGED.
    expect(r.report.deadChannelIdleSleeps).toBeGreaterThanOrEqual(3)
    expect(r.report.sleeps.filter(ms => ms === HOLD_RETRY_INTERVAL_MS)).toHaveLength(0)
    expect(r.report.sink.filter(l => l.includes('before asking again'))).toHaveLength(0)
    expect(r.report.sleeps.filter(ms => ms === DEAD_CHANNEL_IDLE_MS).length)
      .toBeGreaterThanOrEqual(3)

    // THE OPERATOR WAS TOLD ONCE, and the fence was never released.
    expect(r.report.sink.filter(l => l.startsWith('THE OPERATOR CHANNEL IS DEAD')))
      .toHaveLength(1)
    expect(r.report.sink.filter(l => l.includes('kill -9'))).toHaveLength(1)
    expect(r.report.supervisorClosed).toBe(0)
  }

  it('R2a no terminal: the no-TTY site raises it, end to end', async () => {
    // The contained child's stdin is 'ignore' (contained.ts:297), so the real
    // `operatorChannel.nextLine` takes its no-TTY branch. Nothing is injected.
    const r = await runContained({
      ...deadChannelScenario,
      hold: { kind: 'production' },
    }, { wallClockMs: 12_000 })
    assertQuietHold(r, 'no terminal and no --resolution-file')
  }, 120_000)

  it('R2b EOF: the iterator reporting done raises it', async () => {
    // A stand-in stdin with isTTY true gets past the no-TTY branch and into the
    // readline iterator; `end()` once the read is in flight resolves it `done`.
    const r = await runContained({
      ...deadChannelScenario,
      hold: { kind: 'production' },
      stdinStandIn: 'eof',
    }, { wallClockMs: 12_000 })
    expect(r.report.stdinStandInEnded, r.stderr).toBe('end()')
    assertQuietHold(r, 'closed before a line arrived')
  }, 120_000)

  it('R2c stream error: the iterator rejecting raises it', async () => {
    // Same stand-in, destroyed with an Error instead, which rejects the iterator.
    const r = await runContained({
      ...deadChannelScenario,
      hold: { kind: 'production' },
      stdinStandIn: 'error',
    }, { wallClockMs: 12_000 })
    expect(r.report.stdinStandInEnded, r.stderr).toBe('destroy(Error)')
    assertQuietHold(r, 'errored before a line arrived')
  }, 120_000)
})

describe('K8-E7 R1b: the lease holds the parent, and the psql child is in another group',
         () => {
  /**
   * WHAT THIS CASE PROVES, AND WHAT IT DOES NOT.
   *
   * It proves three things. The parent declines SIGINT and SIGHUP sent to ITS OWN
   * pid while the rehearsal lease is armed, and goes on to finish its own release.
   * The psql child opened by the production `openPsqlBackend` is still alive
   * afterwards and sits in a DIFFERENT process group from the parent, with a null
   * pgid failing loudly rather than passing vacuously. And releasing the fence
   * ends that child at EOF rather than killing it.
   *
   * IT PROVES NOTHING ABOUT TERMINAL GROUP DELIVERY, and an earlier version of
   * this comment claimed it did. The signals here go to a single pid, and a
   * pid-directed signal cannot reach a child whatever group the child is in - so
   * the child's survival here is not evidence that `detached` works. What it
   * establishes is the MEMBERSHIP that makes `detached` matter, measured on a
   * real backend rather than argued from the source.
   *
   * THE GROUP-SIGNAL PROOF IS D2, in
   * `packages/db/tests/pg-copy-psql-backend-group.test.ts:233-240`: that case
   * signals the fixture parent's whole process group, which is what a TTY driver
   * does, and asserts the psql child is still alive afterwards. MG1 kills it when
   * `detached` is removed.
   *
   * R1 AND R1b ARE COMPLEMENTARY, not one inside the other. R1 runs the same
   * fenced-signal scenario with stub sessions and no psql at all, and checks
   * things this case does not: that exactly one `operational-rehearsal-*` bundle
   * was published, and that no intervention intent or outcome was. This case adds
   * a real backend and says what happened to it. Neither replaces the other.
   */
  it('declines SIGINT and SIGHUP to its own pid, keeps the psql child, '
     + 'and ends it at EOF on release',
     async () => {
    const r = await runContained({
      hold: { kind: 'production' },
      signalSelfWhenFenced: ['SIGINT', 'SIGHUP'],
      fakePsqlAtFence: true,
    })

    // FIRST: THE psql CHILD IS STILL THERE after the parent declined the signals.
    // Not because it was out of their reach - a pid-directed signal never had any
    // reach - but because the parent survived to RECORD it. The field starts null
    // (hold-child.ts:206) and is only ever assigned 100 ms after the child signals
    // itself (hold-child.ts:884). A parent that died on the signal never reaches
    // that line, so the field stays null and `toBe(true)` fails on null. It is not
    // an EOF story: nothing here observes the fake reading EOF.
    expect(r.report.fakePsqlAliveAfterSignals,
           `fake pid ${String(r.report.fakePsqlPid)}; ${r.stderr}`).toBe(true)

    // THE RUN FINISHED ON ITS OWN. Not killed, not crashed.
    expect(r.outcome, `${r.ceiling ?? 'no ceiling'}: ${r.stderr}`).toBe('completed')

    // AND IT LED ITS OWN PROCESS GROUP. This is the MEMBERSHIP that makes a
    // terminal-generated signal miss it; whether it actually does is D2's
    // subject, not this one's. A null pgid fails rather than passing vacuously.
    expect(r.report.fakePsqlPid).not.toBeNull()
    expect(r.report.fakePsqlPgid, 'the psql child has no process group: it is gone')
      .not.toBeNull()
    expect(r.report.childPgid, 'the contained child has no process group').not.toBeNull()
    expect(r.report.fakePsqlPgid).toBe(r.report.fakePsqlPid)
    expect(r.report.fakePsqlPgid).not.toBe(r.report.childPgid)

    // THE PARENT HALF, WHICH THIS CASE NEEDS IN ITS OWN RIGHT. Without these the
    // line above would be luck: the signals have to have been sent, the lease has
    // to have been armed when the fence came into existence, the handlers have to
    // have run, and the process has to have reached its own exit 4. These are not
    // a copy of R1's checks for their own sake - they are what makes "the child is
    // still alive" mean "the parent kept it alive".
    expect(r.report.selfSignalsSent).toEqual(['SIGINT', 'SIGHUP'])
    expect(r.report.sigintListenersAtFence as number).toBeGreaterThanOrEqual(1)
    expect(r.report.exitCode, r.report.lines.join(' | ')).toBe(EXIT_ACTION_REQUIRED)
    const ignored = r.report.sink.filter(l => l.includes('IGNORED: this process is holding'))
    expect(ignored).toHaveLength(2)

    // THE SUPERVISOR'S CLOSE ENDED IT GRACEFULLY: the fake wrote its EOF marker
    // before the run returned, so it was not killed.
    expect(r.report.fakePsqlExitedAtEof, 'the fake did not exit at EOF').toBe(true)

    // AND IT IS GONE. Bounded wait; nothing is signalled unless its command line
    // proves it is ours, and then the case fails anyway.
    const pid = r.report.fakePsqlPid as number
    const alive = (): boolean => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    const deadline = Date.now() + 10_000
    while (alive() && Date.now() < deadline) {
      await new Promise<void>(res => { setTimeout(res, 25) })
    }
    if (alive()) {
      let line = ''
      try {
        line = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)],
                            { encoding: 'utf-8' })
      } catch { line = '' }
      if (line.includes(r.report.fakePsqlRoot ?? '\u0000no-root')) {
        try { process.kill(pid, 'SIGKILL') } catch { /* raced us */ }
      }
      expect.fail(`the fake psql outlived the run: ${line.trim()}`)
    }
  }, 120_000)
})
