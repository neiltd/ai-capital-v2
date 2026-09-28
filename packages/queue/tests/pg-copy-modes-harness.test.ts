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
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LSOF_ENV, NONCE_ENV, NotOurRoot, ROOT_PREFIX_FOR, leasePresence, mintNonce,
  nothingReferences, parseRootName, probePath, provenLease, provenRoot, realTmp,
  removeProvedRoot,
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
function runner(mode: string, dir: string = box(), over: Record<string, string> = {}): {
  pid: number; dir: string; stdout: () => string; stderr: () => string
  ended: Promise<{ code: number | null; signal: string | null }>
} {
  // ITS OWN NONCE, NOT THIS ONE'S. Inheriting the nonce is what made a nested
  // runner believe a sibling worker's directories were its own.
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, ...over }
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

/**
 * START A BARE STUB AS ITS OWN INVOCATION, with no runner above it.
 *
 * For the cases that need a LIVE OWNER rather than a runner: the process opens its own
 * nonce's lease because it imports the harness's roots module, creates a root, and then
 * either sits there or runs away, depending on the mode. Nothing reaps on its behalf
 * and nothing cleans up for it, which is exactly the situation a concurrent runner has
 * to cope with.
 */
function owner(mode: string, dir: string, over: Record<string, string> = {}): {
  pid: number; ended: Promise<void>; stdout: () => string
} {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, ...over }
  delete env[NONCE_ENV]
  const child = spawn(process.execPath, asNode(STUB, [mode]),
    { cwd: QUEUE_PKG, stdio: ['ignore', 'pipe', 'pipe'], env })
  let out = ''
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8') })
  STRAYS.push(child.pid as number)
  return {
    pid: child.pid as number,
    stdout: () => out,
    ended: new Promise<void>(resolve => { child.on('exit', () => { resolve() }) }),
  }
}

/** Wait for a bare stub to report itself. */
async function ownerRoot(o: { stdout: () => string }, within = 20_000): Promise<string> {
  const until = Date.now() + within
  for (;;) {
    const line = o.stdout().split('\n')[0]
    if (line !== undefined && line.length > 0) {
      const root = line.split(' ')[1] as string
      MADE.push(root)
      return root
    }
    if (Date.now() > until) throw new Error('the owner never reported a root')
    await sleep(25)
  }
}

/** The nonce a root belongs to, read out of its own name. */
const nonceOf = (root: string): string => {
  const parsed = parseRootName(basename(root))
  if (parsed === null) throw new Error(`not a reviewed root: ${root}`)
  return parsed.nonce
}

/** Does this process name that path anywhere in its command line? */
const argvNames = (pid: number, path: string): boolean =>
  execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)],
    { encoding: 'utf-8' }).includes(path)

/** Does anything hold an open descriptor on that exact path? */
const heldOpen = (path: string): boolean => {
  try {
    const r = execFileSync('/usr/sbin/lsof', ['-w', '-t', '--', path],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return r.trim().length > 0
  } catch { return false }
}

// ---------------------------------------------------------------------------

describe('a live invocation is never reaped, however little it can be seen', () => {
  /**
   * THE DEFECT THIS ORDER EXISTS FOR, REPRODUCED AND THEN REFUSED.
   *
   * The first reaper asked two questions about each root - does any command line name
   * this exact path, and does any descriptor point at this exact directory - and read
   * two noes as proof the root was abandoned. A live Vitest worker answers no to both:
   * it holds its root path in JavaScript memory, its argv is `vitest --run …`, and it
   * opens files INSIDE the root only for as long as each write takes. So a second
   * runner deleted a live owner's root, said `reaped 1 stale root(s)`, and exited 0.
   *
   * MEASURED HERE, NOT ASSUMED: both noes are asserted before the second invocation
   * starts. Without them this case would pass for the wrong reason - because the owner
   * happened to be visible - and the mutant that reverts to the old proof would
   * survive. It does not.
   */
  it('spares a root whose owner names it nowhere and holds no descriptor on it', async () => {
    const dir = box()
    const a = owner('idle', dir)
    const root = await ownerRoot(a)
    const marker = join(root, 'evidence', 'marker.json')
    const bytes = readFileSync(marker, 'utf-8')

    // THE TWO THINGS THE OLD PROOF LOOKED AT, BOTH ABSENT.
    expect(argvNames(a.pid, root), "the owner's command line does not name its root")
      .toBe(false)
    expect(heldOpen(root), 'nothing holds a descriptor on the root itself').toBe(false)
    // AND THE ONE THING THAT DOES PROVE IT IS ALIVE.
    expect(heldOpen(join(dir, `pgcopy-modes-lease-${nonceOf(root)}`)),
      "the owner's lease is held open").toBe(true)

    const b = runner('pass', dir)
    expect((await b.ended).code, 'the second invocation ran normally').toBe(0)

    expect(b.stderr(), 'and spared it BECAUSE the lease is live')
      .toContain('the lease for this nonce is held open')
    expect(existsSync(root), "the live owner's root survives").toBe(true)
    expect(readFileSync(marker, 'utf-8'), 'byte for byte').toBe(bytes)
    expect(/^\s*[0-9]+\s*$/.test(
      execFileSync('/bin/ps', ['-o', 'pid=', '-p', String(a.pid)], { encoding: 'utf-8' })),
      'and the owner is still alive').toBe(true)
  }, 60_000)

  /** And once it is really gone, the root is not protected for ever. */
  it('reaps that same root once the owner has exited and its lease is closed', async () => {
    const dir = box()
    const a = owner('idle', dir)
    const root = await ownerRoot(a)
    const lease = join(dir, `pgcopy-modes-lease-${nonceOf(root)}`)

    process.kill(a.pid, 'SIGKILL')
    await a.ended
    // THE KERNEL CLOSED IT; NOTHING HAD TO REMEMBER TO.
    expect(heldOpen(lease), 'the lease is no longer held').toBe(false)

    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(b.stderr(), 'and said so').toContain('reaped 1 stale root')
    expect(existsSync(root), 'the abandoned root is gone').toBe(false)
    expect(existsSync(lease), "and so is the dead invocation's lease").toBe(false)
  }, 60_000)

  /**
   * AND A LEASE FILE ON ITS OWN DOES NOT BECOME A TOMBSTONE.
   *
   * A lease that exists and is held by nobody is a dead invocation's last trace. If
   * its mere existence counted as liveness, one interrupted run would make its roots
   * permanently unreapable - the failure mode would have moved rather than gone.
   */
  it('recovers from an abandoned lease that no process holds', async () => {
    const dir = box()
    const dead = mintNonce()
    const lease = join(dir, `pgcopy-modes-lease-${dead}`)
    writeFileSync(lease, '', { mode: 0o600 })
    const stale = mkdtempSync(join(dir, ROOT_PREFIX_FOR(dead, 5150)))
    mkdirSync(join(stale, 'evidence'), { mode: 0o700 })

    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(existsSync(stale), 'the root was reaped').toBe(false)
    expect(existsSync(lease), 'and its lease with it').toBe(false)
  }, 45_000)

  /**
   * AND THE LEASE IS THE LAST THING TO GO, NOT THE FIRST.
   *
   * WHY THE ORDER IS A PROPERTY AND NOT A DETAIL. The lease is the only record of which
   * invocation a group of roots belongs to. Remove it before the roots and a reap that
   * is interrupted - or that has to spare one root because something is still using it -
   * leaves roots behind with nothing left to reason about them: the next reaper sees no
   * lease, calls them abandoned, and the protection has evaporated exactly when it was
   * needed. So a dead invocation with one root that cannot be taken keeps its lease.
   */
  it('keeps a dead invocation\'s lease while any of its roots is spared', async () => {
    const dir = box()
    const dead = mintNonce()
    const lease = join(dir, `pgcopy-modes-lease-${dead}`)
    writeFileSync(lease, '', { mode: 0o600 })
    const spared = mkdtempSync(join(dir, ROOT_PREFIX_FOR(dead, 5152)))
    mkdirSync(join(spared, 'evidence'), { mode: 0o700 })
    const alsoStale = mkdtempSync(join(dir, ROOT_PREFIX_FOR(dead, 5153)))
    mkdirSync(join(alsoStale, 'evidence'), { mode: 0o700 })
    // ONE OF THE TWO IS STILL REFERENCED, so the per-root check spares it while the
    // other is taken. The `; :` keeps the path in the holder's argv - `sh -c 'cmd'`
    // execs and loses it.
    const holder = spawn('/bin/sh', ['-c', 'sleep 30; :', spared],
      { stdio: 'ignore', detached: true })
    try {
      await sleep(400)
      const b = runner('pass', dir)
      expect((await b.ended).code).toBe(0)
      expect(existsSync(alsoStale), 'the unreferenced root was taken').toBe(false)
      expect(existsSync(spared), 'the referenced one was spared').toBe(true)
      expect(existsSync(lease), 'and the lease stayed with it').toBe(true)
    } finally {
      try { process.kill(-(holder.pid as number), 'SIGKILL') } catch { /* gone */ }
      try { process.kill(holder.pid as number, 'SIGKILL') } catch { /* gone */ }
    }
  }, 45_000)

  /**
   * AND THE ORDER HOLDS WHILE A REAPER IS ACTUALLY LOOKING.
   *
   * The case above proves the reaper keeps a lease whose roots it could not take. This
   * one proves the other half: that a runner cleaning up its OWN roots still holds its
   * lease while it does so. The window is microseconds in a real run, so two runners
   * racing normally never land in it and a reversed order survives every test - measured.
   * The runner therefore widens that window on request, and a reaper is sent in while it
   * is open. Nothing is skipped or reordered by the pause; it only waits.
   */
  it('removes its own roots before it drops its lease', async () => {
    const dir = box()
    const a = runner('pass', dir, { PGCOPY_MODES_TEST_CLEANUP_PAUSE_MS: '6000' })
    const root = await rootOf(a)

    const until = Date.now() + 20_000
    while (!a.stderr().includes('pausing before root cleanup')) {
      if (Date.now() > until) throw new Error('the runner never reached its cleanup')
      await sleep(25)
    }

    // INSIDE THE WINDOW, WHERE THE TWO ORDERS DIFFER. Correct code has already taken
    // its own root and is holding its lease until it is finished; the reverse has let
    // its lease go with the root still there for anybody to take.
    expect(existsSync(root), 'A took its own root first').toBe(false)
    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    // WHICH MEANS THERE WAS NOTHING FOR A REAPER TO FIND. A run where B reports a reap
    // is a run where A's root was sitting unowned, which is the state the order exists
    // to make impossible.
    expect(b.stderr(), 'and B found nothing of A to reap').not.toContain('reaped')

    expect((await a.ended).code, 'A then finished normally').toBe(0)
  }, 60_000)

  /** A lease whose roots are already gone is swept too, rather than accumulating. */
  it('sweeps a lease file with nothing behind it', async () => {
    const dir = box()
    const lease = join(dir, `pgcopy-modes-lease-${mintNonce()}`)
    writeFileSync(lease, '', { mode: 0o600 })
    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(existsSync(lease), 'the orphaned lease is gone').toBe(false)
  }, 45_000)
})

describe('a lease is believed only when it can be proved', () => {
  /**
   * AN UNPROVABLE LEASE IS NOT AN ABSENT ONE.
   *
   * These are the refusals, and each one matters in the same direction: a lease this
   * harness cannot vouch for must never be read as permission to delete. So the
   * outcome of a bad lease is that the roots behind it are SPARED and the reason is
   * reported - losing cleanup, never data. A remover that treated an unreadable
   * answer as a no would delete exactly what it could not see.
   */
  it('refuses a symlinked lease and spares what it stands for', async () => {
    const dir = box()
    const dead = mintNonce()
    const elsewhere = join(dir, 'not-a-lease')
    writeFileSync(elsewhere, '', { mode: 0o600 })
    symlinkSync(elsewhere, join(dir, `pgcopy-modes-lease-${dead}`))
    const stale = mkdtempSync(join(dir, ROOT_PREFIX_FOR(dead, 5151)))
    mkdirSync(join(stale, 'evidence'), { mode: 0o700 })

    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(b.stderr(), 'the reason is named').toContain('a symlink is never a lease')
    expect(existsSync(stale), 'and the root is spared, not removed').toBe(true)
  }, 45_000)

  it('refuses a lease that is a directory rather than a file', () => {
    const d = join(realTmp(), `pgcopy-modes-lease-${mintNonce()}`)
    mkdirSync(d)
    MADE.push(d)
    expect(() => provenLease(d)).toThrow(/not a regular file/)
  })

  it('refuses a malformed lease name', () => {
    expect(() => provenLease(join(realTmp(), 'pgcopy-modes-lease-NOTHEX')))
      .toThrow(/not a reviewed lease name/)
    expect(() => provenLease(join(realTmp(), 'pgcopy-modes-lease-0123456789abcde')))
      .toThrow(/not a reviewed lease name/)
  })

  it('refuses a lease outside the real temporary directory', () => {
    const outer = mkdtempSync(join(realTmp(), 'k536-box-'))
    MADE.push(outer)
    const nested = join(outer, `pgcopy-modes-lease-${mintNonce()}`)
    writeFileSync(nested, '', { mode: 0o600 })
    expect(() => provenLease(nested))
      .toThrow(/not directly beneath the real temporary directory/)
  })

  /**
   * THE OWNERSHIP COMPARISON, REACHED.
   *
   * A second user account is the only way to produce a genuinely wrong-owner file, and
   * a test suite may not create one. So the expected uid is a parameter with a
   * production default of this user: passing any other value exercises exactly the
   * comparison a wrong-owner file would fail, and the production call sites are
   * unchanged. Without this the check would be untestable and a mutant deleting it
   * would survive.
   */
  it('refuses a lease that is not owned by the expected user', () => {
    const f = join(realTmp(), `pgcopy-modes-lease-${mintNonce()}`)
    writeFileSync(f, '', { mode: 0o600 })
    MADE.push(f)
    expect(provenLease(f).nonce, 'ours, as this user').toBe(basename(f).slice(-16))
    const notUs = (process.getuid?.() ?? 0) + 1
    expect(() => provenLease(f, notUs)).toThrow(/not this user/)
  })
})

describe('a probe that cannot be completed is never read as permission', () => {
  /**
   * THE REMAINING FAIL-OPEN DEFECT, CLOSED.
   *
   * `lsof` exits 1 when nothing matches, so both callers used to wrap it in a `try` and
   * read the exception as "nothing holds this". An exception is not an answer. `lsof`
   * also fails when it cannot be started, when it is killed by a signal, when it runs
   * out of descriptors, and when it warns that part of the system was unreadable - and
   * every one of those reached the same `catch` and became permission to delete. The
   * same was true of `lstat`: any error at all, not just ENOENT, was read as "there is
   * no lease", which is exactly the sentence that unprotects a live invocation.
   *
   * These cases drive each failure for real, through an executable standing in for
   * `lsof`, and assert the fail-CLOSED outcome: the roots stay.
   */

  /** A stand-in for lsof, written for one exact failure. */
  const fakeLsof = (dir: string, body: string): string => {
    const bin = join(dir, 'fake-lsof')
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
    return bin
  }

  /** A dead invocation's lease and one root, ready to be reaped - or not. */
  const staleWithLease = (dir: string): { root: string; lease: string } => {
    const dead = mintNonce()
    const lease = join(dir, `pgcopy-modes-lease-${dead}`)
    writeFileSync(lease, '', { mode: 0o600 })
    const root = mkdtempSync(join(dir, ROOT_PREFIX_FOR(dead, 6100)))
    mkdirSync(join(root, 'evidence'), { mode: 0o700 })
    return { root, lease }
  }

  it('the ordinary no-match answer still permits cleanup', () => {
    const f = join(realTmp(), `k5362-plain-${mintNonce()}`)
    writeFileSync(f, '', { mode: 0o600 })
    MADE.push(f)
    const p = probePath(f)
    expect(p.state, 'nothing holds a file nobody opened').toBe('free')
    expect(nothingReferences(f), 'so cleanup is permitted').toBe(true)
  })

  it('a live descriptor is reported as held, with a count', async () => {
    const dir = box()
    const a = owner('idle', dir)
    const root = await ownerRoot(a)
    const p = probePath(join(dir, `pgcopy-modes-lease-${nonceOf(root)}`))
    expect(p.state).toBe('held')
    expect(p.holders, 'and says how many').toBeGreaterThanOrEqual(1)
  }, 45_000)

  /**
   * EVERY OTHER `lstat` ERRNO IS A REFUSAL.
   *
   * EACCES is produced for real, by making the directory holding the lease unsearchable;
   * ENOTDIR by putting a file where a directory would have to be. EIO cannot be produced
   * without a failing device and a test must not try, but it takes this same branch: the
   * code asks only whether the errno IS ENOENT, and these two prove that the answer for
   * anything else is `unprovable` rather than `absent`.
   */
  it('an unsearchable directory makes the lease unprovable, not absent', () => {
    const dir = box()
    const shut = join(dir, 'shut')
    mkdirSync(shut)
    const lease = join(shut, `pgcopy-modes-lease-${mintNonce()}`)
    writeFileSync(lease, '', { mode: 0o600 })
    chmodSync(shut, 0o000)
    try {
      const r = leasePresence(lease)
      expect(r.state, 'EACCES is not an absence').toBe('unprovable')
      expect(r.why).toContain('EACCES')
    } finally {
      chmodSync(shut, 0o700)
    }
  })

  it('a path component that is not a directory is unprovable, not absent', () => {
    const dir = box()
    const file = join(dir, 'a-file')
    writeFileSync(file, '', { mode: 0o600 })
    const r = leasePresence(join(file, `pgcopy-modes-lease-${mintNonce()}`))
    expect(r.state).toBe('unprovable')
    expect(r.why).toContain('ENOTDIR')
  })

  it('a missing lease really is absent', () => {
    const dir = box()
    const r = leasePresence(join(dir, `pgcopy-modes-lease-${mintNonce()}`))
    expect(r.state).toBe('absent')
  })

  /** And each way the probe itself can fail, driven for real. */
  for (const [what, body, expected] of [
    ['an abnormal exit status', 'exit 2', 'lsof exited 2'],
    ['a warning on stderr beside a status we understand',
      'echo "lsof: WARNING: cannot read /dev" >&2; exit 1', 'lsof exited 1'],
    ['a warning on stderr beside success', 'echo 4242; echo "lsof: WARNING" >&2; exit 0',
      'lsof reported a problem'],
    ['termination by a signal', 'kill -TERM $$', 'was killed by SIGTERM'],
    ['success that names nobody', 'exit 0', 'named no process'],
  ] as const) {
    it(`treats ${what} as unprovable`, () => {
      const dir = box()
      const bin = fakeLsof(dir, body)
      const before = process.env[LSOF_ENV]
      process.env[LSOF_ENV] = bin
      try {
        const p = probePath(join(dir, 'anything'))
        expect(p.state, what).toBe('unprovable')
        expect(p.why).toContain(expected)
        // AND THE CALLER THAT ASKS "MAY I DELETE THIS" IS TOLD NO.
        expect(nothingReferences(join(dir, 'anything')),
          'nothingReferences refuses under the same failure').toBe(false)
      } finally {
        if (before === undefined) delete process.env[LSOF_ENV]
        else process.env[LSOF_ENV] = before
      }
    })
  }

  it('treats a probe that cannot be started at all as unprovable', () => {
    const dir = box()
    const before = process.env[LSOF_ENV]
    process.env[LSOF_ENV] = join(dir, 'no-such-binary')
    try {
      const p = probePath(join(dir, 'anything'))
      expect(p.state).toBe('unprovable')
      expect(p.why).toContain('could not be run')
      expect(nothingReferences(join(dir, 'anything'))).toBe(false)
    } finally {
      if (before === undefined) delete process.env[LSOF_ENV]
      else process.env[LSOF_ENV] = before
    }
  })

  it('refuses an lsof override that is not an absolute path', () => {
    const before = process.env[LSOF_ENV]
    process.env[LSOF_ENV] = 'lsof'
    try {
      expect(() => probePath('/tmp')).toThrow(/not an absolute path/)
    } finally {
      if (before === undefined) delete process.env[LSOF_ENV]
      else process.env[LSOF_ENV] = before
    }
  })

  /**
   * AND NOTHING INJECTED HERE ESCAPES THE RUNNER.
   *
   * The unit-level cases above prove the decision; this one proves it is the decision the
   * runner acts on. A whole invocation is given a broken probe and pointed at a stale
   * root with a dead lease - the very thing it exists to clean up - and it must come back
   * having removed nothing, and having said why.
   */
  for (const [what, body] of [
    ['an abnormal status', 'exit 2'],
    ['a stderr warning', 'echo "lsof: WARNING" >&2; exit 1'],
    ['a signal', 'kill -TERM $$'],
  ] as const) {
    it(`the runner reaps nothing when its probe fails with ${what}`, async () => {
      const dir = box()
      const bin = fakeLsof(dir, body)
      const { root, lease } = staleWithLease(dir)

      const b = runner('pass', dir, { [LSOF_ENV]: bin })
      expect((await b.ended).code, 'the run itself still succeeds').toBe(0)
      expect(b.stderr(), 'and it said it could not tell').toMatch(/spared .*(lsof|killed)/)
      expect(existsSync(root), 'the stale root was NOT removed').toBe(true)
      expect(existsSync(lease), 'nor its lease').toBe(true)
    }, 45_000)
  }

  /** The same invocation with a working probe does clean it up - so the above is not vacuous. */
  it('and reaps it once the probe works again', async () => {
    const dir = box()
    const { root, lease } = staleWithLease(dir)
    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(existsSync(root), 'removed with a working probe').toBe(false)
    expect(existsSync(lease), 'lease removed too').toBe(false)
  }, 45_000)
})

describe('two concurrent invocations leave each other alone', () => {
  /**
   * THE SYMMETRIC CASE, WHICH ONE-SIDED PROTECTION WOULD PASS.
   *
   * Both invocations are runners, both reap at startup, and both remove owned roots at
   * exit. So the property is not "B spares A" but that neither can take the other's -
   * asserted while both are demonstrably alive, and again after each has finished with
   * its own.
   */
  it('neither reaps the other, and each removes only its own', async () => {
    const dir = box()
    // BOTH ALIVE, AND BOTH QUIET. Two measured mistakes are baked into this choice.
    //
    // A `hold` stub on the default ceilings reaches eighty bundles in about half a
    // second and ends itself - shorter than the time the second runner takes to start
    // under load - so A had already finished its cleanup before B's root existed and
    // "A did not take B's root" was true because there was nothing to take. The mutant
    // that removes every root it finds survived, intermittently, only under a full
    // matrix's load.
    //
    // Raising the ceilings to keep it alive made that worse, not better: a stub
    // publishing two hundred bundles a second means a recursive removal of its root
    // races the writes, fails with ENOTEMPTY, and is swallowed - so the mutant's damage
    // was masked and it then survived every single time. `idle` is what a live
    // invocation actually looks like to a reaper: present, owning a root, and not
    // touching it.
    const a = runner('idle', dir)
    const aRoot = await rootOf(a)
    const b = runner('idle', dir)
    const bRoot = await rootOf(b)

    expect(aRoot).not.toBe(bRoot)
    expect(existsSync(aRoot) && existsSync(bRoot), 'both are there').toBe(true)
    expect(nonceOf(aRoot)).not.toBe(nonceOf(bRoot))
    // AND BOTH ARE REALLY STILL RUNNING at the moment the first one is signalled.
    for (const [who, root] of [['A', aRoot], ['B', bRoot]] as const) {
      expect(heldOpen(join(dir, `pgcopy-modes-lease-${nonceOf(root)}`)),
        `${who} is still live`).toBe(true)
    }

    process.kill(-a.pid, 'SIGTERM')
    await a.ended
    expect(existsSync(aRoot), "A removed A's root").toBe(false)
    expect(existsSync(bRoot), "and left B's alone").toBe(true)

    process.kill(-b.pid, 'SIGTERM')
    await b.ended
    expect(existsSync(bRoot), "B removed B's root").toBe(false)
  }, 60_000)

  /** And the boxes really are boxes: a runner cannot see another's directory at all. */
  it('runners in separate temporary directories see nothing of each other', async () => {
    const one = box()
    const two = box()
    // `idle` FOR THE SAME REASON AS THE CASE ABOVE: A has to still be running while B
    // does its reap, and has to be quiet enough that a removal of its root would
    // actually succeed if one were attempted.
    const a = runner('idle', one)
    const aRoot = await rootOf(a)
    expect(heldOpen(join(one, `pgcopy-modes-lease-${nonceOf(aRoot)}`)),
      'A is still live').toBe(true)
    const b = runner('pass', two)
    expect((await b.ended).code).toBe(0)
    expect(existsSync(aRoot), "B's reap never reached A's directory").toBe(true)
    expect(rootsIn(two), "and B left nothing in its own").toEqual([])
    process.kill(-a.pid, 'SIGTERM')
    await a.ended
  }, 60_000)
})

describe('a killed runner leaves bounded residue that a later one removes', () => {
  /**
   * THE WHOLE CHAIN, END TO END.
   *
   * SIGKILL to the runner alone: no handler runs, nothing removes its roots. The child
   * notices it is orphaned and ends itself, which closes the last descriptor on that
   * invocation's lease - and only then may a later invocation take the root. So this
   * one case exercises the child's self-limit, the lease going quiet, and the reaper
   * acting on it, in that order.
   */
  it('the residue is bounded, and the next invocation reaps it', async () => {
    const dir = box()
    const a = runner('hold', dir)
    const root = await rootOf(a)
    const lease = join(dir, `pgcopy-modes-lease-${nonceOf(root)}`)
    const until = Date.now() + 10_000
    while (bundles(root) < 3 && Date.now() < until) await sleep(25)

    process.kill(a.pid, 'SIGKILL')
    await a.ended

    // BOUNDED: the child stops on its own, so the bundle count settles.
    const settle = Date.now() + 15_000
    let last = -1
    for (;;) {
      await sleep(500)
      const now = bundles(root)
      if (now === last || Date.now() > settle) break
      last = now
    }
    expect(existsSync(root), 'the root did survive the kill').toBe(true)
    const settled = bundles(root)
    await sleep(1_000)
    expect(bundles(root), 'and stopped growing').toBe(settled)
    expect(heldOpen(lease), 'and the lease went quiet by itself').toBe(false)

    const b = runner('pass', dir)
    expect((await b.ended).code).toBe(0)
    expect(existsSync(root), 'the later invocation reaped it').toBe(false)
    expect(rootsIn(dir), 'and left nothing at all').toEqual([])
  }, 90_000)
})

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
    const env: NodeJS.ProcessEnv = {
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
    const env: NodeJS.ProcessEnv = {
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
