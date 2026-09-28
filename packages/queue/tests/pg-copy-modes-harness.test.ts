// THE HARNESS'S OWN CONTRACT, TESTED THE WAY THE PRODUCT IS.
//
// WHAT THIS FILE IS ABOUT, AND WHAT IT IS NOT. Nothing here asserts anything
// about pg-copy. These are the properties of the TEST HARNESS that the modes
// suite's safety rests on, and they were the ones nobody had written down: the
// cleanup lived in a worker-local `afterEach` and in the parent half of the
// container, both inside the Vitest worker, so interrupting the outer command
// skipped all of it. The detached hold child was reparented to PPID 1 and went on
// publishing into a root no surviving process knew about. Forty abandoned roots
// were sitting in the real temporary directory when this was found, and every one
// of them had passed a green test run.
//
// SO THE HARNESS GETS THE SAME TREATMENT THE PRODUCT GETS: the failure is
// reproduced as a case, the correction is asserted behaviourally, and the safety
// checks are asserted to REFUSE as well as to permit - a cleanup that removed
// everything would pass every "it was removed" test ever written.

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  NONCE_ENV, NotOurRoot, ROOT_PREFIX_FOR, mintNonce, parseRootName, provenRoot,
  realTmp, removeProvedRoot,
} from './support/roots.js'

const HERE = new URL('.', import.meta.url).pathname
const QUEUE_PKG = join(HERE, '..')
const RUNNER = join(HERE, 'support', 'modes-runner.ts')
const STUB = join(HERE, 'support', 'harness-stub.ts')

/**
 * RUN A TYPESCRIPT ENTRY POINT AS ONE PROCESS, NOT TWO.
 *
 * WHY NOT `node_modules/.bin/tsx`. That launcher spawns a SECOND node process and
 * then forwards some signals to it and not others - SIGINT and SIGTERM yes,
 * SIGHUP and SIGQUIT no - and exits on its own, leaving the real process
 * reparented to init with its group intact. Measured: two of the four signal
 * cases below failed against the launcher while the runner was correct, and six
 * abandoned processes were left behind by that one run. `--import tsx` loads the
 * same compiler into THIS process, so the pid a case signals is the pid that
 * handles it, and what the case measures is the runner rather than the launcher.
 */
const asNode = (entry: string, args: readonly string[]): string[] =>
  ['--import', 'tsx', entry, ...args]

/** Everything this file made, removed however the case ended. */
const MADE: string[] = []
/** Processes a case may have left running, ended however the case ended. */
const STRAYS: number[] = []

afterEach(() => {
  for (const pid of STRAYS.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* it ended itself, which is the point */ }
  }
  for (const p of MADE.splice(0)) {
    if (!existsSync(p)) continue
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', p]) } catch { /* already writable */ }
    rmSync(p, { recursive: true, force: true })
  }
})

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>(r => { setTimeout(r, ms) })

/**
 * A PRIVATE TEMPORARY DIRECTORY FOR ONE NESTED RUNNER.
 *
 * WHY EVERY NESTED RUNNER NEEDS ONE, MEASURED. Without it a runner spawned here
 * inherits this invocation's nonce from the environment, decides that every root
 * carrying that nonce is its own, and removes them at exit - including the world
 * roots and control directories of the modes suite running at that moment in a
 * PARALLEL WORKER. That is not hypothetical: it deleted a contained child's
 * `spec.json` out from under it and produced five `crashed` children and nine
 * failures in one full-suite run. A nested runner also REAPS at startup, and a
 * stale root belonging to a sibling worker is exactly what it would reap.
 *
 * So each one gets a directory of its own, and everything a case plants for it -
 * a stale root, a foreign sentinel - is planted in there. The name deliberately
 * does NOT match the reviewed root form, so the runner inside treats it as the
 * temporary directory rather than as something to remove.
 */
function box(): string {
  const d = mkdtempSync(join(realTmp(), 'k536-box-'))
  MADE.push(d)
  return d
}

/** The roots inside one box, by the same name test the harness itself uses. */
const rootsIn = (dir: string): readonly string[] =>
  readdirSync(dir).filter(n => parseRootName(n) !== null)

/** Spawn the runner over the stub, and hand back what is needed to drive it. */
function runner(mode: string, dir: string = box()): {
  pid: number; dir: string; stdout: () => string; stderr: () => string
  ended: Promise<{ code: number | null; signal: string | null }>
} {
  // ITS OWN NONCE, NOT THIS ONE'S. Inheriting the nonce is what made a nested
  // runner believe a sibling worker's directories were its own.
  const env = { ...process.env, TMPDIR: dir }
  delete env[NONCE_ENV]
  const child = spawn(process.execPath,
    asNode(RUNNER, ['--', process.execPath, ...asNode(STUB, [mode])]), {
    cwd: QUEUE_PKG,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    // ITS OWN PROCESS GROUP, so a case can signal it the way a TERMINAL does.
    //
    // WHY THAT MATTERS AND IS NOT A DETAIL. ^C delivers the signal to the whole
    // foreground group, not to one pid. Signalling the launcher alone measures
    // whether `tsx` forwards that particular signal - it forwards SIGINT and
    // SIGTERM and does not forward SIGHUP or SIGQUIT - rather than whether the
    // runner does its job. Signalling the group asks the question the incident
    // actually poses.
    detached: true,
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8') })
  child.stderr.on('data', (b: Buffer) => { err += b.toString('utf-8') })
  return {
    pid: child.pid as number,
    dir,
    stdout: () => out,
    stderr: () => err,
    ended: new Promise(resolve => {
      child.on('exit', (code, signal) => { resolve({ code, signal }) })
    }),
  }
}

/** Wait until the stub has reported itself, or give up. */
async function reported(r: { stdout: () => string }, within = 20_000): Promise<{
  pid: number; root: string
}> {
  const until = Date.now() + within
  for (;;) {
    const line = r.stdout().split('\n')[0]
    if (line !== undefined && line.length > 0) {
      const [pid, root] = line.split(' ')
      MADE.push(root as string)
      return { pid: Number(pid), root: root as string }
    }
    if (Date.now() > until) throw new Error('the stub never reported a root')
    await sleep(25)
  }
}

/** The stub's root only, for the cases that never need to signal it. */
const rootOf = async (r: { stdout: () => string }): Promise<string> =>
  (await reported(r)).root

/** Is any process other than this one still naming that path? */
function referencedByAnyProcess(path: string): boolean {
  const table = execFileSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' })
  for (const line of table.split('\n')) {
    const m = /^\s*([0-9]+)\s+(.*)$/.exec(line)
    if (m === null || Number(m[1]) === process.pid) continue
    if ((m[2] as string).includes(path)) return true
  }
  return false
}

const bundles = (root: string): number => {
  try { return readdirSync(join(root, 'evidence')).length } catch { return 0 }
}

// ---------------------------------------------------------------------------

describe('an interrupted runner takes everything it owns with it', () => {
  /**
   * THE ORIGINAL DEFECT, AS A CASE.
   *
   * ^C on the outer command used to kill the worker and leave the detached child
   * publishing. The assertion is deliberately in two halves, because only one of
   * them was ever true before: nothing is left RUNNING, and nothing is left ON
   * DISK. A correction that killed the child but forgot the root, or removed the
   * root while the child kept recreating it, passes one and fails the other.
   */
  it('kills the whole group and removes every owned root on SIGINT', async () => {
    const r = runner('hold')
    const root = await rootOf(r)
    // IT IS REALLY PUBLISHING before the interrupt, or the case proves nothing.
    const until = Date.now() + 10_000
    while (bundles(root) < 3 && Date.now() < until) await sleep(25)
    expect(bundles(root), 'the stub published before the interrupt').toBeGreaterThanOrEqual(3)

    process.kill(-r.pid, 'SIGINT')
    const end = await r.ended

    expect(end.code, 'the runner exits as interrupted, not as a pass').toBe(130)
    expect(r.stderr(), 'and said what it did').toContain('SIGINT: killed the command group')
    expect(existsSync(root), 'the owned root was removed').toBe(false)
    expect(referencedByAnyProcess(root), 'no process still holds it').toBe(false)
  }, 45_000)

  /** The other three, which a handler list is easy to write half of. */
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    it(`does the same on ${sig}`, async () => {
      const r = runner('hold')
      const root = await rootOf(r)
      process.kill(-r.pid, sig)
      await r.ended
      // THE EFFECT, AND THE RUNNER SAYING IT CAUSED IT.
      //
      // The exit STATUS is deliberately not asserted here. The process this case
      // launched is `tsx`, which forwards SIGINT and SIGTERM and dies on SIGHUP
      // and SIGQUIT without forwarding anything - so its status reports what the
      // launcher did, not what the runner did. The runner's own line proves the
      // handler ran, and the absent root proves it finished.
      expect(r.stderr(), `${sig} reached the runner`)
        .toContain(`${sig}: killed the command group`)
      expect(existsSync(root), 'the owned root was removed').toBe(false)
      expect(referencedByAnyProcess(root), 'no process still holds it').toBe(false)
    }, 45_000)
  }
})

describe('a runner that is killed outright still cannot leave a runaway', () => {
  /**
   * THE CASE NO PARENT CAN COVER.
   *
   * SIGKILL to the runner - or a power cut, or an OOM kill - leaves nothing able
   * to send a signal to anything. So the child has to stop by itself, and the
   * check that makes it stop is the ORPHAN check rather than any ceiling: the run
   * it belonged to is over the moment its parent is gone, whatever its counters
   * say. The runner is killed with SIGKILL to the PID ALONE, deliberately, so the
   * group survives it and the child's own logic is the only thing left.
   */
  it('the orphaned child terminates itself and stops publishing', async () => {
    const r = runner('hold')
    const root = await rootOf(r)
    const until = Date.now() + 10_000
    while (bundles(root) < 3 && Date.now() < until) await sleep(25)
    const atKill = bundles(root)
    expect(atKill, 'the stub was publishing').toBeGreaterThanOrEqual(3)

    // NOT THE GROUP. Killing the group would take the stub with it and prove
    // nothing about what the stub does on its own.
    process.kill(r.pid, 'SIGKILL')
    await r.ended

    // IT STOPS, AND IT STOPS SOON. The orphan check runs on every publish, so the
    // bound is the publish interval and not a ceiling's timeout.
    const settled = Date.now() + 15_000
    let last = bundles(root)
    for (;;) {
      await sleep(500)
      const now = bundles(root)
      if (now === last) break
      last = now
      if (Date.now() > settled) break
    }
    const a = bundles(root)
    await sleep(1_500)
    expect(bundles(root), 'publication has stopped for good').toBe(a)
    expect(referencedByAnyProcess(root), 'the orphaned child is gone').toBe(false)
  }, 60_000)
})

describe('a child that is orphaned at birth stops without being told', () => {
  /**
   * THE `ppid === 1` BRANCH, ON ITS OWN.
   *
   * WHY IT NEEDS ITS OWN CASE. `orphaned()` asks two independent questions - has
   * this process been reparented to init, and is the runner it was told about
   * still alive - and the SIGKILL case above answers both at once, so deleting
   * either one left the case passing. Measured: removing the reparenting check
   * survived the whole set. Here the child is handed NO runner pid and its
   * launcher exits immediately, so reparenting is the only thing that can stop
   * it, and nothing else is left that could.
   */
  it('publishes nothing and is gone, with no runner to ask about', async () => {
    const dir = box()
    const env = {
      ...process.env,
      TMPDIR: dir,
      // THE OTHER CEILINGS LIFTED OUT OF THE WAY, DELIBERATELY.
      //
      // With the defaults in force this case passed even with the reparenting
      // check deleted, because eighty bundles arrive in under a second and the
      // BUNDLE ceiling stopped the child instead - a pass that said nothing about
      // the branch under test. Measured: the mutant survived. Raising the other
      // two leaves reparenting as the only thing that can end this process.
      PGCOPY_MODES_CHILD_MAX_BUNDLES: '1000000',
      PGCOPY_MODES_CHILD_MAX_BYTES: String(64 * 1024 * 1024 * 1024),
      PGCOPY_MODES_CHILD_WALL_CLOCK_MS: '3600000',
    }
    delete env[NONCE_ENV]
    delete env.PGCOPY_MODES_RUNNER_PID
    // THE LAUNCHER EXITS AND THE CHILD DOES NOT. `sh` starts it in the background
    // and returns at once, so the child is reparented to init while keeping the
    // stdout pipe it was given - which is how its root is still readable here.
    const child = spawn('/bin/sh',
      ['-c', '"$0" "$@" & exit 0', process.execPath, ...asNode(STUB, ['hold'])],
      { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8') })

    const until = Date.now() + 20_000
    let root = ''
    let pid = 0
    for (;;) {
      const line = out.split('\n')[0]
      if (line !== undefined && line.length > 0) {
        const [p, r] = line.split(' ')
        pid = Number(p); root = r as string
        break
      }
      if (Date.now() > until) throw new Error('the stub never reported a root')
      await sleep(25)
    }
    MADE.push(root)
    // AND IT IS ENDED HERE IF IT DID NOT END ITSELF. With every other ceiling
    // raised, a regression in the branch under test is an UNBOUNDED publisher, and
    // a failing assertion must not be the thing that leaves one running.
    STRAYS.push(pid)

    // IT STOPS AT ONCE, because the check runs on the very first publish.
    await sleep(2_000)
    const settled = bundles(root)
    await sleep(2_000)
    expect(bundles(root), 'publication stopped immediately').toBe(settled)
    expect(referencedByAnyProcess(root), 'and the process is gone').toBe(false)
  }, 45_000)
})

describe('a child whose runner died stops even with its own parent alive', () => {
  /**
   * THE OTHER BRANCH OF `orphaned()`, WHICH REPARENTING CANNOT COVER.
   *
   * WHY IT IS NOT REDUNDANT, AND WHY THAT TOOK A THIRD PROCESS TO SHOW. In the
   * cases above the child's direct parent IS the runner, so killing the runner
   * reparents the child to init and the `ppid === 1` check alone accounts for
   * everything - deleting the runner-pid check changed nothing and the mutant
   * survived. The real topology has three levels: runner, Vitest worker, contained
   * child. Kill the runner there and the child's parent is still the worker, so
   * reparenting never happens and NOTHING would notice that the process which was
   * going to remove these roots is gone. That is this case, built with the same
   * three levels: a live intermediate parent, and a separate process standing in
   * for the runner, killed.
   */
  it('notices the runner is gone though it was never reparented', async () => {
    const dir = box()
    // THE STAND-IN RUNNER. It only has to exist and then not exist.
    const standIn = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
    const env = {
      ...process.env,
      TMPDIR: dir,
      PGCOPY_MODES_RUNNER_PID: String(standIn.pid),
      // EVERY OTHER CEILING OUT OF THE WAY, so only this branch can end the child.
      PGCOPY_MODES_CHILD_MAX_BUNDLES: '1000000',
      PGCOPY_MODES_CHILD_MAX_BYTES: String(64 * 1024 * 1024 * 1024),
      PGCOPY_MODES_CHILD_WALL_CLOCK_MS: '3600000',
    }
    delete env[NONCE_ENV]
    // THE INTERMEDIATE PARENT, WHICH SURVIVES. `wait` keeps it alive holding the
    // child, so the child is never reparented to init.
    const mid = spawn('/bin/sh',
      ['-c', '"$0" "$@" & wait', process.execPath, ...asNode(STUB, ['hold'])],
      { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    mid.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8') })
    STRAYS.push(mid.pid as number)

    const until = Date.now() + 20_000
    let root = ''
    let pid = 0
    for (;;) {
      const line = out.split('\n')[0]
      if (line !== undefined && line.length > 0) {
        const [p, r] = line.split(' ')
        pid = Number(p); root = r as string
        break
      }
      if (Date.now() > until) throw new Error('the stub never reported a root')
      await sleep(25)
    }
    MADE.push(root)
    STRAYS.push(pid)

    // IT IS PUBLISHING, AND ITS PARENT IS NOT INIT. Both halves are asserted,
    // because a case where the child had already been reparented would be the
    // previous case over again and would say nothing about this branch.
    while (bundles(root) < 3 && Date.now() < until) await sleep(25)
    expect(bundles(root), 'the stub was publishing').toBeGreaterThanOrEqual(3)
    const ppid = execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)],
      { encoding: 'utf-8' }).trim()
    expect(ppid, 'its parent is the intermediate, not init').not.toBe('1')

    process.kill(standIn.pid as number, 'SIGKILL')

    await sleep(2_000)
    const settled = bundles(root)
    await sleep(2_000)
    expect(bundles(root), 'publication stopped once the runner was gone').toBe(settled)
    expect(referencedByAnyProcess(root), 'and the child ended itself').toBe(false)
  }, 60_000)
})

describe('a later invocation reaps what an interrupted one left', () => {
  /**
   * AND REAPS IT AS A BOUNDED, VALIDATED, EXACT PATH.
   *
   * The stale root is built the way a killed run leaves one - published evidence
   * frozen 0500/0400, which a plain recursive remove cannot descend into - so the
   * case also proves the unfreeze happens, and happens inside the root.
   */
  it('removes a stale frozen root that nothing references', async () => {
    const dir = box()
    const stale = mkdtempSync(join(dir, ROOT_PREFIX_FOR(mintNonce(), 4242)))
    const evidence = join(stale, 'evidence')
    mkdirSync(evidence, { mode: 0o700 })
    const bundle = join(evidence, 'rehearsal-20260925T101500Z-a1b2c3d4')
    mkdirSync(bundle, { mode: 0o700 })
    writeFileSync(join(bundle, 'DIGEST'), 'stale\n', { mode: 0o600 })
    chmodSync(join(bundle, 'DIGEST'), 0o400)
    chmodSync(bundle, 0o500)
    chmodSync(evidence, 0o500)

    const r = runner('pass', dir)
    const end = await r.ended
    expect(end.code, 'the ordinary command passed').toBe(0)
    expect(existsSync(stale), 'the stale root was reaped').toBe(false)
    expect(r.stderr(), 'and said so').toContain('reaped 1 stale root')
  }, 45_000)

  /**
   * AND SPARES ONE THAT IS STILL IN USE.
   *
   * A sibling invocation running right now has roots with a different nonce too,
   * and removing them underneath it is the same defect in the other direction. The
   * proof is a live process that names the path - here, a sleep whose command line
   * carries it.
   */
  it('spares a stale root some live process still references', async () => {
    const dir = box()
    const stale = mkdtempSync(join(dir, ROOT_PREFIX_FOR(mintNonce(), 4243)))
    // THE PATH HAS TO STAY IN ITS COMMAND LINE, which is what the reaper reads.
    // `sh -c 'sleep 30'` EXECS the sleep and replaces its own argv, losing the
    // path and making this case vacuous - measured: it removed the root and the
    // assertion caught it. The trailing `; :` stops that optimisation, so the
    // shell stays alive holding the argv it was given.
    const holder = spawn('/bin/sh', ['-c', 'sleep 30; :', stale],
      { stdio: 'ignore', detached: true })
    try {
      await sleep(400)
      const r = runner('pass', dir)
      await r.ended
      expect(existsSync(stale), 'a referenced stale root is left alone').toBe(true)
    } finally {
      try { process.kill(-(holder.pid as number), 'SIGKILL') } catch { /* gone */ }
      try { process.kill(holder.pid as number, 'SIGKILL') } catch { /* gone */ }
    }
  }, 45_000)
})

describe('cleanup refuses anything it cannot prove is ours', () => {
  /**
   * THE NON-VACUITY OF EVERY OTHER CASE IN THIS FILE.
   *
   * A remover that removed whatever it was handed would satisfy every "it was
   * removed" assertion above. Each refusal here is one of the four checks failing
   * on its own, with everything else about the path correct.
   */
  it('refuses a name outside the reviewed form', () => {
    const foreign = join(realTmp(), 'pgcopy-modes-not-a-reviewed-name')
    mkdirSync(foreign, { recursive: true })
    MADE.push(foreign)
    expect(() => removeProvedRoot(foreign)).toThrow(NotOurRoot)
    expect(existsSync(foreign), 'and left it alone').toBe(true)
  })

  it('refuses a symlink standing where a root would be', () => {
    const real = mkdtempSync(join(realTmp(), ROOT_PREFIX_FOR(mintNonce(), 4244)))
    MADE.push(real)
    writeFileSync(join(real, 'precious'), 'do not delete me\n')
    const link = join(realTmp(), `${ROOT_PREFIX_FOR(mintNonce(), 4245)}AAAAAA`)
    symlinkSync(real, link)
    MADE.push(link)
    // AND REFUSES IT *AS A SYMLINK*.
    //
    // WHY THE REASON IS ASSERTED AND NOT JUST THE REFUSAL. An `lstat` of a link
    // is not a directory either, so a refusal alone is also what the generic
    // "not a directory" check produces - deleting the dedicated symlink branch
    // changed nothing observable and the mutant survived. Naming the reason is
    // what makes the branch load-bearing, and the reason is worth having: a
    // symlink standing where a root belongs is somebody pointing this remover at
    // something else, which is a different event from a stray file.
    expect(() => removeProvedRoot(link)).toThrow(/a symlink is never a root/)
    expect(readFileSync(join(real, 'precious'), 'utf-8'), 'the target is untouched')
      .toBe('do not delete me\n')
  })

  it('refuses a path that is not directly beneath the real temporary directory', () => {
    const outer = mkdtempSync(join(realTmp(), ROOT_PREFIX_FOR(mintNonce(), 4246)))
    MADE.push(outer)
    const nested = join(outer, `${ROOT_PREFIX_FOR(mintNonce(), 4247)}BBBBBB`)
    mkdirSync(nested)
    expect(() => removeProvedRoot(nested)).toThrow(NotOurRoot)
    expect(existsSync(nested), 'and left it alone').toBe(true)
  })

  it('refuses a file wearing a root name', () => {
    const file = join(realTmp(), `${ROOT_PREFIX_FOR(mintNonce(), 4248)}CCCCCC`)
    writeFileSync(file, 'not a directory\n')
    MADE.push(file)
    expect(() => provenRoot(file)).toThrow(NotOurRoot)
    expect(existsSync(file), 'and left it alone').toBe(true)
  })

  /** The parse is what every check is built on, so it is asserted directly. */
  it('reads a reviewed name and rejects the near misses', () => {
    const n = mintNonce()
    expect(parseRootName(`pgcopy-modes-${n}-500-abc123`)?.pid).toBe(500)
    expect(parseRootName(`pgcopy-modes-${n}-500-c3-abc123`)?.child).toBe(3)
    expect(parseRootName(`pgcopy-modes-${n}-500-c3-ctlabc123`)?.child).toBe(3)
    expect(parseRootName(`pgcopy-modes-${n}-500-abc123-extra`), 'a suffix').toBeNull()
    expect(parseRootName(`prefix-pgcopy-modes-${n}-500-abc123`), 'a prefix').toBeNull()
    expect(parseRootName('pgcopy-modes-NOTHEX0000000000-500-abc123'), 'a bad nonce').toBeNull()
    expect(parseRootName('pgcopy-modes-nonce-500-abc123'), 'a short nonce').toBeNull()
  })
})

describe('a foreign sentinel in the same directory is never touched', () => {
  /**
   * WHAT "NO GLOB" MEANS, MEASURED.
   *
   * `rm -rf /tmp/pgcopy-modes-*` would satisfy every removal assertion in this
   * file and destroy this directory. So a sentinel that matches that glob and not
   * the reviewed form sits through a whole invocation - reaping at the start,
   * cleanup at the end - and its bytes are compared afterwards.
   */
  it('survives a full invocation byte for byte', async () => {
    const dir = box()
    const sentinel = join(dir, 'pgcopy-modes-foreign-sentinel')
    mkdirSync(sentinel, { recursive: true })
    const marker = join(sentinel, 'keep.json')
    const bytes = '{"owner":"somebody else","keep":true}\n'
    writeFileSync(marker, bytes, { mode: 0o600 })

    const r = runner('pass', dir)
    expect((await r.ended).code).toBe(0)

    expect(existsSync(sentinel), 'the sentinel is still there').toBe(true)
    expect(readFileSync(marker, 'utf-8'), 'byte for byte').toBe(bytes)
    // AND IT WAS NEVER EVEN CONSIDERED A ROOT.
    expect(rootsIn(dir)).not.toContain('pgcopy-modes-foreign-sentinel')
  }, 45_000)
})

describe('residue does not depend on the verdict', () => {
  /**
   * A PASSING RUN AND A FAILING RUN LEAVE THE SAME THING BEHIND: nothing.
   *
   * This is the one that stops the guard from being written as "clean up if the
   * tests passed". A failure is exactly when the roots are most interesting to
   * keep and most likely to be forgotten, and the old harness forgot them.
   */
  for (const [mode, code] of [['pass', 0], ['fail', 1]] as const) {
    it(`leaves zero owned roots after an ordinary ${mode}`, async () => {
      const r = runner(mode)
      const root = await rootOf(r)
      const end = await r.ended
      expect(end.code, 'the command\'s own verdict is passed through').toBe(code)
      expect(existsSync(root), 'its root was removed either way').toBe(false)
      expect(rootsIn(r.dir), 'and nothing else was left').toEqual([])
    }, 45_000)
  }
})
