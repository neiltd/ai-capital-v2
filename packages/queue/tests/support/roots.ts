// WHO OWNS A TEMPORARY ROOT, AND WHAT MAY BE DONE TO IT.
//
// WHAT WENT WRONG, SO IT CANNOT AGAIN. Cleanup used to live in a worker-local
// `afterEach` and in the parent half of the container. Both are inside the
// Vitest worker. Interrupt the outer command - ^C, a killed terminal, a CI
// cancellation - and neither runs: the worker dies, the DETACHED hold child is
// reparented to PPID 1, and it goes on publishing into a root nobody is left to
// remove. Forty abandoned roots were sitting in the real temporary directory
// when this was found.
//
// SO OWNERSHIP IS A NAME, NOT A LIVE HANDLE. Every root this harness creates
// carries the invocation's run nonce and the creating pid in its basename. That
// makes the question "is this mine?" answerable by a LATER process, from the
// filesystem alone, with no surviving parent and no registry - which is exactly
// the situation an interrupt leaves behind.
//
// AND REMOVAL IS BY EXACT VALIDATED PATH, NEVER BY PATTERN. Nothing here takes a
// glob, walks the temporary directory recursively, or removes a path it has not
// first proved is a real directory, directly beneath the real temporary
// directory, under the reviewed name, owned by this user. A directory that
// merely LOOKS related - a foreign sentinel, somebody else's run, a symlink
// pointing at something precious - is refused, not removed.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** The reviewed leading component. Nothing outside it is ever considered. */
export const ROOT_FAMILY = 'pgcopy-modes-'

/**
 * THE INVOCATION NONCE, AND WHY A PID IS NOT ENOUGH.
 *
 * One invocation is many processes: the runner, one Vitest worker per file, and
 * a contained child per hold-capable case. They must agree on a single answer to
 * "is this root from THIS invocation?", because the reaper's whole job is to
 * distinguish a root the current run owns - which must be removed at the end -
 * from a stale root an interrupted earlier run left, which may only be removed
 * after proving nothing live still references it.
 *
 * A pid cannot carry that: pids are per-process and the operating system reuses
 * them, so a stale root could be mistaken for a live one and spared for ever, or
 * a live one mistaken for stale and removed underneath a running child. The
 * nonce is minted once by the runner and inherited through the environment; a
 * process started without one mints its own, so a bare `vitest run` is still
 * internally consistent.
 *
 * IT IS VALIDATED, NEVER TRUSTED. An environment that supplied anything but
 * sixteen lowercase hex characters could otherwise steer these directory names,
 * and every safety check here is a check on a name.
 */
export const NONCE_FORM = /^[0-9a-f]{16}$/
export const NONCE_ENV = 'PGCOPY_MODES_RUN_NONCE'

export function mintNonce(): string {
  return randomBytes(8).toString('hex')
}

export const RUN_NONCE = ((): string => {
  const supplied = process.env[NONCE_ENV]
  if (supplied === undefined) return mintNonce()
  if (!NONCE_FORM.test(supplied)) {
    throw new Error(`the supplied run nonce is not in the reviewed form: ${supplied}`)
  }
  return supplied
})()

/**
 * THE REVIEWED BASENAME, EXACTLY.
 *
 *   pgcopy-modes-<nonce>-<pid>-XXXXXX        a world root
 *   pgcopy-modes-<nonce>-<pid>-c<n>-XXXXXX   a contained child's world root
 *   pgcopy-modes-<nonce>-<pid>-c<n>-ctlXXXXXX   that child's control directory
 *
 * `XXXXXX` is the six characters `mkdtemp` appends. The form is anchored at both
 * ends: `pgcopy-modes-something-else` is NOT a root of ours and is never touched,
 * which is what lets a foreign sentinel sit in the same directory untouched.
 */
export const REVIEWED_ROOT =
  /^pgcopy-modes-([0-9a-f]{16})-([0-9]{1,10})-(?:c([0-9]{1,4})-)?(?:ctl)?[A-Za-z0-9]{6}$/

export interface RootName {
  readonly nonce: string
  readonly pid: number
  /** The contained-child sequence number, or null for a root made in-process. */
  readonly child: number | null
}

/** Parse a basename, or `null` when it is not one of ours at all. */
export function parseRootName(name: string): RootName | null {
  const m = REVIEWED_ROOT.exec(name)
  if (m === null) return null
  const [, nonce, pid, child] = m
  return Object.freeze({
    nonce: nonce as string,
    pid: Number(pid),
    child: child === undefined ? null : Number(child),
  })
}

let cachedTmp: string | null = null
/**
 * THE REAL TEMPORARY DIRECTORY, RESOLVED ONCE.
 *
 * `tmpdir()` on macOS is a symlinked `/var/folders/...` path with a trailing
 * slash, and `mkdtemp` returns the resolved one. Comparing an unresolved parent
 * against a resolved path is how a correct ownership check silently rejects
 * everything - which fails safe, but leaves the residue this file exists to
 * remove.
 */
export function realTmp(): string {
  if (cachedTmp === null) cachedTmp = realpathSync(tmpdir())
  return cachedTmp
}

/** This process's own prefix: every root it creates begins with exactly this. */
export const ROOT_PREFIX_FOR = (nonce: string, pid: number): string =>
  `${ROOT_FAMILY}${nonce}-${String(pid)}-`

export class NotOurRoot extends Error {}

/**
 * PROVE A PATH IS A ROOT THIS HARNESS MAY REMOVE, or refuse it.
 *
 * Every check is here, once, so there is one answer to "may this be deleted"
 * rather than one per caller:
 *
 *   1. its PARENT is the real temporary directory, compared resolved - so
 *      `.../T/x/../../../Users/...` is not a root, whatever it is spelled as;
 *   2. its BASENAME is the reviewed form - so a foreign directory that merely
 *      starts with `pgcopy-modes-` is refused;
 *   3. it is a REAL DIRECTORY and not a symlink, read with `lstat` so a link is
 *      seen as a link rather than followed to whatever it points at;
 *   4. it is OWNED BY THIS USER, so another account's directory is never ours to
 *      remove even if it were named identically.
 *
 * Returns the parsed name, so a caller that also cares WHOSE it is can ask
 * without parsing the string a second time.
 */
export function provenRoot(path: string): RootName {
  const name = basename(path)
  const parsed = parseRootName(name)
  if (parsed === null) {
    throw new NotOurRoot(`not a reviewed root name: ${name}`)
  }
  // THE PARENT, RESOLVED. `realpathSync` on the path itself would follow a
  // symlinked root and report the target's parent, so the directory being
  // examined is never the thing resolved - only the directory holding it.
  let parent: string
  try { parent = realpathSync(dirname(path)) } catch {
    throw new NotOurRoot(`the parent of ${path} cannot be resolved`)
  }
  if (parent !== realTmp()) {
    throw new NotOurRoot(`not directly beneath the real temporary directory: ${path}`)
  }
  let st
  try { st = lstatSync(path) } catch {
    throw new NotOurRoot(`no such root: ${path}`)
  }
  if (st.isSymbolicLink()) throw new NotOurRoot(`a symlink is never a root: ${path}`)
  if (!st.isDirectory()) throw new NotOurRoot(`not a directory: ${path}`)
  if (st.uid !== process.getuid?.()) {
    throw new NotOurRoot(`owned by uid ${String(st.uid)}, not this user: ${path}`)
  }
  return parsed
}

/**
 * UNFREEZE AND REMOVE ONE PROVED ROOT.
 *
 * WHY THE UNFREEZE IS INSIDE THE PROOF. Published evidence is frozen 0500/0400
 * on purpose and a recursive remove cannot descend into it, so the freeze has to
 * be lifted first. Lifting permissions is the most destructive thing this file
 * does, so it happens only after `provenRoot` has accepted the exact path, and
 * only on that path - never on a pattern, and never on the temporary directory
 * itself.
 */
export function unfreezeProvedRoot(path: string): RootName {
  const parsed = provenRoot(path)
  // NO `--` SEPARATOR: this platform's chmod does not take one. It is not needed
  // either - `provenRoot` has already required the basename to begin with
  // `pgcopy-modes-`, so the path can never be read as an option.
  execFileSync('/bin/chmod', ['-R', 'u+rwX', path])
  return parsed
}

export function removeProvedRoot(path: string): RootName {
  const parsed = unfreezeProvedRoot(path)
  rmSync(path, { recursive: true, force: true })
  return parsed
}

/**
 * EVERY ROOT IN THE REAL TEMPORARY DIRECTORY, AS AN INVENTORY.
 *
 * A single-level `readdir` and a name test - not a recursive walk of the
 * temporary directory, and not a glob handed to a removal command. The result is
 * a list of exact paths; what is done with them is the caller's decision, and
 * every removal re-proves the path it was given.
 */
export function inventory(): readonly { path: string; name: RootName }[] {
  let names: string[] = []
  try { names = readdirSync(realTmp()) } catch { return [] }
  const found: { path: string; name: RootName }[] = []
  for (const n of names) {
    const parsed = parseRootName(n)
    if (parsed === null) continue
    found.push({ path: join(realTmp(), n), name: parsed })
  }
  return found
}

/** The roots belonging to this invocation, whichever process made them. */
export function ownedRoots(nonce: string = RUN_NONCE): readonly string[] {
  return inventory().filter(r => r.name.nonce === nonce).map(r => r.path)
}

/**
 * IS ANY LIVE PROCESS STILL USING THIS PATH?
 *
 * Asked before a STALE root - one from an earlier invocation - is reaped, because
 * the earlier invocation may not be over: a runner that was SIGKILLed leaves its
 * detached children running, and removing a root out from under a process still
 * publishing into it is how residue reappears behind the cleanup.
 *
 * Two independent questions, because neither alone is sufficient: a process may
 * name the path in its command line without holding it open, and a process may
 * hold it open having been given the path by a file its command line never
 * mentions. `lsof` is asked about the exact path only.
 */
export function nothingReferences(path: string): boolean {
  let table = ''
  try {
    table = execFileSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' })
  } catch { return false }
  const self = process.pid
  for (const line of table.split('\n')) {
    const m = /^\s*([0-9]+)\s+(.*)$/.exec(line)
    if (m === null) continue
    if (Number(m[1]) === self) continue
    if ((m[2] as string).includes(path)) return false
  }
  try {
    const open = execFileSync('/usr/sbin/lsof', ['-w', '--', path],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (open.trim().length > 0) return false
  } catch {
    // lsof EXITS NONZERO WHEN NOTHING HOLDS THE PATH, which is the answer we
    // wanted. A missing lsof is a different matter and is treated as "cannot
    // prove it is free", so nothing is removed on a guess.
    if (!existsLsof()) return false
  }
  return true
}

let lsofPresent: boolean | null = null
function existsLsof(): boolean {
  if (lsofPresent === null) {
    try { lsofPresent = lstatSync('/usr/sbin/lsof').isFile() } catch { lsofPresent = false }
  }
  return lsofPresent
}

export interface ReapOutcome {
  readonly reaped: readonly string[]
  /** Paths left alone, each with the reason, so a spared root is never silent. */
  readonly spared: readonly { readonly path: string; readonly why: string }[]
}

/**
 * REAP THE ROOTS OF EARLIER INVOCATIONS, SAFELY.
 *
 * Run at the START of an invocation, which is the only moment at which an
 * interrupted earlier run can be cleaned up at all: its own processes are gone
 * and nothing else will ever look. A root is reaped only when it is stale (a
 * different nonce), passes every ownership check, and no live process references
 * it. Anything else is SPARED and reported - a running sibling invocation must
 * not have its directories removed underneath it.
 */
export function reapStaleRoots(nonce: string = RUN_NONCE): ReapOutcome {
  const reaped: string[] = []
  const spared: { path: string; why: string }[] = []
  for (const { path, name } of inventory()) {
    if (name.nonce === nonce) { spared.push({ path, why: 'this invocation' }); continue }
    if (!nothingReferences(path)) { spared.push({ path, why: 'still referenced' }); continue }
    try { removeProvedRoot(path); reaped.push(path) } catch (e) {
      spared.push({ path, why: (e as Error).message })
    }
  }
  return Object.freeze({ reaped: Object.freeze(reaped), spared: Object.freeze(spared) })
}

/**
 * REMOVE EVERY ROOT OF THIS INVOCATION, and say what was removed.
 *
 * The end-of-run half of the contract: run by the runner after the command has
 * finished OR been interrupted, so a root survives neither path. Idempotent - a
 * root the worker already removed is simply not in the inventory.
 */
export function removeOwnedRoots(nonce: string = RUN_NONCE): readonly string[] {
  const removed: string[] = []
  for (const path of ownedRoots(nonce)) {
    try { removeProvedRoot(path); removed.push(path) } catch { /* reported by the residue check */ }
  }
  return removed
}
