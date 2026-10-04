// THE CONTAINED SIDE OF A HOLD-CAPABLE TEST.
//
// WHY A SEPARATE PROCESS AT ALL. `holdForIntervention` is unbounded by design:
// there is no attempt count at which abandoning a held fence becomes correct, so
// nothing INSIDE the process running it can end it. A `decide` that throws is an
// unresolved attempt. A failed pause is swallowed. A record that will not publish
// is a reason to keep holding. `__maxAttempts` used to exist and has been removed
// precisely because a production hold that a dependency can make finite is not a
// hold.
//
// A `Promise.race`, a Vitest `testTimeout` and an `afterEach` are therefore all
// insufficient, and were: they end the AWAIT, report the test, and leave the loop
// running. Twenty-two abandoned evidence roots and 103 GB of published bundles is
// what that looks like, and four of the workers that produced them ignored
// SIGTERM because the hold's own signal handlers were doing exactly what they are
// built to do.
//
// SO CONTAINMENT IS A PROCESS BOUNDARY. This file is spawned as its own process
// group, reports the temporary roots it creates BEFORE anything is published into
// them, and writes its counters as it goes. Its parent (`contained.ts`) enforces
// wall-clock, bundle-count and byte ceilings and, on breach, SIGKILLs the group -
// which no handler can hold - then removes exactly the roots this process
// reported.
//
// PROTOCOL. argv is `<specPath> <outDir>`, and `outDir` receives:
//   roots     one absolute path per line, flushed continuously
//   progress  JSON counters, rewritten whenever one changes
//   result    JSON {exitCode, lines}, written ONCE, atomically, at completion
// A missing `result` means this process never finished, which is the signal the
// parent's ceilings act on.
//
// NOTHING LIVE IS REACHED. The world, the stubs and the dependency wiring are the
// same ones the in-process tests use, imported from `ops-world.ts`.

import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { publishAtomically } from './publish.js'

import {
  DEAD_CHANNEL_IDLE_MS, INTENT_PREFIX, OUTCOME_PREFIX, OperatorChannelDead, OpsRefused,
  RESOLUTION_POLL_MS, runOpsCli,
  type FenceLike, type InterventionHold, type OperatorChannel,
} from '../../bin/pg-copy-ops.js'
import {
  EVIDENCE_RETRY_SCRATCH, REAL_EVIDENCE_OPS, RELEASE_SQL, REVIEWED_PRODUCERS,
  REVIEWED_QUEUES, openPsqlBackend, type EvidenceOps, type PsqlBackend,
} from '@common/db/pg-copy'

import {
  BACKEND_START, FENCED_CENSUS, ROOTS, ROOT_PREFIX, RUN_ID, SUPERVISOR_PID, bundles, deps,
  goneWhen, lockRow, observeUnscriptedHold, proverStub, ready, rehearseArgs,
  supervisorStub, takeUnscriptedHold, tokenFor,
} from './ops-world.js'
import { installSelfLimit } from './self-limit.js'
import type { HoldSpec } from './hold-spec.js'

const [specPath, outDir] = process.argv.slice(2)
if (specPath === undefined || outDir === undefined) {
  throw new Error('usage: hold-child.ts <specPath> <outDir>')
}

const rootsFile = join(outDir, 'roots')
const progressFile = join(outDir, 'progress')
const resultFile = join(outDir, 'result')

/**
 * FLUSH THE ROOTS CONTINUOUSLY, not once at the end.
 *
 * The parent can only remove what it has been told about, and it may have to
 * remove it a millisecond after this process is killed. So the list is rewritten
 * on a short interval from the moment this file loads: any root that exists has
 * been reported before a bundle could be published into it. Unreferenced so it
 * can never be the reason this process stays alive.
 */
let lastRoots = ''
const flushRoots = (): void => {
  const text = ROOTS.join('\n')
  if (text === lastRoots) return
  lastRoots = text
  publishAtomically(rootsFile, `${text}\n`)
}
setInterval(flushRoots, 25).unref()

// ---------------------------------------------------------------------------
// THE CHILD'S OWN CEILINGS, WHICH DO NOT NEED A PARENT
// ---------------------------------------------------------------------------

// ARMED BEFORE ANYTHING ELSE. See `self-limit.ts` for why this exists on the
// child side at all when `contained.ts` already polices the same three ceilings:
// the short answer is that the parent can stop existing, and a detached child
// reparented to PPID 1 publishes into a root nobody is left to remove.
const SELF = installSelfLimit(outDir)

/**
 * EVERY EVIDENCE OPERATION, CHECKED FIRST.
 *
 * WHY NOT ONLY A TIMER. Because a timer never runs. The retry cycle pauses through
 * an injected `sleep` that resolves at once, so the whole thing is a chain of
 * microtasks and the event loop never reaches a `setInterval` - measured, not
 * assumed: a timer-driven census recorded zero samples across twenty-eight
 * thousand cycles. A ceiling that can only be enforced by a timer is therefore no
 * ceiling at all against precisely the runaway it exists to stop. So the check is
 * called synchronously from the operations that create and publish, and the timer
 * inside `installSelfLimit` is the defence in depth rather than the mechanism.
 *
 * INSTALLED ALWAYS, around whatever the spec asked for, so no case can opt out of
 * the ceilings by not injecting failing operations. It delegates everything: the
 * only difference an unmutated run can observe is that a runaway stops.
 */
function guarded(base: EvidenceOps): EvidenceOps {
  return {
    ...base,
    mkdirSync: ((path: never, opts?: never) => {
      SELF.check()
      return base.mkdirSync(path, opts)
    }) as typeof base.mkdirSync,
    openSync: ((path: never, flags: never, mode?: never) => {
      SELF.check()
      return base.openSync(path, flags, mode)
    }) as typeof base.openSync,
    renameNoReplace: (from: string, to: string) => {
      SELF.check()
      return base.renameNoReplace(from, to)
    },
  }
}

// ---------------------------------------------------------------------------
// THE REPORT, WRITTEN AS IT HAPPENS
// ---------------------------------------------------------------------------

// WHY IT IS FLUSHED ON EVERY CHANGE RATHER THAN RETURNED. A case whose subject is
// that a hold does not end never returns anything, and its counters are exactly
// what its control asserts on: that `decide` was asked ONCE and the operation
// performed ONCE while the record could not be written. Those facts have to be on
// disk before the container kills the process.
/** Every line the run streamed, and what was visible at each prompt. */
const sink: string[] = []
/**
 * HOW MANY TIMES THE OPERATOR HAS BEEN ASKED, counted by the transport itself.
 *
 * `report.requests` is filled by the SCRIPTED resolver's `decide`, which a
 * `channel` case does not use - it runs the PRODUCTION hold. Gating a prover on
 * `report.requests.length` therefore never fires for these cases, which is how
 * the first attempt at this fixture looped until its container killed it.
 */
let askedCount = 0
const channelSnapshots: Array<{
  sinkLength: number; hadIntervention: boolean; hadFenceState: boolean
  hadReplyWith: boolean; tokenFromSink: string | null; replied: string
}> = []

const report: {
  exitCode: number | null; lines: string[]
  root: string | null; evidence: string | null
  supervisorSql: string[]; supervisorClosed: number
  proverSql: string[]; proverClosed: number
  armed: number; disarmed: number
  requests: Array<{
    state: string; actions: string[]; token: string
    intentsOnDisk: number; outcomesOnDisk: number
    supervisorClosedSoFar: number; performedSoFar: number
    armedSoFar: number; disarmedSoFar: number
  }>
  order: string[]; evidenceAtPerform: string[][]
  performed: number; sleeps: number[]; unscripted: string | null; renames: number
  plantedSurvived: boolean | null
  holdStartedAt: number | null
  scratchCensus: Array<{
    attempt: number; temporaryDirs: number; temporaryNames: string[]
    publishedDirs: number; bytes: number
  }>
  evidenceEntries: string[]
  publishAttempts: number
  sink: string[]
  channelSnapshots: Array<{
    sinkLength: number; hadIntervention: boolean; hadFenceState: boolean
    hadReplyWith: boolean; tokenFromSink: string | null; replied: string
  }>
  sigintListenersAtFence: number | null
  selfSignalsSent: string[]
  deadChannelIdleSleeps: number
  fakePsqlPid: number | null
  fakePsqlPgid: number | null
  childPgid: number | null
  fakePsqlAliveAfterSignals: boolean | null
  fakePsqlExitedAtEof: boolean | null
  stdinStandInEnded: string | null
  fakePsqlRoot: string | null
  resolutionFilePath: string | null
  resolutionWritten: string | null
  resolutionPolls: number
  sigintListenersAtPoll: number[]
  pollsAtReplyLine: number[]
  replyTokens: string[]
  resolutionInodes: string[]
} = {
  exitCode: null, lines: [], root: null, evidence: null,
  supervisorSql: [], supervisorClosed: 0, proverSql: [], proverClosed: 0,
  armed: 0, disarmed: 0, requests: [], order: [], evidenceAtPerform: [],
  performed: 0, sleeps: [], unscripted: null, renames: 0, plantedSurvived: null,
  holdStartedAt: null,
  scratchCensus: [], evidenceEntries: [], publishAttempts: 0,
  sink, channelSnapshots,
  sigintListenersAtFence: null, selfSignalsSent: [], deadChannelIdleSleeps: 0,
  fakePsqlPid: null, fakePsqlPgid: null, childPgid: null,
  fakePsqlAliveAfterSignals: null, fakePsqlExitedAtEof: null,
  stdinStandInEnded: null, fakePsqlRoot: null,
  resolutionFilePath: null, resolutionWritten: null, resolutionPolls: 0,
  sigintListenersAtPoll: [], pollsAtReplyLine: [], replyTokens: [], resolutionInodes: [],
}

const flush = (): void => { publishAtomically(progressFile, `${JSON.stringify(report)}\n`) }


// RECORDED AS IT HAPPENS. A contained run that reaches an unscripted hold never
// returns, so the fact has to be on disk before the parent kills the process.
observeUnscriptedHold(m => {
  report.unscripted = m
  // AN UNSCRIPTED HOLD IS STILL A HOLD THAT HAS BEGUN.
  if (report.holdStartedAt === null) report.holdStartedAt = Date.now()
  flush()
})

// ---------------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------------

const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as HoldSpec

const w = await ready(spec.world ?? {})
/**
 * SAMPLE THE EVIDENCE ROOT WHILE THE RUN IS STILL GOING.
 *
 * `evidenceEntries` used to be written once, after `runOpsCli` returned - which
 * is never, for a case whose whole subject is a hold that correctly does not
 * return. The container then removes the roots as it kills the child
 * (`contained.ts:365`), so by the time the parent asserts, the directory is gone
 * and reading it from disk is not an option either. So it is sampled here, on a
 * low-frequency UNREF'd timer: unref'd because this must never be the handle
 * that keeps a child alive, and low-frequency because it is a directory read.
 */
setInterval(() => {
  try {
    report.evidenceEntries = readdirSync(w.evidence).sort()
    flush()
  } catch { /* not built yet, or already swept */ }
}, 250).unref()
report.root = w.dir
report.evidence = w.evidence
// THE CEILINGS NOW HAVE SOMETHING TO MEASURE. Set before anything is published,
// so there is no window in which this process can grow a root unwatched.
SELF.watch(w.dir, w.evidence)
flush()
flushRoots()
const token = await tokenFor(w, 'rehearse')

/**
 * A PRE-EXISTING RETRY SCRATCH DIRECTORY, PLANTED BEFORE THE HOLD BEGINS.
 *
 * Half-built and frozen exactly as an abandoned attempt leaves one, under the
 * exact reviewed name, owned by this user on this device - everything a same-owner
 * same-device guard can see, and still not this process's to delete. The marker
 * bytes are what `plantedSurvived` re-reads.
 */
const PLANTED_MARKER = 'planted by an earlier run\n'
let plantedPath: string | null = null
if (spec.plantRetryScratch !== undefined) {
  plantedPath = join(
    w.evidence,
    `.tmp-${spec.plantRetryScratch}-${RUN_ID}-${EVIDENCE_RETRY_SCRATCH}`)
  mkdirSync(plantedPath, { mode: 0o700 })
  writeFileSync(join(plantedPath, 'outcome.json'), PLANTED_MARKER, { mode: 0o600 })
  chmodSync(join(plantedPath, 'outcome.json'), 0o400)
  chmodSync(plantedPath, 0o500)
}

/** Are the planted bytes still exactly what was planted? */
const plantedIntact = (): boolean | null => {
  if (plantedPath === null) return null
  try {
    return readFileSync(join(plantedPath, 'outcome.json'), 'utf-8') === PLANTED_MARKER
  } catch { return false }
}

/** The supervisor, watched: which statements it saw and when a release happened. */
let released = false
const sup = supervisorStub(spec.supervisor ?? {})
const supSend = sup.send
sup.send = async (sql: string) => {
  if (sql === RELEASE_SQL) released = true
  report.supervisorSql.push(sql)
  flush()
  return await supSend(sql)
}

const proverKind = spec.prover?.kind ?? 'gone-after-release'
const resolveAfter = spec.prover?.resolveAfter ?? 0
const inner = proverKind === 'gone'
  ? goneWhen(() => true)
  : proverKind === 'gone-after-release'
    ? goneWhen(() => released)
    : proverStub({
      ...(proverKind === 'partial-then-gone'
        ? { locks: [lockRow('advisory', 'ExclusiveLock')] } : {}),
      ...(spec.prover?.terminateRefused === true ? { terminateRefused: true } : {}),
      ...(spec.prover?.observedStart === undefined
        ? {} : { observedStart: spec.prover.observedStart }),
    })

let censuses = 0
/** Set by a `pg_terminate_backend` this prover answered. */
let terminated = false
const prover: FenceLike = {
  send: async (sql: string) => {
    report.proverSql.push(sql)
    // THE CENSUS AFTER A DECISION IS THE `CENSUS_ONLY` OPERATION. Counted from
    // the first decision rather than from the release, because the GATE reads the
    // same statement while it is proving the fence - and a run whose gate refused
    // never reaches a release at all, so counting from there would count nothing.
    if (report.requests.length > 0 && sql.startsWith('SELECT a.backend_start')) {
      report.performed += 1
      report.order.push('perform')
      // WHAT WAS ON DISK WHEN THE OPERATION RAN. The intent must already be
      // there and the outcome must not.
      report.evidenceAtPerform.push(readdirSync(w.evidence))
    }
    if (proverKind === 'reaped-on-terminate') {
      if (sql.startsWith('SELECT pg_catalog.pg_terminate_backend')) {
        terminated = true
        flush()
        return { rows: [['t']], error: null }
      }
      // REAPED, BUT ONLY AFTER THE TERMINATION. Before it the backend is alive
      // holding the complete fence, which is what makes the post-termination
      // census a measurement rather than a formality.
      if (terminated && sql.startsWith('SELECT a.backend_start')) {
        flush()
        return { rows: [], error: null }
      }
    }
    if (proverKind === 'partial-then-gone') {
      // GONE ONCE THE OPERATOR HAS LOOKED AGAIN. The first attempt sees a
      // partial lock set, which resolves nothing.
      if (sql.startsWith('SELECT a.backend_start') && report.requests.length > resolveAfter) {
        flush()
        return { rows: [], error: null }
      }
      if (sql.includes('pg_catalog.count(*)')) {
        flush()
        return { rows: [['1']], error: null }
      }
    }
    if (proverKind === 'gone-after-first-decision') {
      // GONE ONCE THE OPERATOR HAS BEEN ASKED. Before that the backend holds the
      // complete fence, so the gate's fence proof passes and the refusal under
      // test is the one the case arranged.
      const asked = askedCount > 0
      if (sql.startsWith('SELECT a.backend_start') && asked) {
        flush()
        return { rows: [], error: null }
      }
      if (sql.includes('pg_catalog.count(*)') && asked) {
        flush()
        // ZERO REVIEWED LOCKS: the independent census that resolves the hold.
        return { rows: [['0']], error: null }
      }
    }
    if (proverKind === 'locks-until' && released && sql.includes('pg_catalog.count(*)')) {
      censuses += 1
      flush()
      // A PARTIAL LOCK SET IS A LIVE FENCE, so six is not a resolution. Zero is,
      // and only once the script says so - `-1` meaning never.
      const done = resolveAfter >= 0 && censuses > resolveAfter
      return { rows: [[done ? '0' : '6']], error: null }
    }
    flush()
    return await inner.send(sql)
  },
  close: async () => { report.proverClosed += 1; flush(); return await inner.close() },
}
const watchedSup: FenceLike = {
  send: sup.send,
  close: async () => {
    report.supervisorClosed += 1
    // R1b: CLOSING THE SUPERVISOR IS WHAT ENDS THE psql CHILD, and in the
    // real CLI this is the moment the fence is released. The fake session opened
    // at the fence is closed here, through the production `close` - which ends
    // its stdin, lets the fake read EOF and write its marker, and reaps it.
    if (fakeSession !== null) {
      const s = fakeSession
      fakeSession = null
      try { await s.close() } catch { /* already gone */ }
      if (fakeMarker !== null) {
        report.fakePsqlExitedAtEof = existsSync(fakeMarker)
      }
    }
    flush()
    return await sup.close()
  },
}

/** The resolver: a script, a script preceded by refusals, or nothing at all. */
/**
 * THE OPERATOR'S TRANSPORT, RECORDED - and nothing else about the hold replaced.
 *
 * NEVER THROWS AND NEVER RETURNS ''. A throw is an unresolved attempt the hold
 * answers by asking again, and an empty line is the same; either would turn this
 * case into an unbounded loop, which is precisely what the container exists to
 * catch and what this must not rely on.
 *
 * THE TOKEN COMES ONLY FROM WHAT WAS STREAMED. Reading it from the `decide`
 * argument would prove nothing: the question is whether an operator looking at
 * their terminal could have answered, so the reply is built from the terminal's
 * contents or not at all.
 */
function recordingChannel(actions: readonly string[]): OperatorChannel {
  let asked = 0
  return {
    preflight: () => undefined,
    arm: () => () => undefined,
    close: () => undefined,
    nextLine: async () => {
      // SNAPSHOT FIRST, BEFORE A REPLY EXISTS.
      const replyLine = [...sink].reverse().find(l => l.includes('Reply with: <OPERATION>'))
      const m = replyLine === undefined ? null : /(PGCOPY-RESOLVE-[0-9a-f]+)/.exec(replyLine)
      const tok = m === null ? null : (m[1] as string)
      const action = actions[Math.min(asked, actions.length - 1)] ?? 'CENSUS_ONLY'
      asked += 1
      askedCount += 1
      // A reply with no token is still a reply: the hold refuses it and asks
      // again, which is a recorded unresolved attempt rather than a throw.
      const replied = tok === null
        ? `${action} k8-operator PGCOPY-RESOLVE-${'0'.repeat(64)}`
        : `${action} k8-operator ${tok}`
      channelSnapshots.push({
        sinkLength: sink.length,
        hadIntervention: sink.some(l => l.includes('INTERVENTION REQUIRED')),
        hadFenceState: sink.some(l => l.startsWith('FENCE STATE: ')),
        hadReplyWith: replyLine !== undefined,
        tokenFromSink: tok, replied,
      })
      flush()
      return replied
    },
  }
}

/**
 * A TRANSPORT THAT IS GONE, which is what a hung-up stdin is.
 *
 * `OperatorChannelDead` is the production class, raised by the production
 * transport for exactly these conditions - so a hold meeting this stub takes the
 * same branch it would take against a real closed terminal. `arm` still returns
 * a disarm, because losing stdin does not lose the signal handlers.
 */
function deadChannel(): OperatorChannel {
  return {
    preflight: () => undefined,
    arm: () => { report.armed += 1; flush(); return () => { report.disarmed += 1; flush() } },
    close: () => undefined,
    nextLine: async () => {
      askedCount += 1
      flush()
      throw new OperatorChannelDead('the resolution channel closed before a line arrived')
    },
  }
}

function resolver(): InterventionHold | undefined {
  const kind = spec.hold?.kind ?? 'forbidden'
  // `channel`, `production` and `dead-channel` REPLACE NOTHING. Returning
  // undefined here is what makes `runRehearsal` build the production
  // `processHold`; where a transport is injected at all it arrives separately,
  // through `deps.operatorChannel`.
  if (kind === 'forbidden' || kind === 'channel'
      || kind === 'production' || kind === 'dead-channel') return undefined
  const actions = spec.hold?.actions ?? ['CENSUS_ONLY']
  const refusals = spec.hold?.refusals ?? 0
  let asked = 0
  return {
    arm: () => { report.armed += 1; flush(); return () => { report.disarmed += 1; flush() } },
    decide: async (state, offered, t) => {
      // THE HOLD HAS BEGUN. The parent's ceilings count from here.
      if (report.holdStartedAt === null) report.holdStartedAt = Date.now()
      report.order.push('decide')
      report.requests.push({
        state, actions: [...offered], token: t,
        supervisorClosedSoFar: report.supervisorClosed,
        performedSoFar: report.performed,
        armedSoFar: report.armed,
        disarmedSoFar: report.disarmed,
        // HOW MANY RECORDS EXIST AT THE MOMENT WE ARE ASKED. A request that
        // repeated a count would be an operation offered on top of an unrecorded
        // one.
        intentsOnDisk: bundles(w.evidence, INTENT_PREFIX).length,
        outcomesOnDisk: bundles(w.evidence, OUTCOME_PREFIX).length,
      })
      flush()
      asked += 1
      if (spec.hold?.freezeEvidence === true) chmodSync(w.evidence, 0o500)
      // A REFUSED RESOLUTION IS AN UNRESOLVED ATTEMPT, NEVER AN EXIT - which is
      // exactly what a wrong token produces.
      if (asked <= refusals) {
        throw new OpsRefused("the resolution does not carry this run's token")
      }
      const action = actions[Math.min(asked - refusals - 1, actions.length - 1)] as string
      return { action: action as never, operator: 'operator-under-test', token: t }
    },
  }
}

/** Evidence ops whose no-replace rename fails for one prefix. */
function failingOps(): EvidenceOps | undefined {
  if (spec.ops === undefined) return undefined
  const o = spec.ops
  const { failRename, failures } = o
  let seen = 0
  /** Latched by an indeterminate rename: those paths briefly cannot be read. */
  let unreadable = false
  /** How many more reads are refused before the latch lets go. */
  let unreadableLeft = 0

  /** Does this path belong to the record whose publication is being broken? */
  const mine = (path: string): boolean =>
    path.includes(`/.tmp-${failRename}-`) || path.includes(`/${failRename}-`)
  /** A file inside that record's scratch directory, rather than the directory. */
  const myFile = (path: string): boolean =>
    mine(path) && /\/(DIGEST|[a-z-]+\.json)$/.test(path)

  /**
   * WHAT THE ROOT HOLDS RIGHT NOW.
   *
   * SAMPLED SYNCHRONOUSLY, FROM INSIDE THE OPERATIONS THEMSELVES, and not from a
   * timer. The phase loop pauses through an injected `sleep` that resolves at
   * once, so the whole retry cycle is a chain of microtasks and a `setInterval`
   * never gets a turn - measured, not assumed: a timer census recorded zero
   * samples across twenty-eight thousand cycles.
   *
   * Sampled at the two operations every cycle must perform: creating a scratch
   * directory, and attempting the rename. A failure that never reaches the
   * rename - a freeze that will not take - is therefore still measured.
   */
  const census = (): void => {
    let names: string[] = []
    try {
      names = readdirSync(w.evidence).filter(n => n.startsWith('.tmp-'))
    } catch { names = [] }
    let bytes = 0
    const walk = (abs: string): void => {
      let st
      try { st = statSync(abs) } catch { return }
      if (st.isDirectory()) {
        let kids: string[] = []
        try { kids = readdirSync(abs) } catch { return }
        for (const k of kids) walk(join(abs, k))
        return
      }
      bytes += st.size
    }
    walk(w.evidence)
    let published = 0
    try {
      published = readdirSync(w.evidence).filter(n => !n.startsWith('.')).length
    } catch { published = 0 }
    // BOUNDED ITSELF. A run that samples for a minute must not turn the report
    // into the thing that grows; the earliest samples and the most recent ones
    // are what a bound is read from, so the middle is what gets dropped.
    if (report.scratchCensus.length >= 300) report.scratchCensus.splice(20, 1)
    report.scratchCensus.push({
      attempt: sampled, temporaryDirs: names.length, temporaryNames: names.sort(),
      publishedDirs: published, bytes,
    })
    report.plantedSurvived = plantedIntact()
    flush()
  }

  /**
   * SAMPLE, BUT NOT ON EVERY SINGLE CYCLE.
   *
   * A full walk of the root per cycle would dominate the run and make the cycle
   * count meaningless. The first few samples show the growth that IS allowed -
   * the diagnostic directory, then the retry scratch - and every fiftieth after
   * that shows the bound holding.
   */
  let sampled = 0
  const tick = (): void => {
    sampled += 1
    if (sampled <= 4 || sampled % 50 === 0) census()
  }

  return {
    ...REAL_EVIDENCE_OPS,
    mkdirSync: ((path: string, opts?: never) => {
      // ONE REBUILD PER SCRATCH DIRECTORY CREATED. This is the cycle count the
      // bound is stated over, and it is the same number whether a failure happens
      // at the rename or long before it.
      if (typeof path === 'string' && path.includes(`/.tmp-${failRename}-`)) {
        report.publishAttempts += 1
        tick()
      }
      return REAL_EVIDENCE_OPS.mkdirSync(path as never, opts)
    }) as typeof REAL_EVIDENCE_OPS.mkdirSync,
    lstatSync: ((path: never, opts?: never) => {
      // ONLY WHILE LATCHED, AND ONLY FOR THIS RECORD'S PATHS. Everything else -
      // the evidence root itself included - answers normally.
      //
      // AND THE LATCH LETS GO. `classifyUnreportedRename` asks about both paths, so
      // a few refusals is all it takes to make the outcome genuinely
      // indeterminate; keeping them unreadable for ever would stop a second rename
      // by itself and hide whether the code would have made one.
      // SAMPLED HERE TOO, because a cycle that creates NOTHING - which is exactly
      // what a preserved pre-existing scratch directory produces - never reaches a
      // `mkdir` or a rename, and a census hung only off those would starve. Every
      // cycle inspects the retry scratch, so this fires once per cycle.
      if (typeof path === 'string' &&
          (path as string).endsWith(`-${EVIDENCE_RETRY_SCRATCH}`)) tick()
      if (unreadable && typeof path === 'string' && mine(path)) {
        unreadableLeft -= 1
        if (unreadableLeft <= 0) unreadable = false
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return REAL_EVIDENCE_OPS.lstatSync(path, opts)
    }) as typeof REAL_EVIDENCE_OPS.lstatSync,
    chmodSync: ((path: never, mode: never) => {
      if (o.failFileChmod === true && typeof path === 'string' && myFile(path)) {
        // SAMPLED AT THE MOMENT OF FAILURE, which is when BOTH the preserved
        // diagnostic directory and the retry scratch exist. A sample taken only
        // at `mkdir` is taken just after the scratch was cleared and so reads one
        // directory where the peak is two.
        tick()
        const e = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
      return REAL_EVIDENCE_OPS.chmodSync(path, mode)
    }) as typeof REAL_EVIDENCE_OPS.chmodSync,
    fsyncSync: ((fd: number) => {
      if (o.failFsync === true && fsyncTargets.has(fd)) {
        tick()
        const e = new Error('EIO: i/o error') as NodeJS.ErrnoException
        e.code = 'EIO'
        throw e
      }
      return REAL_EVIDENCE_OPS.fsyncSync(fd)
    }) as typeof REAL_EVIDENCE_OPS.fsyncSync,
    openSync: ((path: never, flags: never, mode?: never) => {
      const fd = REAL_EVIDENCE_OPS.openSync(path, flags, mode)
      // REMEMBER WHICH DESCRIPTORS BELONG TO THAT RECORD, because `fsync` is
      // handed a descriptor and a descriptor carries no path.
      if (typeof path === 'string' && myFile(path)) fsyncTargets.add(fd)
      return fd
    }) as typeof REAL_EVIDENCE_OPS.openSync,
    renameNoReplace: (from: string, to: string) => {
      if (to.includes(`/${failRename}-`)) {
        seen += 1
        report.renames = seen
        tick()
        if (o.renameIndeterminate === true) {
          // THE HELPER DID NOT REPORT, AND NEITHER PATH CAN BE EXAMINED - for the
          // four reads that resolution takes, and then no longer.
          unreadable = true
          unreadableLeft = 4
          return 'indeterminate'
        }
        if (failures < 0 || seen <= failures) return 'failed'
      }
      return REAL_EVIDENCE_OPS.renameNoReplace(from, to)
    },
  }
}

/** Descriptors opened for the record whose `fsync` is being broken. */
const fsyncTargets = new Set<number>()


/**
 * A FAKE psql, AND A REAL BACKEND OPENED AGAINST IT.
 *
 * R1b (K8-E6, reworded in K8-E7). R1 runs the fenced-signal scenario with stub
 * sessions, so it can say nothing about a psql child. This opens the PRODUCTION
 * `openPsqlBackend` against a `/bin/sh` fake in its own `mkdtemp` root,
 * registered in `ROOTS` so the container sweeps it whatever happens to this
 * process, and lets the case record three things: that the child is still alive
 * once the parent has declined signals sent to the PARENT'S OWN pid, that it sits
 * in a different process group, and that releasing the fence ends it at EOF.
 *
 * NOT A GROUP-DELIVERY TEST. The signals this child sends go to one pid, so they
 * were never going to reach a grandchild and the child's survival says nothing
 * about `detached`. What it measures is the group MEMBERSHIP, on a real backend.
 * Whether a signal to the whole group reaches psql is D2's subject
 * (`packages/db/tests/pg-copy-psql-backend-group.test.ts:233-240`).
 *
 * Modelled on pg-copy-psql-backend-group.test.ts: it answers the backend-pid
 * query with its own `$$`, so `session.pid` is the fake's OS pid, reads stdin,
 * exits at EOF and writes a marker on the way out. The marker is how a graceful
 * end is told from a kill.
 */
function fakePsqlRoot(): { bin: string; marker: string; dir: string } {
  // MINTED EXACTLY AS `ops-world.ts:346` MINTS ONE, through this child's own
  // `ROOT_PREFIX`. The harness refuses to remove a directory whose basename is
  // not the reviewed form `pgcopy-modes-<nonce>-<pid>-[c<n>-]XXXXXX`
  // (`roots.ts:100`, `provenRoot`), and it is right to: a root it cannot
  // attribute to this run is somebody else's. An ad-hoc prefix got exactly that
  // refusal, which is the guard working.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
  ROOTS.push(dir)
  flushRoots()
  const bin = join(dir, 'psql')
  const marker = join(dir, 'eof-marker')
  writeFileSync(bin, [
    '#!/bin/sh',
    'while IFS= read -r line; do',
    '  case "$line" in',
    "    '\\echo '*) printf '%s\\n' \"${line#\\\\echo }\" ;;",
    "    '\\warn '*) printf '%s\\n' \"${line#\\\\warn }\" >&2 ;;",
    '    *pg_backend_pid*) printf "%s\\n" "$$" ;;',
    '    *) ;;',
    '  esac',
    'done',
    `printf 'eof' > '${marker}'`,
  ].join('\n'), { mode: 0o700 })
  return { bin, marker, dir }
}

/** The process group a pid is in, or null once it is gone. Null must fail loudly. */
function pgidOf(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8' })
    const n = Number(out.trim())
    return Number.isSafeInteger(n) ? n : null
  } catch { return null }
}

const aliveNow = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** The backend opened at the fence, so the supervisor's close can end it. */
let fakeSession: PsqlBackend | null = null
let fakeMarker: string | null = null

/**
 * STAND IN FOR `process.stdin`, so the PRODUCTION transport raises the class.
 *
 * The contained child's stdin is `'ignore'` (contained.ts:297), which reaches the
 * no-TTY branch and never the other two. A `PassThrough` carrying `isTTY: true`
 * gets past that branch into the readline iterator, where `end()` resolves it
 * `done` and `destroy(err)` rejects it. Installed only here, in a child whose
 * whole purpose is to be disposable - a Vitest worker must never do this, which
 * is why these cases are contained.
 */
/**
 * ANSWER A --resolution-file HOLD FROM INSIDE THE CHILD, AT THE RIGHT MOMENT.
 *
 * K8-E11. The file is deliberately ABSENT when the run starts, so the hold begins
 * in the state the old code could never leave. The reply is written only after the
 * `Reply with:` line has been streamed, and it carries THE TOKEN FROM THAT LINE -
 * not the one `decide` was called with. Reading the token from the argument would
 * prove nothing: the question is whether an operator looking at their terminal
 * could have answered it, so the reply is built from what the terminal showed or
 * not at all.
 *
 * The container checks are real (`openReviewedContainer`): 0600, regular, one
 * link, owned by this user, and at a path that resolves to itself - which is why
 * the evidence root is already a realpath and the file is written with an
 * explicit mode.
 */
/** `dev:ino`, so an in-place correction can be told from a replace. */
const inodeOf = (path: string): string => {
  try {
    const st = statSync(path)
    return `${String(st.dev)}:${String(st.ino)}`
  } catch { return 'absent' }
}

const resolutionKind = spec.resolutionReply
const resolutionPath = resolutionKind === undefined ? null : join(w.evidence, 'resolution.txt')
if (resolutionPath !== null) {
  report.resolutionFilePath = resolutionPath
  flush()
}

/**
 * K8-E12 F5: THE LEFTOVER AN `--apply` LEAVES BEHIND.
 *
 * Written before the CLI is invoked and never touched again, so the hold's first
 * attempt opens with somebody else's answer already in the file. A well-formed
 * CONFIRM line carrying a fabricated 64-hex token, at mode 0600 so the reader
 * accepts the container and the question is purely about the CONTENT.
 */
if (resolutionPath !== null && spec.resolutionPrewrite === 'confirm-leftover') {
  writeFileSync(resolutionPath, `CONFIRM k8-operator PGCOPY-RESOLVE-${'c'.repeat(64)}\n`,
                { mode: 0o600 })
  report.resolutionInodes.push(inodeOf(resolutionPath))
  flush()
}

const STALE_TOKEN = `PGCOPY-RESOLVE-${'b'.repeat(64)}`

/** Write the reply, record what and where. Never unlinks: F4 needs the same file. */
const writeReply = (body: string): void => {
  const path = resolutionPath as string
  try {
    writeFileSync(path, body, { mode: 0o600 })
    report.resolutionWritten = body
    report.resolutionInodes.push(inodeOf(path))
  } catch (e) {
    report.resolutionWritten = `WRITE FAILED: ${e instanceof Error ? e.name : 'unknown'}`
  }
  flush()
}

/**
 * ANSWER THE FILE, ONCE PER QUESTION, AND ONLY AFTER THE QUESTION WAS ASKED.
 *
 * Every `Reply with` line is recorded with its token and with the poll count at
 * the moment it streamed, because K8-E12's cases are stated in exact counts: how
 * many questions were asked, and how many polls happened after each one.
 *
 * `census-then-abandon` is F4. The first question gets a CENSUS_ONLY reply, which
 * is accepted and resolves nothing, so the hold asks again with that reply still
 * in the file - the leftover shape the baseline rule exists for. The second answer
 * is written only after `correctAfterPolls` polls on the NEW token, in place, so
 * the case can prove the wait happened and that the file was corrected rather
 * than replaced.
 */
let answered = 0
let correctionArmed = false
const answerResolutionFileOnceAsked = (line: string): void => {
  if (resolutionPath === null) return
  if (!line.startsWith('Reply with: <OPERATION> ')) return
  const m = /(PGCOPY-RESOLVE-[0-9a-f]+)/.exec(line)
  if (m === null) return
  const printed = m[1] as string
  report.replyTokens.push(printed)
  report.pollsAtReplyLine.push(report.resolutionPolls)
  flush()

  const nth = report.replyTokens.length
  const action = spec.hold?.actions?.[0] ?? 'CENSUS_ONLY'

  if (resolutionKind === 'census-then-abandon') {
    if (nth === 1) {
      answered += 1
      setTimeout(() => { writeReply(`CENSUS_ONLY k8-operator ${printed}\n`) }, 30)
      return
    }
    if (nth === 2 && !correctionArmed) {
      correctionArmed = true
      // NOT ON A TIMER, BUT ON POLLS. The correction has to land after the wait
      // is demonstrable, so it waits for the poll count to move on.
      const want = report.resolutionPolls + (spec.correctAfterPolls ?? 3)
      const tick = setInterval(() => {
        if (report.resolutionPolls >= want) {
          clearInterval(tick)
          writeReply(`ABANDON k8-operator ${printed}\n`)
        }
      }, 5)
    }
    return
  }

  if (answered > 0) return
  const body =
    resolutionKind === 'current' ? `${action} k8-operator ${printed}\n`
    : resolutionKind === 'stale' ? `${action} k8-operator ${STALE_TOKEN}\n`
    : resolutionKind === 'malformed' ? 'not a reply at all\n'
    : null
  if (body === null) return
  answered += 1
  // AFTER A TURN OF THE LOOP, so the hold is genuinely waiting rather than being
  // answered inside the same tick that printed the question.
  setTimeout(() => { writeReply(body) }, 30)
}

const standInKind = spec.stdinStandIn
let standIn: PassThrough | null = null
if (standInKind !== undefined) {
  standIn = new PassThrough()
  Object.defineProperty(process, 'stdin', {
    value: Object.assign(standIn, { isTTY: true }), configurable: true,
  })
}

/**
 * AND END IT ONLY ONCE THE READ IS IN FLIGHT.
 *
 * Ending before the hold has asked would make the case prove nothing: the
 * iterator would be created on an already-finished stream, which is a different
 * path. So this waits for the `Reply with:` line the hold streams immediately
 * before it awaits, then yields once so the await is actually entered.
 */
let standInEnded = false
const endStandInOnceAsked = (line: string): void => {
  if (standIn === null || standInEnded || !line.includes('Reply with:')) return
  standInEnded = true
  setTimeout(() => {
    const s = standIn as PassThrough
    if (standInKind === 'error') {
      report.stdinStandInEnded = 'destroy(Error)'
      flush()
      s.destroy(new Error('the stand-in stdin was destroyed'))
    } else {
      report.stdinStandInEnded = 'end()'
      flush()
      s.end()
    }
  }, 25)
}

const held = resolver()
// ALWAYS GUARDED, whether or not this case injects failing operations.
const ops = guarded(failingOps() ?? REAL_EVIDENCE_OPS)
let runIdSeq = 0

/**
 * IS THE FENCE HELD YET?
 *
 * Flipped inside the `acquireFence` stub, which is the exact instant the fence
 * exists. A producer or a queue that only misbehaves after this point is a
 * problem the FENCED gate discovers - a hold - rather than a pre-fence refusal.
 */
let fenced = false

const holdKind = spec.hold?.kind ?? 'forbidden'
const channelKind = holdKind === 'channel'
/** The two K8-E5 kinds that run the production hold over a REAL or dead transport. */
const productionKind = holdKind === 'production'
const deadChannelKind = holdKind === 'dead-channel'

const extraArgs = [
  ...(spec.rehearseExtra ?? []),
  ...(resolutionPath === null ? [] : [`--resolution-file=${resolutionPath}`]),
]
const r = await runOpsCli(rehearseArgs(w, token, extraArgs), deps(w, {
  openSupervisor: async () => watchedSup as never,
  openProver: async () => prover,
  ...(held === undefined ? {} : { hold: held }),
  // K8-E3: the PRODUCTION hold, with only its transport injected, plus the sink
  // that records what an operator would have seen. `hold: undefined` overrides
  // `deps()`'s `forbiddenHold()` default so `runRehearsal` builds the real one.
  ...(channelKind
    ? {
      hold: undefined,
      operatorChannel: () => recordingChannel(spec.hold?.actions ?? ['CENSUS_ONLY']),
      sink: (l: string) => { sink.push(l); flush() },
    }
    : {}),
  // K8-E5 R1: NOTHING INJECTED. No `hold` and no `operatorChannel`, so the run
  // builds the production `processHold` over the production `operatorChannel` -
  // the only object that installs real signal handlers. Injecting the transport
  // here would replace the thing a signal case exists to measure.
  ...(productionKind
    ? {
      hold: undefined,
      sink: (l: string) => {
        sink.push(l); flush(); endStandInOnceAsked(l); answerResolutionFileOnceAsked(l)
      },
    }
    : {}),
  // K8-E5 R2: the production hold over a transport that is already gone.
  ...(deadChannelKind
    ? {
      hold: undefined,
      operatorChannel: () => deadChannel(),
      sink: (l: string) => {
        sink.push(l); flush(); endStandInOnceAsked(l); answerResolutionFileOnceAsked(l)
      },
    }
    : {}),
  acquireFence: async () => {
    fenced = true
    // THE EXACT INSTANT THE FENCE EXISTS. What is armed NOW is what stands
    // between a terminal signal and a released fence, so it is recorded here and
    // not inferred afterwards.
    report.sigintListenersAtFence = process.listenerCount('SIGINT')
    flush()
    // R1b: A REAL psql CHILD, OPENED BEFORE THE SIGNALS ARE SENT, so they land
    // while it exists and the case can ask what became of it. Its group is
    // recorded here too, because `detached` in psql-backend.ts puts it in its own
    // - which is the membership a terminal signal would have to cross. The
    // signals below go to one pid and could not have reached it in any case; the
    // group-delivery proof is D2.
    if (spec.fakePsqlAtFence === true) {
      const { bin, marker, dir } = fakePsqlRoot()
      fakeMarker = marker
      report.fakePsqlRoot = dir
      fakeSession = await openPsqlBackend({
        psqlPath: bin, host: '/tmp/no-such-socket', port: 5432,
        database: 'fixture', user: 'fixture',
      })
      const pid = Number(fakeSession.pid)
      report.fakePsqlPid = Number.isSafeInteger(pid) ? pid : null
      report.fakePsqlPgid = Number.isSafeInteger(pid) ? pgidOf(pid) : null
      report.childPgid = pgidOf(process.pid)
      flush()
    }
    // AND THE SIGNALS, TO THIS PROCESS'S OWN PID ONLY. Delivered between
    // `acquire` returning and the fenced gate completing.
    for (const sig of spec.signalSelfWhenFenced ?? []) {
      report.selfSignalsSent.push(sig)
      flush()
      process.kill(process.pid, sig)
    }
    if ((spec.signalSelfWhenFenced ?? []).length > 0) {
      // AND LET THE LOOP TURN, so delivery happens HERE - inside the fenced
      // window - rather than whenever the run next happens to yield. Node runs a
      // signal callback from the event loop, and everything from here to the end
      // of this run is promises and synchronous filesystem work: without a real
      // macrotask the callbacks can be deferred past the end of the process, and
      // the case would then prove nothing about what a signal does under a fence.
      await new Promise<void>(r => { setTimeout(r, 100) })
      // THE ASSERTION K8-E5's R1 COULD NOT MAKE: the psql child is still there
      // after the signals this process declined.
      if (report.fakePsqlPid !== null) {
        report.fakePsqlAliveAfterSignals = aliveNow(report.fakePsqlPid)
        flush()
      }
    }
    return { supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' as const }
  },
  // THE GATE SAMPLES THE QUEUES, AND THE GATE RUNS FENCED. A depth that is only
  // non-zero here is therefore discovered with the source frozen.
  ...(spec.fencedQueueBusy === undefined
    ? {}
    : {
      queue: {
        sample: async () => ({
          depths: Object.fromEntries(
            REVIEWED_QUEUES.map(q => [q, q === spec.fencedQueueBusy && fenced ? 3 : 0])),
        }),
      },
    }),
  // AND THE GATE READS THE QUIESCENCE CENSUS (lifecycle.ts:1637), so a producer
  // that starts during the window is found there and nowhere earlier.
  ...(spec.producerRunningUnderFence === undefined
    ? {}
    : {
      quiescence: {
        report: async () => REVIEWED_PRODUCERS.map(name => ({
          name,
          stopped: !(fenced && name === spec.producerRunningUnderFence),
        })),
      },
    }),
  ...(spec.destinationsDrifted === true
    ? {
      destinations: {
        measure: async () => FENCED_CENSUS.map((x, n) => n === 0
          ? { ...x, credentialDeviceInode: '16777234:99999' } : x),
      },
    }
    : {}),
  ops,
  ...(spec.runIdMinterThrows === true
    ? {
      newRunId: () => {
        // THE FIRST ID IS THE FIXED ONE THE RUN WAS INVOKED WITH; every later
        // request throws, which is what a failed system random source does.
        runIdSeq += 1
        if (runIdSeq === 1) return RUN_ID
        throw new Error('the system random source is unavailable')
      },
    }
    : {}),
  sleep: async (ms: number) => {
    if (spec.recordSleeps === true) { report.sleeps.push(ms); flush() }
    if (ms === RESOLUTION_POLL_MS) {
      report.resolutionPolls += 1
      // THE LEASE, AT EVERY POLL. K8-E12 F2: a snapshot taken when the fence was
      // taken cannot show that the lease is STILL armed while the hold waits, and
      // that is what the file-channel wait promises.
      report.sigintListenersAtPoll.push(process.listenerCount('SIGINT'))
      flush()
      // AND YIELD A REAL MACROTASK, briefly. A stub clock that resolves instantly
      // turns this poll into a tight loop, and a tight loop starves every other
      // timer in the process - including the one this child uses to write the
      // operator's reply. That is the same starvation K8-E6's MR2 ran into. Five
      // milliseconds keeps the case two orders of magnitude faster than the real
      // 2 s interval while leaving the loop a turn to give away.
      await new Promise<void>(r => { setTimeout(r, 5) })
      const park = spec.parkAfterResolutionPolls
      if (park !== undefined && report.resolutionPolls >= park) {
        // PARKED, NOT STOPPED, for the same reason as the dead-channel park: a
        // ref'd timer keeps this process alive and holding, where an unresolved
        // promise would let the loop empty and node exit zero.
        await new Promise<void>(r => { setTimeout(r, 3_600_000) })
      }
    }
    if (ms === DEAD_CHANNEL_IDLE_MS) {
      report.deadChannelIdleSleeps += 1
      flush()
      // PARKED, NOT STOPPED. The quiet hold must never return; this stub simply
      // stops resolving once the case has seen enough idle periods, which leaves
      // the process exactly where the property says it should be - alive,
      // holding, and publishing nothing.
      const park = spec.parkAfterIdleSleeps
      if (park !== undefined && report.deadChannelIdleSleeps >= park) {
        // A LONG TIMER, NOT A PROMISE NOBODY RESOLVES. An unresolved promise is
        // not a pending handle: the event loop would empty, and node would exit
        // ZERO - which the container reads as a crash and which would also be a
        // false negative for "this process is still holding". A ref'd timer is a
        // handle, so the process stays alive exactly as the real quiet hold does.
        await new Promise<void>(r => { setTimeout(r, 3_600_000) })
      }
    }
  },
}))

report.exitCode = r.exitCode
report.lines = [...r.lines]
report.sink = [...sink]
report.channelSnapshots = [...channelSnapshots]
report.plantedSurvived = plantedIntact()
try { report.evidenceEntries = readdirSync(w.evidence).sort() } catch { /* gone */ }
const unscripted = takeUnscriptedHold()
if (unscripted !== null) report.unscripted = unscripted
flush()
flushRoots()

// WRITTEN ATOMICALLY, so the parent never reads half a result and concludes the
// child finished when it had not.
publishAtomically(resultFile, `${JSON.stringify(report)}\n`)
