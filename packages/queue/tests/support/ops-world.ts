// THE SHARED FIXTURE FOR THE OPERATIONS COMMAND.
//
// WHY THIS IS NOT IN THE TEST FILE ANY MORE. Every hold-capable case now runs
// inside a CHILD PROCESS, because `holdForIntervention` is unbounded by design
// and nothing inside the process running it can stop it. The child needs the
// same world, the same stubs and the same dependency wiring the in-process
// tests use, so those live here and both sides import them. A second copy for
// the child would be a second definition of what "this world" means, and the
// two would drift.
//
// NOTHING HERE TOUCHES ANYTHING LIVE. `launchctl` is never invoked - the
// adapter's command runner is injected; the source sessions are stubs that
// answer the reviewed SQL by string equality; the quiescence, queue and
// destination adapters are injected. `plutil` IS run for real, on the bytes the
// adapter hands it, because parsing is the one thing a fake would make
// meaningless.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTIVITY_CENSUS_SQL, COPY_TABLES, FENCE_SEQUENCES, FENCE_SEQUENCE_LOCK_MODE,
  FENCE_TABLES, FENCE_TABLE_LOCK_MODE, RELEASE_SQL, REVIEWED_PRODUCERS,
  REVIEWED_QUEUES, SESSION_IDENTITY_SQL, contractDigest, publishEvidence,
  serializeArtifact,
  type ProducerCensusRow, type QueueAdapter, type QuiescenceAdapter,
} from '@common/db/pg-copy'

import {
  deriveOperationalBinding, runOpsCli,
  type FenceLike, type InterventionHold, type OpsDeps,
} from '../../bin/pg-copy-ops.js'
import { openReviewedPlist } from '../../src/pg-copy-ops/secure-file.js'
import { resolveRedis } from '../../src/pg-copy-ops/redis-config.js'
import type { CommandRunner } from '../../src/pg-copy-ops/launchd.js'
import { ROOT_PREFIX_FOR, RUN_NONCE } from './roots.js'

export const SUPERVISOR_PID = '41512'
export const PROVING_PID = '41513'
export const RUN_ID = 'a1b2c3d4'
export const STAMP = '20260925T101500Z'
export const BACKEND_START = '2026-09-25 10:14:00+00'
export const PROVER_START = '2026-09-25 10:14:01+00'
export const CREDENTIAL = 'postgres://u:p@%2Ftmp%2Fs/ai_capital\n'

export const ROOTS: string[] = []

/**
 * THE PER-WORLD BUNDLE CEILING.
 *
 * No reviewed case publishes anything like this many bundles. Enforced by the
 * PARENT of a contained run and by the test file's own `afterEach`.
 */
export const MAX_BUNDLES_PER_WORLD = 60

/**
 * THIS PROCESS'S OWN ROOT PREFIX.
 *
 * Vitest runs files in parallel workers, a contained child is another process
 * again, and a mutation harness may be running a second copy of the whole
 * suite - all sharing one `tmpdir()`. A residue check that looked for
 * `pgcopy-modes-*` would therefore fail because a DIFFERENT process was
 * mid-run. The pid makes the check about what this process left behind, which
 * is the only thing it can be responsible for.
 *
 * AND THE INVOCATION NONCE MAKES IT ANSWERABLE AFTER THE FACT. A pid says which
 * process, but only while that process exists: once the outer command is
 * interrupted, every pid in the name is meaningless and pids are reused. The
 * nonce is minted once per invocation and inherited through the environment, so
 * a LATER process can still sort "this run's roots", which must be removed, from
 * "an interrupted earlier run's roots", which may only be removed after proving
 * nothing live still references them. That is the whole basis of the reaper.
 *
 * AND A CONTAINED CHILD IS GIVEN ITS PARENT'S PREFIX, extended. A child has its
 * own pid, so a child that derived its own prefix would create roots the parent
 * could neither police while the child ran nor recognise as residue afterwards -
 * and policing a killed child's roots is the entire point of the container. The
 * value is validated rather than trusted: it must be in the reviewed form AND
 * carry this invocation's nonce, so an unexpected environment can neither
 * redirect these directories nor disown them.
 */
const SUPPLIED_PREFIX = process.env.PGCOPY_MODES_ROOT_PREFIX
export const ROOT_PREFIX = ((): string => {
  if (SUPPLIED_PREFIX === undefined) return ROOT_PREFIX_FOR(RUN_NONCE, process.pid)
  const m = /^pgcopy-modes-([0-9a-f]{16})-[0-9]{1,10}-c[0-9]{1,4}-$/.exec(SUPPLIED_PREFIX)
  if (m === null) {
    throw new Error(`the supplied root prefix is not in the reviewed form: ${SUPPLIED_PREFIX}`)
  }
  if (m[1] !== RUN_NONCE) {
    throw new Error(`the supplied root prefix carries another invocation's nonce: ${SUPPLIED_PREFIX}`)
  }
  return SUPPLIED_PREFIX
})()

export const lockRow = (q: string, mode: string): string[] =>
  [q === 'advisory' ? 'advisory' : 'relation', q, mode, 'true', SUPERVISOR_PID]

export const wholeFence = (): string[][] => [
  lockRow('advisory', 'ExclusiveLock'),
  ...FENCE_TABLES.map(q => lockRow(q, FENCE_TABLE_LOCK_MODE)),
  ...FENCE_SEQUENCES.map(q => lockRow(q, FENCE_SEQUENCE_LOCK_MODE)),
]

export interface Stub extends FenceLike { readonly seen: string[]; closed: () => number }

export function supervisorStub(over: {
  releaseError?: boolean; releaseThrows?: boolean; backendStart?: string
} = {}): Stub {
  const seen: string[] = []
  let closes = 0
  return {
    seen,
    closed: () => closes,
    // K7-B6.2 F: the reviewed `FenceLike` now declares what a real
    // `PsqlBackend` has always had. A SUPERVISOR stub needs a pid because
    // `SupervisorSession` is `FenceExecutor` PLUS `pid` - which the
    // production path used to satisfy by casting instead.
    pid: '41512',
    rows: async () => [] as string[][],
    alive: () => closes === 0,
    async send(sql: string) {
      seen.push(sql)
      if (sql === SESSION_IDENTITY_SQL) {
        return {
          rows: [[SUPERVISOR_PID, 'ai_capital_owner', over.backendStart ?? BACKEND_START]],
          error: null,
        }
      }
      if (sql === RELEASE_SQL) {
        if (over.releaseThrows === true) throw new Error('connection terminated')
        return { rows: [], error: over.releaseError === true ? 'statement-refused' as const : null }
      }
      if (sql.startsWith('\nSELECT pg_catalog.count(*)')) return { rows: [['0']], error: null }
      return { rows: [], error: null }
    },
    async close() { closes += 1 },
  }
}

export function proverStub(over: {
  locks?: string[][]; observedStart?: string | null; terminateRefused?: boolean
} = {}): Stub {
  const seen: string[] = []
  let closes = 0
  return {
    seen,
    closed: () => closes,
    /** A DIFFERENT backend: a prover that IS the supervisor is a self-proof. */
    pid: '41513',
    rows: async () => [] as string[][],
    alive: () => closes === 0,
    async send(sql: string) {
      seen.push(sql)
      if (sql === ACTIVITY_CENSUS_SQL) {
        return {
          rows: [[SUPERVISOR_PID, 'ai_capital_owner', 'client backend'],
                 [PROVING_PID, 'ai_capital_owner', 'client backend']],
          error: null,
        }
      }
      if (sql === SESSION_IDENTITY_SQL) {
        return { rows: [[PROVING_PID, 'ai_capital_owner', PROVER_START]], error: null }
      }
      if (sql.startsWith('SELECT pg_catalog.pg_terminate_backend')) {
        return { rows: [['t']], error: over.terminateRefused === true
          ? 'statement-refused' as const : null }
      }
      if (sql.startsWith('SELECT a.backend_start')) {
        if (over.observedStart === null) return { rows: [], error: null }
        return { rows: [[over.observedStart ?? BACKEND_START]], error: null }
      }
      if (sql === 'SELECT pg_catalog.pg_backend_pid()') {
        return { rows: [[PROVING_PID]], error: null }
      }
      return { rows: over.locks ?? wholeFence(), error: null }
    },
    async close() { closes += 1 },
  }
}

export const stopped: QuiescenceAdapter = {
  report: async () => REVIEWED_PRODUCERS.map(name => ({ name, stopped: true })),
}
export const empty: QueueAdapter = {
  sample: async () => ({ depths: Object.fromEntries(REVIEWED_QUEUES.map(q => [q, 0])) }),
}

/**
 * A hold that answers without a terminal, and records what happened to it.
 *
 * TAKES A SEQUENCE. The hold is a loop now: an operation that does not resolve
 * the fence is followed by another prompt, not by a return. A one-answer stub
 * would spin forever, which is itself the property under test - so the stub
 * gives the answers a person would, in order, and the LAST one is expected to
 * resolve. Running past the end is an explicit failure rather than a hang.
 */
export function scriptedHold(...actions: string[]): InterventionHold & {
  armed: () => number
  disarmed: () => number
  token: () => string
  asked: () => number
  states: () => readonly string[]
} {
  let armed = 0
  let disarmed = 0
  let asked = 0
  let seenToken = ''
  const states: string[] = []
  return {
    armed: () => armed,
    disarmed: () => disarmed,
    token: () => seenToken,
    asked: () => asked,
    states: () => states,
    arm() { armed += 1; return () => { disarmed += 1 } },
    async decide(state, _actions, token) {
      seenToken = token
      states.push(state)
      // THE LAST ANSWER REPEATS. The hold is a loop with no exit but
      // resolution, so a stub that ran out would either spin or throw forever;
      // repeating the operator's final choice is what a person at a terminal
      // would do and lets a test assert how many times they were asked.
      const action = actions[Math.min(asked, actions.length - 1)]
      asked += 1
      return { action: action as never, operator: 'operator-under-test', token }
    },
  }
}

/**
 * A prover that answers the GATE normally and reports the backend GONE once
 * `gone()` is true.
 *
 * A prover that reported the backend gone from the start would refuse the gate
 * itself - the gate confirms the supervisor's backend start from the
 * independent side - and the rehearsal would never reach a release at all.
 * What a hold needs is a prover that was fine when the fence was proved and
 * finds the backend gone afterwards.
 */
export function goneWhen(gone: () => boolean): FenceLike {
  const base = proverStub()
  return {
    pid: base.pid,
    rows: async () => [] as string[][],
    alive: () => base.alive(),
    send: async (sql: string) => {
      if (gone() && sql.startsWith('SELECT a.backend_start')) {
        return { rows: [], error: null }
      }
      return await base.send(sql)
    },
    close: () => base.close(),
  }
}

/** A prover whose backend is gone from the outset. Resolves a hold at once. */
export const goneProver = (): FenceLike => goneWhen(() => true)

export interface World {
  /**
   * SIMULATE THE MANUAL RESTORATION, without touching a single file.
   *
   * After this, `launchctl print` answers for the four installed labels as a
   * restored world does — daily/watchdog/alerts loaded and scheduled with a
   * successful last exit, worker running — while every plist, its digest, its
   * device:inode, the checkout it serves and the credential container it names
   * stay exactly as they were. That is precisely what an operator bootstrapping
   * the agents changes and all that they change, so it is the only thing this
   * simulation changes.
   *
   * Only meaningful for a world built with `restorable: true`; a no-op otherwise.
   */
  restore(): void
  readonly dir: string
  readonly evidence: string
  readonly agents: string
  readonly destinationPolicy: string
  readonly restorationPolicy: string
  readonly attestation: string
  readonly authorization: string
  readonly commands: CommandRunner
  readonly credential: string
}

/**
 * A complete offline world: five reviewed agents, three policies, one root.
 *
 * NOTHING LIVE IS REACHED. `launchctl` is never invoked at all - the adapter's
 * command runner is injected, which is the only seam there is now that the
 * binary is a constant. `plutil` IS run, on the bytes the adapter hands it,
 * because parsing is the one thing a fake would make meaningless.
 */
export function world(over: {
  restorationRequired?: string
  loaded?: boolean
  lastExit?: string
  structuredAbsent?: boolean
  /** Put every installed label in `print-disabled`. Needed for a real census. */
  disabled?: boolean
  /**
   * LABELS WHOSE PLIST BINDS NO CREDENTIAL CONTAINER — the daily/watchdog shape.
   *
   * Two reviewed agents are shell scripts that orchestrate the pipeline and hold no
   * database credential of their own. Their plists declare `AI_CAPITAL_ROOT`,
   * `DATA_ROOT`, `REDIS_URL` and friends and NO `PIPELINE_CREDENTIAL_FILE`, so the
   * census must classify them `no-postgresql-route`. Without this option the
   * fixture could only build writers, and the state would be untestable.
   *
   * The policy written for this world follows the same list, so a world is
   * internally consistent by default; a case that wants a DISAGREEMENT overrides
   * one side with `policyRoute`.
   */
  noRoute?: readonly string[]
  /** Declare these labels `no-postgresql-route` in the POLICY, whatever the plist says. */
  policyRoute?: readonly string[]
  /**
   * THE CUTOVER WORLD: the plists are installed and launchd holds no label.
   *
   * `launchctl print` answers 113 for every reviewed label, exactly as it does
   * after a bootout, while the four reviewed plist files stay on disk. This is
   * the state the machine is actually in after K5, and the state the
   * three-state vocabulary reported as expected-absent.
   */
  unloaded?: boolean
  /** Write the plists at this mode instead of 0644. Drives the safety refusals. */
  plistMode?: number
  /** Give the installed plists a Label key that disagrees with their filename. */
  wrongLabel?: boolean
  /**
   * A world that starts UNLOADED and can be restored in place by `w.restore()`.
   *
   * Implies `unloaded`, and writes the reviewed post-restoration policy:
   * daily/watchdog/alerts loaded-scheduled-healthy, worker running,
   * structured-worker absent.
   */
  restorable?: boolean
} = {}): World {
  // THE CANONICAL PATH. Every reviewed container check compares the supplied
  // name with its own realpath, and macOS `/var` is a symlink to `/private/var`.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
  ROOTS.push(dir)
  const evidence = join(dir, 'evidence')
  mkdirSync(evidence, { mode: 0o700 })
  chmodSync(evidence, 0o700)
  const agents = join(dir, 'agents')
  mkdirSync(agents)

  const cred = join(dir, 'pipeline.url')
  writeFileSync(cred, CREDENTIAL)
  chmodSync(cred, 0o600)

  // THE STRUCTURED WORKER IS EXPECTED-ABSENT on this machine, which is the
  // reviewed state and the reason installation is tracked separately from
  // where a producer writes.
  const structuredAbsent = over.structuredAbsent !== false
  const installed = REVIEWED_PRODUCERS.filter(
    l => !(structuredAbsent && l.endsWith('.structured-worker')))

  for (const label of installed) {
    const p = join(agents, `${label}.plist`)
    // A REAL PLIST DECLARES ITS OWN LABEL, and the installed-unloaded path
    // requires it: that path DERIVES the filename from the label, so the
    // document's own `Label` is the only thing tying the two together.
    const declared = over.wrongLabel === true ? `${label}.not-this-agent` : label
    // THE ONE DIFFERENCE A NO-ROUTE AGENT HAS: no credential key. Everything else
    // about the document - its own Label, its working directory, its mode - is
    // identical, so a case asserting the classification is asserting on that one
    // fact and not on some other difference.
    const env = (over.noRoute ?? []).includes(label)
      ? `<key>AI_CAPITAL_ROOT</key><string>${dir}</string>
<key>SCHEDULER_HEARTBEAT_FILE</key><string>${join(dir, 'heartbeat.log')}</string>`
      : `<key>PIPELINE_CREDENTIAL_FILE</key><string>${cred}</string>`
    writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${declared}</string>
<key>WorkingDirectory</key><string>${dir}</string>
<key>EnvironmentVariables</key><dict>
${env}
</dict></dict></plist>`)
    chmodSync(p, over.plistMode ?? 0o644)
  }

  const restorable = over.restorable === true
  const startsUnloaded = over.unloaded === true || restorable
  // `restored` flips only what launchctl ANSWERS. No file is written, renamed,
  // chmod-ed or re-hashed, so every stable identity field is untouched by it.
  let restored = false
  const state = over.loaded === false ? 'not running' : 'running'
  const pid = over.loaded === false ? undefined : '4242'
  const answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {
    'print-disabled gui/501': {
      code: 0,
      stdout: over.disabled === true
        ? installed.map(l => `\t"${l}" => true\n`).join('') : '',
    },
  }
  // THE CUTOVER WORLD ANSWERS NOTHING. With no `print` entry the runner's
  // default reply is exit 113 "Could not find service" - the one spelling of
  // absence - for every reviewed label, while the plists remain on disk.
  if (!startsUnloaded) {
    for (const label of installed) {
      answers[`print gui/501/${label}`] = {
        code: 0,
        stdout: `\tpath = ${join(agents, `${label}.plist`)}\n\tstate = ${state}\n` +
          `${pid === undefined ? '' : `\tpid = ${pid}\n`}` +
          `\tlast exit code = ${over.lastExit ?? '0'}\n`,
      }
    }
  }

  const commands: CommandRunner = {
    openPlist: openReviewedPlist,
    run: async (file, args) => {
      if (file.endsWith('plutil')) {
        // THE BYTES GO ON STDIN, exactly as the production runner sends them.
        //
        // This used to mkdtemp a directory per call and write the plist into it,
        // and it never removed any of them: one full suite run leaked a temp
        // directory for every plist parsed, and the machine had accumulated
        // 820,101 of them (about 4 GiB) by the time this was measured. Passing
        // the bytes on stdin removes the file, the directory and the leak
        // together, and is closer to what `parsePlistBytes` actually does.
        const text = args[args.length - 1] as string
        try {
          return {
            code: 0, stderr: '',
            stdout: execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
                                 { encoding: 'utf-8', input: text }),
          }
        } catch { return { code: 1, stdout: '', stderr: '' } }
      }
      if (file.endsWith('/ps')) {
        // NO REVIEWED PRODUCER PROCESS. The census is real; what it looks at is
        // this suite's own table, and a producer started by hand would appear
        // here exactly as it would in production.
        const a = answers.ps ?? { code: 0, stdout: '  1 /sbin/launchd\n' }
        return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
      }
      const key = `${args[0]} ${args[1] ?? ''}`.trim()
      // A RESTORED WORLD ANSWERS FOR THE FOUR INSTALLED LABELS. The scheduled
      // agents are loaded and idle with a successful last exit — which is what a
      // healthy calendar job looks like between runs — and the worker is running.
      if (restored && args[0] === 'print') {
        const label = String(args[1]).split('/').pop() as string
        if (installed.includes(label)) {
          const isWorker = label.endsWith('.worker')
          return {
            code: 0, stderr: '',
            stdout: `\tpath = ${join(agents, `${label}.plist`)}\n` +
              `\tstate = ${isWorker ? 'running' : 'not running'}\n` +
              `${isWorker ? '\tpid = 4242\n' : ''}` +
              '\tlast exit code = 0\n',
          }
        }
      }
      const a = answers[key] ?? { code: 113, stderr: 'Could not find service\n' }
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
    },
  }

  const destinationPolicy = join(dir, 'destinations.json')
  // THE POLICY DECLARES THE STABLE TOPOLOGY, which is the same in every one of
  // these worlds: the plists are installed. Whether the labels are loaded,
  // disabled or unloaded is a phase-specific observation the quiescence and
  // post-restoration policies own, and declaring it here is exactly what made a
  // single policy unable to hold across a restoration.
  const declaredInstallation = 'installed'
  const policyNoRoute = over.policyRoute ?? over.noRoute ?? []
  writeFileSync(destinationPolicy, JSON.stringify({
    producers: REVIEWED_PRODUCERS.map(label => installed.includes(label)
      ? {
        label,
        expected: policyNoRoute.includes(label) ? 'no-postgresql-route' : 'writes-copy-source',
        installation: declaredInstallation,
      }
      : { label, expected: 'expected-absent', installation: 'expected-absent' }),
  }))
  const restorationPolicy = join(dir, 'restoration.json')
  writeFileSync(restorationPolicy, JSON.stringify({
    producers: REVIEWED_PRODUCERS.map(label => ({
      label,
      required: !installed.includes(label) ? 'absent'
        // THE REVIEWED POST-RESTORATION POLICY: the three scheduled agents come
        // back loaded and healthy, and the worker comes back running.
        : restorable ? (label.endsWith('.worker') ? 'running' : 'loaded-scheduled-healthy')
        : (over.restorationRequired ?? 'running'),
    })),
  }))
  const attestation = join(dir, 'attestation.json')
  writeFileSync(attestation, JSON.stringify({
    authorized_by: 'operator-under-test',
    authorized_at: '2026-09-25T10:00:00Z',
    procedure: 'manual A-G stop, reviewed 2026-09-25',
  }))
  chmodSync(attestation, 0o600)
  const authorization = join(dir, 'authorization.txt')
  writeFileSync(authorization, 'rehearsal authorised by the operator on 2026-09-25\n')
  chmodSync(authorization, 0o600)

  return { dir, evidence, agents, destinationPolicy, restorationPolicy,
           attestation, authorization, commands, credential: cred,
           restore: () => { restored = true } }
}

export function base(w: World, extra: readonly string[] = []): string[] {
  return [
    `--evidence-root=${w.evidence}`,
    `--destination-policy=${w.destinationPolicy}`,
    `--post-restoration-policy=${w.restorationPolicy}`,
    `--agents-dir=${w.agents}`,
    '--source-host=/tmp/s', '--source-port=5432', '--source-database=ai_capital',
    // SELECTORS ONLY. The source system identifier and this implementation's
    // HEAD used to be stated here and folded into the binding, which made the
    // binding agree with whatever was typed. Both are measured now.
    `--checkout=${w.dir}`,
    '--redis-host=127.0.0.1', '--redis-port=6379', '--redis-db=0',
    ...extra,
  ]
}

/**
 * WAS A HOLD ENTERED WITH NO SCRIPTED RESOLVER?
 *
 * Recorded rather than thrown. A `decide` that throws is not an escape - the
 * hold treats a failed resolution as an unresolved attempt and keeps holding -
 * so throwing here would produce exactly the runaway it is meant to prevent.
 * The in-process suite reads this in `afterEach` and names the test; a CONTAINED
 * run's parent sees it in the child's own report.
 */
let unscripted: string | null = null

/** Read and clear the unscripted-hold record. */
export function takeUnscriptedHold(): string | null {
  const v = unscripted
  unscripted = null
  return v
}

/**
 * Be told the MOMENT an unscripted hold is entered, rather than afterwards.
 *
 * A contained child that reaches one never returns, so there is no afterwards in
 * which to read `takeUnscriptedHold`. The observer lets the child write the fact
 * to its progress file while it still can, which is the only way its parent can
 * report WHY it had to kill it.
 */
let observer: ((message: string) => void) | null = null
export function observeUnscriptedHold(fn: (message: string) => void): void {
  observer = fn
}

/**
 * The resolver a test gets when it did not supply one.
 *
 * IT RESOLVES NOTHING, ON PURPOSE. A default that quietly resolved would hide
 * the fact that the test reached a hold at all, which is the thing worth
 * knowing. Since nothing injected can end a hold any more, a test that reaches
 * this WILL run until its container kills it - which is why `deps()` installs
 * it unconditionally and an override has to be deliberate.
 */
export const forbiddenHold = (): InterventionHold => ({
  arm: () => () => undefined,
  decide: async (state, _actions, token) => {
    unscripted = `a hold was entered in state ${state} with no scripted resolver`
    observer?.(unscripted)
    return { action: 'CENSUS_ONLY' as never, operator: 'harness-guard', token }
  },
})

let runIdSeq = 0
export function deps(w: World, over: Partial<OpsDeps> = {}): OpsDeps {
  void w
  runIdSeq = 0
  return {
    // THE GUARD, ON EVERY SINGLE INVOCATION. A test may override `hold`, and
    // most do; what it may not do is reach a hold with no resolver. There is no
    // ceiling to fall back on any more - `__maxAttempts` is gone, because a
    // production hold that could be made finite is not a hold - so an
    // unscripted hold is recorded here and stopped from OUTSIDE the process.
    hold: forbiddenHold(),
    // A FRESH ID PER CALL, because the hold mints one per attempt and every
    // published bundle name must be unique. The first is the fixed one the
    // acting modes were invoked with.
    newRunId: () => runIdSeq++ === 0 ? RUN_ID : `f${runIdSeq.toString(16).padStart(7, '0')}`,
    stamp: () => STAMP,
    commands: w.commands,
    quiescence: stopped,
    queue: empty,
    destinations: { measure: async () => FENCED_CENSUS },
    sleep: async () => undefined,
    openSupervisor: async () => supervisorStub(),
    openProver: async () => proverStub(),
    // READ-ONLY IDENTITY SESSIONS and a MEASURED provenance. Injected so no
    // test opens a database or runs git - and so nothing operator-supplied can
    // reach a copy binding, which is the property under test.
    openSourceIdentity: async () => sourceIdentity(),
    openTargetIdentity: async () => targetIdentity(),
    measureRepository: async () => provenance,
    acquireFence: async () => ({
      supervisorPid: SUPERVISOR_PID, backendStart: BACKEND_START, mechanism: 'S3' as const,
    }),
    deadlineMs: 5_000,
    ...over,
  }
}

/**
 * The FENCED census, which must agree with the pre-fence one.
 *
 * Filled in per-world by `censusFor`, because the binding's producer records
 * carry real paths and digests from that world's own files.
 */
export let FENCED_CENSUS: readonly ProducerCensusRow[] = []

/** The token this world's inspection prints, for the named mode. */
export async function tokenFor(
  w: World, mode: 'rehearse' | 'apply', d?: OpsDeps,
): Promise<string> {
  const r = await runOpsCli(
    base(w, [`--for=${mode}`, `--rehearsal-authorization=${w.authorization}`, '--inspect']),
    d ?? deps(w))
  // THROWS RATHER THAN ASSERTS. This module is imported by a child process
  // that has no test framework, so a failure here has to be an ordinary error.
  if (r.exitCode !== 0) {
    throw new Error(`the inspection refused: ${r.lines.join(' | ')}`)
  }
  const line = r.lines.find(l => l.startsWith('confirmation '))
  if (line === undefined) throw new Error(`no confirmation printed: ${r.lines.join(' | ')}`)
  return line.slice('confirmation '.length)
}

/** Measure this world once, and use the result as the fenced census. */
export async function primeCensus(w: World): Promise<void> {
  const binding = await deriveOperationalBinding({
    source: { host: '/tmp/s', port: '5432', database: 'ai_capital' },
    sourceSystemIdentifier: '7300000000000000001',
    evidenceRoot: w.evidence,
    postRestorationPolicyPath: w.restorationPolicy,
    destinationPolicyPath: w.destinationPolicy,
    implementationHead: '0'.repeat(40),
    launchd: { uid: '501', agentsDir: w.agents, commands: w.commands },
    redis: resolveRedis({ host: '127.0.0.1', port: '6379', db: '0' }),
  }, 5_000)
  FENCED_CENSUS = binding.producers as unknown as ProducerCensusRow[]
}

/** Executable text only: a module that NAMES a thing in prose has not used it. */
export const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

export const fileDigestOf = (dir: string): string =>
  createHash('sha256').update(readFileSync(join(dir, 'DIGEST'))).digest('hex')

/**
 * A REAL Stage-1 bundle on disk, for the apply inspection to bind against.
 *
 * Published through the reviewed evidence machinery, so `readPublishedBundle`
 * verifies its DIGEST the way it would for a real one.
 */
export function stage1Bundle(w: World, over: {
  /** REPLACES the whole `source` object, so a field can be left out entirely. */
  readonly source?: Record<string, unknown>
  readonly runId?: string
  /** Overrides for the run identity the manifest records about itself. */
  readonly runIdField?: string
  readonly generatedAtUtc?: string
  readonly stamp?: string
} = {}): string {
  const contract = {
    pgcopy_schema_contract_version: 2,
    digest: contractDigest({ migrations: { recognition: 'CURRENT_V10' } } as never),
    payload: { migrations: { recognition: 'CURRENT_V10' } },
    generated_at: '2026-09-25T10:00:00Z',
  }
  const stamp = over.stamp ?? STAMP
  const runId = over.runId ?? 'bbbbbbbb'
  const document = {
    complete: true,
    // K7-B7.1: THE RUN THIS MANIFEST WAS WRITTEN FOR, and when. The copy chain
    // reads both from the verified manifest object, so a fixture without them
    // is not a Stage-1 bundle any production chain would accept.
    run_id: over.runIdField ?? runId,
    generated_at_utc: over.generatedAtUtc ??
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
      `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    source_contract: { digest: contract.digest },
    source: over.source ?? {
      system_identifier: '7300000000000000001',
      database: 'ai_capital',
      role: 'ai_capital_v3_export',
      session_user: 'ai_capital_v3_export',
    },
    // THE PROVENANCE THE EXPORT WAS TAKEN AT. Measured `git` values are
    // compared with these; a binding may not pair Stage-1 content with an
    // unrelated later checkout.
    provenance: {
      head: '0'.repeat(40),
      ingestion_gitlink: '1'.repeat(40),
    },
    content: {
      root_digest: 'b'.repeat(64),
      tables: COPY_TABLES.map(q => ({ qname: q, digest: 'c'.repeat(64) })),
    },
  }
  return publishEvidence({
    root: w.evidence, prefix: 'source-manifest', stamp,
    runId,
    artifacts: [{ path: 'source-contract.json',
                  bytes: Buffer.from(`${serializeArtifact(contract as never)}\n`, 'utf-8') }],
    manifest: { path: 'manifest.json',
                bytes: Buffer.from(`${JSON.stringify(document)}\n`, 'utf-8') },
  }).finalPath
}

/**
 * WHICH evidence and WHICH repository - and nothing about what they contain.
 *
 * The target identity, the provenance HEAD and the ingestion gitlink used to
 * be options here. They are gone: a token computed from what an operator typed
 * agrees with whatever they typed, including a wrong target.
 */
export const applyScope = (bundleDir: string): string[] => [
  `--bundle-dir=${bundleDir}`,
  // WHERE TO LOOK for the target, not what will be found there. Every
  // identity FACT comes back from the session this opens.
  '--target-host=/Users/x/ai-capital-v3-run',
  '--target-port=5433',
  '--target-database=ai_capital_v3',
  // K8-B: `--target-user` is gone. The target user comes from the one reviewed
  // target driver credential and is proved equal to the measured target role.
]

/**
 * A session that answers `MEASURED_IDENTITY_SQL` in the reviewed form.
 *
 * SEVEN COLUMNS: system identifier, database, CURRENT_USER, SESSION_USER,
 * port, `inet_server_addr()` (empty for a Unix socket) and whether that
 * function returned NULL. `unix_socket_directories` is deliberately absent -
 * it is the server's configured LIST, needs `pg_read_all_settings`, and names
 * no session's actual path.
 */
export const identitySession = (
  row: readonly string[], over: Partial<Record<number, string>> = {},
): FenceLike => ({
  pid: '41599',
  rows: async () => [] as string[][],
  alive: () => true,
  send: async () => ({
    rows: [row.map((v, n) => over[n] ?? v)],
    error: null,
  }),
  close: async () => undefined,
})

/** A source session that reports the identity the Stage-1 fixture describes. */
export const sourceIdentity = (over: Partial<Record<number, string>> = {}): FenceLike =>
  identitySession(['7300000000000000001', 'ai_capital', 'ai_capital_v3_export',
                   'ai_capital_v3_export', '5432', '', 'true'], over)

/** A target session that reports the reviewed target's identity. */
export const targetIdentity = (over: Partial<Record<number, string>> = {}): FenceLike =>
  identitySession(['7689229024919775999', 'ai_capital_v3', 'ai_capital_migrator',
                   'ai_capital_migrator', '5433', '', 'true'], over)

/** The measured provenance. Injected so no test runs git. */
export const provenance = {
  head: '0'.repeat(40),
  ingestionGitlink: '1'.repeat(40),
}

export const bundles = (root: string, prefix: string): string[] =>
  readdirSync(root).filter(n => n.startsWith(`${prefix}-`))

/** Every bundle of one prefix, in publication order. */
export const allBundles = (root: string, prefix: string): string[] => bundles(root, prefix).sort()

/** The single bundle of one prefix. Asserts there is exactly one. */
export const onlyBundle = (root: string, prefix: string): string => {
  const found = bundles(root, prefix)
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${prefix} bundle, found: ${found.join(', ')}`)
  }
  return found[0] as string
}

export const manifestOf = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>


// ---------------------------------------------------------------------------
// ENTRY HELPERS
// ---------------------------------------------------------------------------

/** Every acting mode runs against a primed fenced census. */
export async function ready(over: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world(over)
  await primeCensus(w)
  return w
}

export const rehearseArgs = (
  w: World, token: string, extra: readonly string[] = [],
): string[] =>
  base(w, [
    '--rehearse', `--confirm=${token}`,
    `--rehearsal-authorization=${w.authorization}`,
    `--quiescence-attestation=${w.attestation}`,
    `--run-id=${RUN_ID}`, `--stamp=${STAMP}`, ...extra,
  ])
