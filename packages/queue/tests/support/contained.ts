// THE CONTAINER: the only thing that may end a hold.
//
// WHAT THIS IS FOR. `holdForIntervention` never returns while the fence may be
// held, and that is the property under test, not a defect. So a suite that
// exercises it cannot also be the thing that stops it: the stopper has to be
// able to remove the process, and only something outside the process can.
//
// WHY NOT THE OBVIOUS THINGS.
//   - `Promise.race` ends the AWAIT. The hold loop keeps publishing.
//   - Vitest's `testTimeout` fails the TEST. The worker keeps publishing.
//   - `afterEach` runs after the await returned, which it never does.
//   - SIGTERM is HELD: the hold arms handlers for SIGINT, SIGTERM, SIGHUP and
//     SIGQUIT that deliberately do not exit, because exiting is what would
//     release the fence.
// Only SIGKILL to the child's own process group ends it, and only a different
// process can send it.
//
// WHAT IS POLICED, AND WHY EACH ONE. A hold that will not end fails in three
// different ways depending on what is wrong:
//   WALL CLOCK  - the loop is alive and pausing;
//   BUNDLE COUNT - the loop is alive and publishing (this is the one that filled
//                  a 103 GB volume: two bundles per iteration, unbounded);
//   BYTES        - a single publication is enormous even if there are few.
// Any one of them is enough to kill, because each is already outside anything a
// reviewed case does.
//
// WHAT IS KILLED, AND WHAT IS REMOVED. Exactly the process group this function
// spawned - never a pid it was handed, never a pattern match over the process
// table - and exactly the roots that child reported, which is why the child
// reports them before it publishes anything into them. Nothing else on the
// machine is touched.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
         statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

import { ROOTS, ROOT_PREFIX } from './ops-world.js'
import { realTmp, removeProvedRoot } from './roots.js'
import type { HoldReport, HoldSpec } from './hold-spec.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `tests/support` -> the queue package -> the workspace root. */
const QUEUE_PKG = join(HERE, '..', '..')
const WORKSPACE = join(QUEUE_PKG, '..', '..')
const TSX = join(WORKSPACE, 'node_modules', '.bin', 'tsx')
const CHILD = join(HERE, 'hold-child.ts')

/**
 * THE REVIEWED CEILINGS.
 *
 * Generous against what a reviewed case does and tiny against a runaway. The
 * worst reviewed case here publishes under a dozen bundles and finishes in a few
 * seconds; the incident published thousands and ran until the volume was full.
 */
export const CONTAINED_WALL_CLOCK_MS = 45_000
export const CONTAINED_MAX_BUNDLES = 40
export const CONTAINED_MAX_BYTES = 32 * 1024 * 1024

export type ContainedCeiling = 'wall-clock' | 'bundle-count' | 'bytes'

export interface ContainedResult {
  /**
   * `completed` - the child wrote its result and exited on its own.
   * `killed`    - a ceiling was breached and the process group was SIGKILLed.
   * `crashed`   - the child exited without writing a result.
   */
  readonly outcome: 'completed' | 'killed' | 'crashed'
  readonly ceiling: ContainedCeiling | null
  /**
   * WHAT THE CHILD OBSERVED, whether or not it finished.
   *
   * The child rewrites this on every event, so a run the container had to kill
   * still reports how many times the operator was asked and how many operations
   * ran - which is precisely what those cases assert. A killed run's `exitCode`
   * is null, because it never produced one.
   */
  readonly report: HoldReport
  /** The roots the child reported. EMPTY after a kill: they were removed. */
  readonly roots: readonly string[]
  readonly stderr: string
}

/**
 * The report a child that never got as far as reporting anything leaves.
 *
 * EVERY KEY `HoldReport` DECLARES, and K8-E11 is where that became true again.
 * This literal had not grown a key since it was written, so from K8-E3's `sink`
 * onwards it did not satisfy the interface - and nothing noticed, because
 * `packages/queue/tsconfig.json` includes only `src/**` and `bin/**` and so no
 * queue test file is ever compiled. An explicit `tsc` over these files reported
 * it as its one error in this file; it is fixed here rather than carried further.
 *
 * The values say "the child did not get this far", which is what the absence
 * means: empty lists, null scalars, zero counts. A case that wants to know
 * whether something was really observed asks about the thing itself - `exitCode`
 * is null for a killed child, `fakePsqlAliveAfterSignals` is null when the child
 * never reached the line that records it - rather than reading a zero here as
 * evidence.
 */
const NOTHING_OBSERVED: HoldReport = Object.freeze({
  exitCode: null, lines: Object.freeze([]), root: null, evidence: null,
  supervisorSql: Object.freeze([]), supervisorClosed: 0,
  proverSql: Object.freeze([]), proverClosed: 0, armed: 0, disarmed: 0,
  requests: Object.freeze([]), order: Object.freeze([]),
  evidenceAtPerform: Object.freeze([]), performed: 0, sleeps: Object.freeze([]),
  unscripted: null, renames: 0, plantedSurvived: null, holdStartedAt: null,
  scratchCensus: Object.freeze([]),
  evidenceEntries: Object.freeze([]), publishAttempts: 0,
  sink: Object.freeze([]), channelSnapshots: Object.freeze([]),
  sigintListenersAtFence: null, selfSignalsSent: Object.freeze([]),
  deadChannelIdleSleeps: 0,
  fakePsqlPid: null, fakePsqlPgid: null, childPgid: null,
  fakePsqlAliveAfterSignals: null, fakePsqlExitedAtEof: null,
  stdinStandInEnded: null, fakePsqlRoot: null,
  resolutionFilePath: null, resolutionWritten: null, resolutionPolls: 0,
  sigintListenersAtPoll: Object.freeze([]), pollsAtReplyLine: Object.freeze([]),
  replyTokens: Object.freeze([]), resolutionInodes: Object.freeze([]),
})

let containedSeq = 0

/**
 * EVERY CHILD THIS MODULE HAS SPAWNED AND NOT YET SEEN EXIT.
 *
 * WHY A REGISTRY AND NOT JUST THE POLLING LOOP. The loop below is the primary
 * enforcement and it works - but it only runs while somebody is awaiting
 * `runContained`. A Vitest `testTimeout` REJECTS THE TEST AND ABANDONS THE
 * PROMISE: the loop stops being driven, the ceilings stop being checked, and the
 * detached child goes on holding its fence and writing to its root. Two orphaned
 * children and eighteen abandoned roots is what that looked like, measured, when
 * the full suite ran these cases at its default five-second timeout.
 *
 * So the group is recorded the moment it exists, and `killContainedChildren` -
 * which the suite's `afterEach` calls, and which runs even after a timeout -
 * removes anything still alive. The ceilings remain the mechanism; this is the
 * backstop for the case where nothing is left to enforce them.
 */
const LIVE_CHILDREN = new Map<number, { control: string; prefix: string }>()

/**
 * EVERY DIRECTORY UNDER ONE CHILD'S OWN PREFIX, removed.
 *
 * WHY NOT JUST WHAT THE CHILD REPORTED. The child flushes its roots to disk and
 * the parent removes those - which is correct and is what proves the container
 * only ever removes directories a child claimed. But the report is written by a
 * process that is about to be SIGKILLed, and a kill that lands between
 * `mkdtemp` and the flush leaves a directory nobody has been told about. Six of
 * them, measured, after a full-suite run.
 *
 * THE PREFIX IS THE SAFETY PROPERTY, NOT THE REPORT. `pgcopy-modes-<parent
 * pid>-c<n>-` is minted by this function for exactly one child and handed to it
 * in its environment, so nothing else on the machine can create a directory with
 * it. Sweeping it is therefore a superset of what that child reported and a
 * subset of what that child could possibly have made.
 */
function sweepChildPrefix(prefix: string): void {
  let names: string[] = []
  try {
    names = readdirSync(realTmp())
      // THE CONTROL DIRECTORY IS NOT THE CHILD'S. It is this function's own, it
      // holds the report and the roots file that are still being read, and the
      // suite's `afterEach` removes it - which it cannot do if this took it first.
      .filter(n => n.startsWith(prefix) && !n.startsWith(`${prefix}ctl`))
  } catch { return }
  removeRoots(names.map(n => join(realTmp(), n)))
}

/**
 * SIGKILL every child group this module still has, and say which.
 *
 * Called from `afterEach`, so a test that was abandoned mid-run still cannot
 * leave a hold running. Returns the control directories of the children it had
 * to kill, so the caller can name what happened rather than clean up silently.
 */
export function killContainedChildren(): readonly string[] {
  const killed: string[] = []
  for (const [pid, { control, prefix }] of LIVE_CHILDREN) {
    let wasAlive = false
    try {
      process.kill(-pid, 'SIGKILL')
      wasAlive = true
    } catch { /* already gone */ }
    // AND REMOVE WHAT IT MADE, which nothing else will: an abandoned run never
    // reaches its own cleanup, so its directories survive it. Its report is
    // honoured first and then its whole private prefix is swept, because a
    // process being killed may not have finished reporting.
    try { removeRoots(readRoots(join(control, 'roots'))) } catch { /* swept below */ }
    try { sweepChildPrefix(prefix) } catch { /* reported by the residue check */ }
    if (wasAlive) killed.push(control)
  }
  LIVE_CHILDREN.clear()
  return killed
}

const sizeOf = (path: string): number => {
  let total = 0
  const walk = (p: string): void => {
    let st
    try { st = statSync(p) } catch { return }
    if (st.isDirectory()) {
      let names: string[] = []
      try { names = readdirSync(p) } catch { return }
      for (const n of names) walk(join(p, n))
      return
    }
    total += st.size
  }
  walk(path)
  return total
}

const bundleCount = (root: string): number => {
  try { return readdirSync(join(root, 'evidence')).length } catch { return 0 }
}

const readRoots = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf-8').split('\n').filter(l => l.length > 0)
  } catch { return [] }
}

/**
 * ABSENT IS NOT THE SAME AS UNREADABLE, and only one of them means "nothing
 * was observed".
 *
 * A file that is not there yet is an ordinary state: the child has not reached
 * its first publication, and `NOTHING_OBSERVED` is the truthful answer. A file
 * that IS there and cannot be parsed is not an observation of nothing - it is a
 * failure to observe, and answering it with an empty report silently converts
 * every verdict drawn from that report into a wrong one. It reads as a hold that
 * recorded no request and performed no operation, which is precisely the claim
 * these cases exist to test, so the container must not be able to manufacture it.
 *
 * With publication made atomic on the child side this is now unreachable; that
 * is the reason to fail closed on it rather than the reason to keep tolerating
 * it, since anything that reaches here again is a defect in the container and
 * must say so rather than be absorbed into a plausible-looking result.
 */
const readReport = (file: string): HoldReport => {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return NOTHING_OBSERVED
    throw e
  }
  try {
    return JSON.parse(raw) as HoldReport
  } catch {
    throw new Error(
      `a contained child's report exists but could not be read as one: ${file} (${raw.length} bytes)`,
    )
  }
}

/** The same reader the container uses, exposed so its refusal can be proved. */
export const readReportForTest = readReport

/**
 * UNFREEZE AND REMOVE, and only these paths.
 *
 * Published evidence is frozen 0500/0400 on purpose, so a plain recursive remove
 * cannot descend into it. The freeze is the property under test, not an obstacle:
 * what created these directories unfreezes them, and nothing else is touched.
 *
 * TWO GUARDS, NOT ONE. The prefix check says the path is something THIS container
 * handed to THIS child, which nothing else on the machine can have created; and
 * `removeProvedRoot` then re-proves, independently, that the path is a real
 * directory directly beneath the real temporary directory, under the reviewed
 * name, owned by this user. The second is what makes a substituted or symlinked
 * path a refusal rather than a deletion, and the unfreeze happens only after it.
 */
function removeRoots(roots: readonly string[]): void {
  for (const r of roots) {
    if (!r.startsWith(join(realTmp(), ROOT_PREFIX))) {
      throw new Error(`a contained child reported a root outside its own prefix: ${r}`)
    }
    if (!existsSync(r)) continue
    removeProvedRoot(r)
  }
}

/**
 * Run one hold-capable scenario in its own process group, under ceilings.
 *
 * NEVER THROWS FOR A BREACH. The caller asserts on the outcome, because for some
 * cases being killed IS the expected result - a hold that ended by itself would
 * be the defect - and for the rest it is the failure. Making the distinction the
 * caller's assertion is what lets each case name what it expected.
 */
export async function runContained(spec: HoldSpec, over: {
  wallClockMs?: number
  maxBundles?: number
  maxBytes?: number
} = {}): Promise<ContainedResult> {
  const wallClockMs = over.wallClockMs ?? CONTAINED_WALL_CLOCK_MS
  const maxBundles = over.maxBundles ?? CONTAINED_MAX_BUNDLES
  const maxBytes = over.maxBytes ?? CONTAINED_MAX_BYTES

  containedSeq += 1
  // THE CHILD'S PREFIX IS THIS PROCESS'S PREFIX, EXTENDED, so every directory it
  // creates is attributable to this test run and is caught by the suite's own
  // residue check even if this function never sees it.
  const childPrefix = `${ROOT_PREFIX}c${String(containedSeq)}-`
  const control = mkdtempSync(join(realTmp(), `${childPrefix}ctl`))
  ROOTS.push(control)
  mkdirSync(control, { recursive: true })
  const specPath = join(control, 'spec.json')
  writeFileSync(specPath, `${JSON.stringify(spec)}\n`)
  const rootsFile = join(control, 'roots')
  const progressFile = join(control, 'progress')
  const resultFile = join(control, 'result')

  const child = spawn(TSX, [CHILD, specPath, control], {
    cwd: QUEUE_PKG,
    // ITS OWN PROCESS GROUP. `detached` is what makes `kill(-pid)` mean "this
    // child and anything it started", and nothing else.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PGCOPY_MODES_ROOT_PREFIX: childPrefix,
      // THE CHILD'S OWN CEILINGS, DERIVED FROM THESE AND DELIBERATELY HIGHER.
      //
      // The parent is the primary enforcement and must keep winning, so that an
      // ordinary contained run is still killed here and still reports which
      // ceiling it breached - the verdict every case asserts on. The child's are
      // the backstop for the run where this process no longer exists to enforce
      // anything, so they only have to be finite, and being looser makes them
      // invisible whenever a parent survives.
      PGCOPY_MODES_CHILD_WALL_CLOCK_MS: String(wallClockMs * 2 + 60_000),
      PGCOPY_MODES_CHILD_MAX_BUNDLES: String(maxBundles * 2),
      PGCOPY_MODES_CHILD_MAX_BYTES: String(maxBytes * 2),
    },
  })
  const pid = child.pid as number
  LIVE_CHILDREN.set(pid, { control, prefix: childPrefix })
  let stderr = ''
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8') })
  child.stdout.on('data', () => undefined)

  let exited = false
  let exitCode: number | null = null
  const ended = new Promise<void>(resolve => {
    child.on('exit', code => {
      exited = true; exitCode = code; LIVE_CHILDREN.delete(pid); resolve()
    })
    child.on('error', () => { exited = true; LIVE_CHILDREN.delete(pid); resolve() })
  })

  const started = Date.now()
  let breach: ContainedCeiling | null = null
  let roots: string[] = []

  for (;;) {
    if (existsSync(resultFile)) break
    if (exited) break
    roots = readRoots(rootsFile)
    // THE CLOCK STARTS WHEN THE HOLD DOES, and only falls back to `spawn` while the
    // child has not reached one. Everything before the hold - two sessions, the
    // operational gate, a release attempt - is variable and gets slower the busier
    // the machine is, so a ceiling measured from spawn is partly a measurement of
    // load. That made controls asserting "thousands of retries" pass alone and fail
    // under the full suite; measured three times before it was fixed here.
    const heldSince = readReport(progressFile).holdStartedAt
    const since = heldSince === null ? started : heldSince
    if (Date.now() - since > wallClockMs) { breach = 'wall-clock'; break }
    for (const r of roots) {
      if (bundleCount(r) > maxBundles) { breach = 'bundle-count'; break }
      if (sizeOf(r) > maxBytes) { breach = 'bytes'; break }
    }
    if (breach !== null) break
    await new Promise<void>(r => { setTimeout(r, 50) })
  }

  roots = readRoots(rootsFile)

  if (breach !== null) {
    // KILL THE GROUP, NOT THE PID. The hold holds SIGTERM by design; SIGKILL to
    // the negative pid reaches the group this function created and nothing else.
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    // AND WAIT FOR IT. Removing roots while a process is still publishing into
    // them is how residue gets recreated behind the cleanup.
    await ended
    roots = readRoots(rootsFile)
    const observed = readReport(progressFile)
    removeRoots(roots)
    // AND SWEEP WHAT IT MAY NOT HAVE MANAGED TO REPORT. A kill can land between
    // `mkdtemp` and the child's next flush.
    sweepChildPrefix(childPrefix)
    return Object.freeze({
      outcome: 'killed' as const, ceiling: breach,
      report: observed, roots: Object.freeze([]), stderr,
    })
  }

  await ended
  // THE ROOTS OUTLIVE THIS CALL SO THE CALLER CAN READ THE EVIDENCE, and are
  // registered for the suite's own per-test cleanup, which unfreezes and removes
  // them and enforces the per-world bundle ceiling.
  for (const r of roots) ROOTS.push(r)
  if (!existsSync(resultFile)) {
    void exitCode
    return Object.freeze({
      outcome: 'crashed' as const, ceiling: null,
      report: readReport(progressFile), roots: Object.freeze([...roots]), stderr,
    })
  }
  return Object.freeze({
    outcome: 'completed' as const, ceiling: null,
    report: readReport(resultFile), roots: Object.freeze([...roots]), stderr,
  })
}
