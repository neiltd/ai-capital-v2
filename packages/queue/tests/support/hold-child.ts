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

import {
  chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  INTENT_PREFIX, OUTCOME_PREFIX, OpsRefused, runOpsCli,
  type FenceLike, type InterventionHold,
} from '../../bin/pg-copy-ops.js'
import {
  EVIDENCE_RETRY_SCRATCH, REAL_EVIDENCE_OPS, RELEASE_SQL, type EvidenceOps,
} from '@common/db/pg-copy'

import {
  FENCED_CENSUS, ROOTS, RUN_ID, bundles, deps, goneWhen, lockRow,
  observeUnscriptedHold, proverStub, ready, rehearseArgs, supervisorStub,
  takeUnscriptedHold, tokenFor,
} from './ops-world.js'
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
  writeFileSync(rootsFile, `${text}\n`)
}
setInterval(flushRoots, 25).unref()

// ---------------------------------------------------------------------------
// THE REPORT, WRITTEN AS IT HAPPENS
// ---------------------------------------------------------------------------

// WHY IT IS FLUSHED ON EVERY CHANGE RATHER THAN RETURNED. A case whose subject is
// that a hold does not end never returns anything, and its counters are exactly
// what its control asserts on: that `decide` was asked ONCE and the operation
// performed ONCE while the record could not be written. Those facts have to be on
// disk before the container kills the process.
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
} = {
  exitCode: null, lines: [], root: null, evidence: null,
  supervisorSql: [], supervisorClosed: 0, proverSql: [], proverClosed: 0,
  armed: 0, disarmed: 0, requests: [], order: [], evidenceAtPerform: [],
  performed: 0, sleeps: [], unscripted: null, renames: 0, plantedSurvived: null,
  holdStartedAt: null,
  scratchCensus: [], evidenceEntries: [], publishAttempts: 0,
}

const flush = (): void => { writeFileSync(progressFile, `${JSON.stringify(report)}\n`) }

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
report.root = w.dir
report.evidence = w.evidence
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
  close: async () => { report.supervisorClosed += 1; flush(); return await sup.close() },
}

/** The resolver: a script, a script preceded by refusals, or nothing at all. */
function resolver(): InterventionHold | undefined {
  const kind = spec.hold?.kind ?? 'forbidden'
  if (kind === 'forbidden') return undefined
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


const held = resolver()
const ops = failingOps()
let runIdSeq = 0

const r = await runOpsCli(rehearseArgs(w, token, spec.rehearseExtra ?? []), deps(w, {
  openSupervisor: async () => watchedSup as never,
  openProver: async () => prover,
  ...(held === undefined ? {} : { hold: held }),
  ...(spec.destinationsDrifted === true
    ? {
      destinations: {
        measure: async () => FENCED_CENSUS.map((x, n) => n === 0
          ? { ...x, credentialDeviceInode: '16777234:99999' } : x),
      },
    }
    : {}),
  ...(ops === undefined ? {} : { ops }),
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
  },
}))

report.exitCode = r.exitCode
report.lines = [...r.lines]
report.plantedSurvived = plantedIntact()
try { report.evidenceEntries = readdirSync(w.evidence).sort() } catch { /* gone */ }
const unscripted = takeUnscriptedHold()
if (unscripted !== null) report.unscripted = unscripted
flush()
flushRoots()

// WRITTEN ATOMICALLY, so the parent never reads half a result and concludes the
// child finished when it had not.
const tmp = `${resultFile}.partial`
writeFileSync(tmp, `${JSON.stringify(report)}\n`)
chmodSync(tmp, 0o600)
renameSync(tmp, resultFile)
