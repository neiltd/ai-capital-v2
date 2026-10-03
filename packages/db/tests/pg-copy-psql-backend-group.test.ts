// THE psql TRANSPORT'S PROCESS GROUP — offline, with fake psql scripts.
//
// WHAT THIS FILE EXISTS TO PROVE. A fence is a lock held by a PostgreSQL
// backend, and that backend lives exactly as long as its psql client. The ops
// CLI installs handlers for every catchable signal so that a stray Ctrl-C cannot
// end a held fence — but those handlers protect NODE. The signals a terminal
// generates go to the whole foreground process group, so while the psql child
// sat in node's group, Ctrl-C reached psql directly, psql ended its script, the
// backend died, and the fence was released by a keystroke no matter what node's
// handlers decided. `openPsqlBackend` therefore spawns `detached`, which makes
// each psql a session and process-group leader.
//
// The property is structural, so it is checked structurally: where the child's
// process group ID actually is, and what a signal to the PARENT's group does and
// does not reach.
//
// NOTHING REAL IS TOUCHED. Every psql here is a /bin/sh script in a private
// `mkdtemp` root, modelled on the fake in pg-copy-manifest-cli.test.ts. No
// cluster, no socket, no credential, no evidence root.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllPsqlBackends, openPsqlBackend } from '../src/pg-copy/psql-backend.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER = join(PKG_ROOT, 'tests', 'support', 'backend-group-child.ts')

/** Generous enough that a graceful exit is never mistaken for an escalation. */
const CLOSE_GRACE_MS = 4_000
/** Every wait in this file is bounded by one of these. */
const LINE_DEADLINE_MS = 15_000
const SETTLE_MS = 500
const EXIT_DEADLINE_MS = 10_000

/** The roots and pids this file created, and may therefore remove and signal. */
const roots: string[] = []
const spawned: number[] = []
/** Pids a case has PROVED gone, so teardown must not signal them again. */
const reaped = new Set<number>()

/**
 * A fake psql that reports ITS OWN pid as the backend pid.
 *
 * The transport learns the backend pid by asking the server for it, so a fake
 * that answers with `$$` makes `session.pid` the OS pid of this script — which
 * is what a process-group question has to be asked about. `spawn` execs the
 * script directly, so `$$` is the child pid node knows.
 *
 * It ends at stdin EOF, and writes `eof` to a marker on the way out. The marker
 * is how a graceful close is told apart from a SIGKILL: a killed shell writes
 * nothing.
 */
function fakePsql(): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-groupfake-'))
  roots.push(dir)
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
  return { bin, marker }
}

/**
 * The process group a pid belongs to, ASSERTED to exist.
 *
 * K8-E5 hygiene: a comparison between two `pgidOf` results is vacuous the moment
 * either is null - "the child is not in my group" is trivially true of a child
 * that has died. Every comparison in this file therefore goes through here, and a
 * missing pid fails the case by name instead of passing it by accident.
 */
function pgidOrFail(pid: number, label: string): number {
  const pgid = pgidOf(pid)
  expect(pgid, `${label} (pid ${String(pid)}) has no process group: it is gone`).not.toBeNull()
  return pgid as number
}

/** The process group a pid belongs to, or null once the pid is gone. */
function pgidOf(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8' })
    const n = Number(out.trim())
    return Number.isSafeInteger(n) ? n : null
  } catch { return null }
}

/** Signal 0 asks the question without sending anything. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const wait = async (ms: number): Promise<void> =>
  await new Promise<void>(r => { setTimeout(r, ms) })

/** Poll until `done`, and NEVER longer than `ms`. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (done()) return true
    await wait(25)
  }
  return done()
}

/**
 * An environment with nothing a database could be reached with.
 *
 * An allow-list rather than a filter: a deny-list has to anticipate every name a
 * credential might arrive under, and this fixture needs exactly three variables.
 */
function sterileChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

afterEach(async () => {
  await closeAllPsqlBackends()
  // ONLY THE PIDS THIS FILE SPAWNED AND RECORDED. Nothing else is signalled, and
  // the signal goes to the pid, never to a group.
  //
  // K8-E5 hygiene: AND ONLY ONES THAT MIGHT STILL BE ALIVE. A case that already
  // proved a pid gone has reaped it; signalling it again is either a no-op or,
  // after the OS reuses the number, a signal to somebody else's process. So
  // liveness is checked first and a pid a case retired is never signalled at all.
  for (const pid of spawned.splice(0)) {
    if (reaped.has(pid)) continue
    if (!alive(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch { /* raced us to it */ }
  }
  reaped.clear()
  const mine = roots.splice(0)
  for (const r of mine) rmSync(r, { recursive: true, force: true })
  // AND PROVE IT. A surviving fake would keep its root's path in its command
  // line, so the process table is the residue check.
  const table = execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf-8' })
  for (const r of mine) expect(table, `a process still names ${r}`).not.toContain(r)
})

describe('K8-E4 D1: a psql session is not in the caller\'s process group', () => {
  it('leads its own group, and still closes gracefully at EOF', async () => {
    const { bin, marker } = fakePsql()
    const session = await openPsqlBackend({
      psqlPath: bin, host: '/tmp/no-such-socket', port: 5432,
      database: 'fixture', user: 'fixture',
      __closeGraceMs: CLOSE_GRACE_MS,
    })
    const pid = Number(session.pid)
    expect(Number.isSafeInteger(pid)).toBe(true)
    spawned.push(pid)

    // IT LEADS ITS OWN GROUP: pgid === pid is what `detached` buys.
    expect(pgidOrFail(pid, 'the psql child')).toBe(pid)
    // AND IT IS NOT OURS. This is the assertion the whole change is for.
    expect(pgidOrFail(pid, 'the psql child'))
      .not.toBe(pgidOrFail(process.pid, 'this test process'))

    // DETACHING MUST NOT COST THE REAP. `close` ends stdin, the script reads EOF
    // and exits, and no SIGKILL is needed — so this returns far inside the grace
    // and the marker the shell writes on its way out is there.
    const started = Date.now()
    await session.close()
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(CLOSE_GRACE_MS / 2)
    expect(alive(pid)).toBe(false)
    reaped.add(pid)
    expect(existsSync(marker), 'the fake exited at EOF rather than being killed').toBe(true)
  }, 30_000)
})

describe('K8-E4 D2: terminal signals to the caller\'s group do not reach psql', () => {
  it('survives a group SIGINT, SIGHUP and SIGQUIT, and still dies with its parent',
     async () => {
    const { bin } = fakePsql()

    // THE FIXTURE PARENT, spawned `detached` so that it leads a group of its own
    // and this test can signal that group the way a TTY driver signals the
    // foreground job. Signalling our OWN group would signal the Vitest worker.
    const child = spawn(process.execPath, ['--import', 'tsx', HELPER, bin, '/tmp/no-such-socket'], {
      cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: sterileChildEnv(), detached: true,
    })
    const helperPid = child.pid as number
    expect(Number.isSafeInteger(helperPid)).toBe(true)
    spawned.push(helperPid)

    let out = ''
    let errText = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { errText += String(d) })

    const got = await until(() => /GROUP \d+ \d+/.test(out), LINE_DEADLINE_MS)
    expect(got, `the fixture never reported its pids; stderr: ${errText}`).toBe(true)
    const m = /GROUP (\d+) (\d+)/.exec(out) as RegExpExecArray
    const fakePid = Number(m[1])
    expect(Number(m[2])).toBe(helperPid)
    spawned.push(fakePid)

    // THE STRUCTURAL FACT, from the fixture's side of the fork.
    //
    // SOFT, DELIBERATELY. K8-E5: this is the FIRST thing that fails without
    // `detached`, and a hard failure here aborts the case before the assertion
    // that actually matters - that the psql child is still alive after the group
    // signal - has run at all. Round 44 recorded that gap. A soft assertion is
    // recorded and the case continues, so one run reports both facts; the hard
    // assertions below still decide the verdict.
    expect.soft(pgidOrFail(fakePid, 'the psql child'))
      .not.toBe(pgidOrFail(helperPid, 'the fixture parent'))

    // WHAT A TERMINAL DOES. All three go to the parent's group; none of them is
    // addressed to the psql child, and none of them may reach it.
    for (const sig of ['SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
      process.kill(-helperPid, sig)
    }
    await wait(SETTLE_MS)

    expect(alive(helperPid), 'the fixture declined the signals').toBe(true)
    // THE ASSERTION THE WHOLE CHANGE EXISTS FOR, and the one MG1 must reach.
    expect(alive(fakePid), 'the psql child never received them').toBe(true)

    // AND THE OTHER HALF: detached is not orphaned. The child's stdin is a pipe
    // only its parent writes, so the parent's death is still the child's EOF.
    //
    // K8-E6 hygiene: AND THE HELPER IS WAITED FOR. `process.kill` returns as soon
    // as the signal is queued, not when the process is gone, so the old code left
    // teardown to re-signal a pid it had already killed - and, once the OS reuses
    // the number, that is a signal to somebody else. The exit is awaited under a
    // bound, and only then is the pid recorded as reaped.
    const helperExited = new Promise<void>(res => { child.once('exit', () => { res() }) })
    process.kill(helperPid, 'SIGKILL')
    let helperGone = false
    await Promise.race([
      helperExited.then(() => { helperGone = true }),
      new Promise<void>(res => { setTimeout(res, EXIT_DEADLINE_MS) }),
    ])
    expect(helperGone, 'the fixture parent did not exit after SIGKILL').toBe(true)
    reaped.add(helperPid)

    const ended = await until(() => !alive(fakePid), EXIT_DEADLINE_MS)
    // HARD, AND LAST. Whatever the soft assertion recorded, the case is not
    // allowed to pass unless this holds.
    expect(ended, 'the psql child outlived its parent').toBe(true)
    reaped.add(fakePid)
  }, 60_000)
})
