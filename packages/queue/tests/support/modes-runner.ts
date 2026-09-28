// THE OUTER HALF OF THE CONTAINMENT CONTRACT.
//
// WHAT THIS IS FOR. `contained.ts` polices a hold child from the Vitest worker,
// and `afterEach` removes what the worker made. Both die with the worker. So the
// one thing neither can survive is the one thing that happens most often by
// hand: interrupting the outer command. ^C kills the worker, the DETACHED child
// is reparented to PPID 1, and it publishes into a root no surviving process
// knows about. Forty such roots were found in the real temporary directory.
//
// SO THE CEILINGS AND THE CLEANUP GET A PROCESS THAT OUTLIVES THE WORKER. This
// runner mints the invocation nonce, reaps what earlier interrupted invocations
// left, runs the real command in its OWN PROCESS GROUP, and on any of SIGINT,
// SIGTERM, SIGHUP or SIGQUIT kills that whole group and removes every root
// carrying this invocation's nonce before exiting.
//
// IT IS NOT THE LAST LINE OF DEFENCE, DELIBERATELY. A runner can itself be
// SIGKILLed, and a machine can lose power; no parent survives either. That case
// is covered from the other end - the hold child enforces its own hard ceilings
// and terminates itself when it is orphaned - and then by the NEXT invocation,
// which reaps a stale root once it has proved nothing live still references it.
//
// USAGE: `tsx tests/support/modes-runner.ts -- <command> [args...]`

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NONCE_ENV, RUN_NONCE, ownedRoots, reapStaleRoots, removeOwnedRoots,
} from './roots.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUEUE_PKG = join(HERE, '..', '..')

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const command = sep === -1 ? argv : argv.slice(sep + 1)
if (command.length === 0) {
  process.stderr.write('usage: modes-runner.ts -- <command> [args...]\n')
  process.exit(2)
}

const say = (s: string): void => { process.stderr.write(`[modes-runner] ${s}\n`) }

// FIRST, WHAT AN EARLIER INTERRUPTED RUN LEFT. Done before this run creates
// anything, so the two sets can never be confused, and only for roots that are
// stale AND unreferenced - a sibling invocation running right now keeps its own.
const reaped = reapStaleRoots()
if (reaped.reaped.length > 0) say(`reaped ${reaped.reaped.length} stale root(s)`)
for (const s of reaped.spared) {
  if (s.why !== 'this invocation') say(`spared ${s.path}: ${s.why}`)
}

const bin = command[0] as string
const resolved = bin.includes('/') ? bin : join(QUEUE_PKG, 'node_modules', '.bin', bin)

const child = spawn(resolved, command.slice(1), {
  cwd: QUEUE_PKG,
  // ITS OWN PROCESS GROUP, so `kill(-pid)` means "the command and everything it
  // started", including a detached hold child, and means nothing else.
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    [NONCE_ENV]: RUN_NONCE,
    // THE CHILD SIDE OF THE ORPHAN CHECK. A hold child compares this against the
    // process it can actually see; a runner that has died can no longer tell it
    // anything, so the fact has to have been handed over in advance.
    PGCOPY_MODES_RUNNER_PID: String(process.pid),
  },
})
const group = child.pid as number

/**
 * END EVERYTHING THIS INVOCATION OWNS, AND SAY SO.
 *
 * SIGKILL to the group rather than SIGTERM: a hold arms handlers for SIGINT,
 * SIGTERM, SIGHUP and SIGQUIT that deliberately do not exit, because exiting is
 * what would release the fence. The signal that cannot be held is the only one
 * that ends it.
 */
let settled = false
function endEverything(why: string): void {
  if (settled) return
  settled = true
  try { process.kill(-group, 'SIGKILL') } catch { /* already gone */ }
  const removed = removeOwnedRoots()
  say(`${why}: killed the command group, removed ${removed.length} owned root(s)`)
}

/**
 * AND THE RUNNER WATCHES FOR ITS OWN ABANDONMENT.
 *
 * Signals cover the case where somebody interrupts this process. They do not cover
 * the case where whatever launched it DIES without signalling it - a killed
 * terminal, a crashed CI agent, a Vitest worker that finished while this was still
 * running. The runner is then reparented to init, holds a command group nobody is
 * waiting for, and is exactly the abandoned process this whole correction is
 * about. Six of them, measured, after one failing run of the cases below.
 *
 * THE TEST IS REPARENTING, NOT `ppid === 1`. A runner deliberately started
 * detached - `nohup`, `setsid`, a service manager - is at PPID 1 from its first
 * instruction and is not abandoned, so the starting value is recorded and only a
 * CHANGE to init counts.
 */
const STARTING_PPID = process.ppid
setInterval(() => {
  if (STARTING_PPID !== 1 && process.ppid === 1) {
    endEverything('orphaned')
    process.exit(129)
  }
}, 250).unref()

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
  process.on(sig, () => {
    endEverything(sig)
    // EXIT AS THE SIGNAL, not as zero: a caller that interrupted this must see an
    // interrupted exit status, or a script wrapping it will read a cancellation
    // as a pass.
    process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[sig])
  })
}

child.on('exit', (code, signal) => {
  // THE ORDINARY PATH. The command finished or failed on its own; whatever it
  // left is removed here, so a failed run leaves no more behind than a passing
  // one - the residue contract is about the harness, not about the verdict.
  if (!settled) {
    settled = true
    try { process.kill(-group, 'SIGKILL') } catch { /* already gone */ }
    const removed = removeOwnedRoots()
    if (removed.length > 0) say(`removed ${removed.length} owned root(s) after exit`)
  }
  const left = ownedRoots()
  if (left.length > 0) {
    say(`RESIDUE: ${String(left.length)} owned root(s) survived cleanup`)
    for (const p of left) say(`  ${p}`)
    process.exit(70)
  }
  process.exit(signal === null ? (code ?? 0) : 128)
})
