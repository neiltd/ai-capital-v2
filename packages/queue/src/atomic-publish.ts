// ONE PUBLICATION PRIMITIVE, USED BY BOTH TOOLS.
//
// The renderer and the credential installer each grew their own copy of
// "temp -> write -> fsync -> rename", and the copies had already diverged. Two
// implementations of a security-relevant sequence means two places to get the
// ordering wrong and only one of them under test, so there is now one.
//
// WHY rename() IS NOT ENOUGH FOR AN INITIAL CREATE.
// rename(2) silently REPLACES its destination. "Refuse if the destination
// exists" cannot be implemented with it: between the check and the rename, a
// competing writer can create the file, and rename destroys their bytes without
// a word. link(2) is the primitive that fails with EEXIST instead, so an initial
// create publishes with link and an explicit replacement publishes with rename —
// and the replacement path only runs while the lock is held and after the
// destination has been re-inspected.
//
// TEMPORARY OWNERSHIP. Cleanup unlinks only a path this invocation created. If
// opening the temporary returns EEXIST, the path belongs to somebody else and is
// left completely alone; deleting it would be this tool doing to another process
// exactly what the EEXIST is there to prevent.
//
// macOS DURABILITY LIMIT, stated rather than implied: Node's fsyncSync maps to
// fsync(2), which does not force the drive's own cache flush. That is
// fcntl(F_FULLFSYNC), which Node does not expose.

import {
  closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'fs'
import { basename, dirname, join } from 'path'

export interface PublishSeam {
  openSync: (p: string, flags: number, mode?: number) => number
  writeSync: (fd: number, buf: Uint8Array, offset: number, length: number) => number
  fsyncSync: (fd: number) => void
  closeSync: (fd: number) => void
  renameSync: (a: string, b: string) => void
  linkSync: (a: string, b: string) => void
  unlinkSync: (p: string) => void
  lstatSync: (p: string) => { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; uid: number; mode: number; nlink: number }
  statSync: (p: string) => { isDirectory(): boolean; uid: number; mode: number }
  readFileSync: (p: string) => Buffer
  currentUid: () => number
}

export const defaultPublishSeam: PublishSeam = {
  openSync: (p, flags, mode) => openSync(p, flags, mode),
  writeSync: (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
  fsyncSync,
  closeSync,
  renameSync,
  linkSync,
  unlinkSync,
  lstatSync,
  statSync,
  readFileSync,
  currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
}

export type PublishMode = 'create' | 'replace'

export interface PublishOptions {
  /** 'create' refuses an existing destination atomically; 'replace' rotates it. */
  mode: PublishMode
  /** File mode for the published file. */
  fileMode: number
  /** Required mode of the containing directory, or null to accept any. */
  directoryMode: number | null
  /** Optional check run on the TEMPORARY file before publication (e.g. plutil). */
  validate?: (tempPath: string) => void
}

/**
 * What happened AFTER the destination became correct.
 *
 * Publication and cleanup are different events, and conflating them is how a
 * "clean success" can hide a credential still reachable through a second
 * filename. Every post-publication step therefore has a place to record its own
 * failure, and none of them is allowed to roll the destination back.
 */
export interface CleanupState {
  /**
   * 'removed'   — the temporary name is gone (or there never was one to remove);
   * 'retained'  — LINK PUBLICATION SUCCEEDED but the temporary name survives, so
   *               the published bytes are reachable through two names and the
   *               destination has nlink=2.
   */
  temporary: 'removed' | 'retained'
  /** Set when `temporary` is 'retained': the path still pointing at the bytes. */
  temporaryPath?: string
  /** Why the temporary could not be removed. */
  temporaryUnlinkError?: string
  /** The directory fsync taken immediately after publication failed. */
  directoryFsyncFailed?: string
  /** The SECOND directory fsync — the one that makes the unlink durable — failed. */
  postUnlinkFsyncFailed?: string
  /** False when this invocation's lock could not be removed. */
  lockReleased: boolean
  /** Set when `lockReleased` is false: the lock that now blocks later runs. */
  lockPath?: string
  lockReleaseError?: string
}

export interface PublishOutcome {
  /** True once the destination refers to the new bytes. */
  published: boolean
  /** True when the destination already held exactly these bytes. */
  unchanged: boolean
  /** Post-publication state. Always present; inspect it before reporting success. */
  cleanup: CleanupState
}

/**
 * True when the destination is correct but the invocation did not finish
 * tidily. A caller must not report plain success in this state.
 */
export function cleanupIncomplete(o: PublishOutcome): boolean {
  const c = o.cleanup
  return c.temporary === 'retained'
    || c.directoryFsyncFailed !== undefined
    || c.postUnlinkFsyncFailed !== undefined
    || !c.lockReleased
}

/** One-line, value-free description of an incomplete cleanup. */
export function describeCleanup(c: CleanupState): string {
  const parts: string[] = []
  if (c.temporary === 'retained') {
    parts.push(`the temporary name ${c.temporaryPath} STILL refers to the published bytes ` +
      `(${c.temporaryUnlinkError ?? 'unlink failed'}); the destination has more than one link until it is removed`)
  }
  if (c.directoryFsyncFailed !== undefined) parts.push(`the directory entry may not be durable (${c.directoryFsyncFailed})`)
  if (c.postUnlinkFsyncFailed !== undefined) parts.push(`removal of the temporary name may not be durable (${c.postUnlinkFsyncFailed})`)
  if (!c.lockReleased) {
    parts.push(`the lock ${c.lockPath} could not be released (${c.lockReleaseError ?? 'unlink failed'}) and will block later runs until removed by hand`)
  }
  return parts.join('; ')
}

/** A write count from an injected seam is not trusted blindly. */
export function checkCount(n: unknown, remaining: number, what: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error(`${what} returned a non-integer count`)
  if (n < 0) throw new Error(`${what} returned a negative count`)
  if (n > remaining) throw new Error(`${what} returned ${n}, more than the ${remaining} bytes requested`)
  return n
}

/** Validate a containing directory: real, owned, and optionally exact-mode. */
export function assertDirectory(dir: string, requiredMode: number | null, seam: PublishSeam = defaultPublishSeam): void {
  let st: ReturnType<PublishSeam['lstatSync']>
  try {
    st = seam.lstatSync(dir)
  } catch (e) {
    throw new Error(`directory ${dir} could not be inspected (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`)
  }
  // lstat, not stat: stat follows a symlink and would report the target.
  if (st.isSymbolicLink()) throw new Error(`directory ${dir} is a symbolic link`)
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`)
  const uid = seam.currentUid()
  if (uid < 0) throw new Error(`ownership of ${dir} cannot be checked on this platform`)
  if (st.uid !== uid) throw new Error(`directory ${dir} is owned by another user`)
  if (requiredMode !== null && (st.mode & 0o777) !== requiredMode) {
    throw new Error(`directory ${dir} must be mode ${requiredMode.toString(8).padStart(4, '0')}`)
  }
}

/** Inspect a publication destination. Throws on anything unsafe to publish over. */
export function inspectDestination(
  destination: string,
  seam: PublishSeam = defaultPublishSeam,
): { exists: boolean; bytes?: Buffer } {
  let st: ReturnType<PublishSeam['lstatSync']>
  try {
    st = seam.lstatSync(destination)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw new Error(`destination ${destination} could not be inspected (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`)
  }
  if (st.isSymbolicLink()) throw new Error(`destination ${destination} is a symbolic link`)
  if (!st.isFile()) throw new Error(`destination ${destination} is not a regular file`)
  const uid = seam.currentUid()
  if (st.uid !== uid) throw new Error(`destination ${destination} is owned by another user`)
  if (st.nlink !== 1) throw new Error(`destination ${destination} has more than one hard link`)
  return { exists: true, bytes: seam.readFileSync(destination) }
}

export interface LockRelease { released: boolean; error?: string }

export interface Lock { path: string; release: () => LockRelease }

/**
 * Create an exclusive lock, or report the existing one.
 *
 * Existing-lock metadata is reported as OPAQUE TEXT. It was written by another
 * process and is data, never an instruction — it is length-capped and stripped
 * of control characters before it is shown.
 */
export function acquireLock(lockPath: string, seam: PublishSeam = defaultPublishSeam): Lock {
  let fd: number
  try {
    fd = seam.openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      let held = '(unreadable)'
      try {
        held = seam.readFileSync(lockPath).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').slice(0, 120)
      } catch { /* keep the placeholder */ }
      throw new Error(
        `another invocation holds ${lockPath} [${held}]. Inspect and remove it by hand if no tool is running; ` +
        'locks are never stolen, because a steal is how two writers interleave.',
      )
    }
    throw e
  }

  // WE CREATED IT, SO WE OWN IT — and a failure from here must not leave it
  // behind silently. A surviving lock blocks every later installation and
  // rotation, so if we cannot remove our own lock the operator learns about it
  // in the same breath as the original failure. A CLOSE failure counts as an
  // initialization failure: returning a "usable" Lock whose descriptor did not
  // close would claim an acquisition that did not cleanly happen.
  let initFailure: Error | undefined
  try {
    const stamp = Buffer.from(`pid=${process.pid} at=${new Date().toISOString()}\n`, 'utf-8')
    let written = 0
    while (written < stamp.length) {
      const n = checkCount(seam.writeSync(fd, stamp, written, stamp.length - written), stamp.length - written, 'lock write')
      if (n === 0) throw new Error('short write while initializing the lock')
      written += n
    }
  } catch (e) {
    initFailure = e instanceof Error ? e : new Error(String(e))
  }

  try {
    seam.closeSync(fd)
  } catch (e) {
    if (initFailure === undefined) {
      initFailure = new Error(`the lock descriptor could not be closed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`)
    }
  }

  if (initFailure !== undefined) {
    let cleanupNote = ''
    try {
      seam.unlinkSync(lockPath)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        cleanupNote =
          ` (additionally: the lock ${lockPath} was created but could NOT be removed (${code ?? (e as Error).message}); ` +
          'it will block later runs until inspected and removed by hand)'
      }
    }
    throw new Error(`${initFailure.message}${cleanupNote}`)
  }

  // Only a lock this invocation CREATED is ever unlinked — acquireLock returns a
  // Lock exclusively on the O_EXCL path, so there is no route by which this
  // removes someone else's.
  //
  // HONEST LIMIT: between our creation and our unlink, another process could in
  // principle remove the lock and create its own, and we would then delete
  // theirs. Node exposes no compare-and-delete (no file handle identity check at
  // unlink time), so this is not defended against; the mitigation is the
  // owner-only directory and the fact that both processes are the same account.
  // A release FAILURE is never swallowed — it is reported to the caller, because
  // a surviving lock blocks every later installation and rotation.
  return {
    path: lockPath,
    release: (): LockRelease => {
      try {
        seam.unlinkSync(lockPath)
        return { released: true }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        // ENOENT means it is already gone, which is the state we wanted.
        if (code === 'ENOENT') return { released: true }
        return { released: false, error: code ?? (e as Error).message }
      }
    },
  }
}

/**
 * Publish `bytes` to `destination` atomically, or leave it untouched.
 *
 * Order: directory -> lock -> RE-inspect destination -> temp -> write -> fsync ->
 * close -> validate -> publish (link for create, rename for replace) -> fsync
 * directory -> remove the temporary -> fsync directory again -> release lock.
 *
 * PUBLICATION AND CLEANUP ARE DIFFERENT EVENTS. Once the destination is correct
 * it is NEVER rolled back — not for a failed unlink, not for a failed fsync, not
 * for a failed lock release. Undoing a correct publication to satisfy a tidiness
 * step would trade a real success for a cosmetic one. Instead every
 * post-publication failure is recorded in `cleanup`, and the caller is expected
 * to check `cleanupIncomplete()` before reporting success.
 *
 * The specific hazard this replaces: a best-effort unlink after LINK publication
 * could fail silently, leaving the credential reachable through a second
 * filename with nlink=2, while the tool reported a clean success.
 */
export function publishBytes(
  destination: string,
  bytes: Buffer,
  options: PublishOptions,
  seam: PublishSeam = defaultPublishSeam,
): PublishOutcome {
  const dir = dirname(destination)
  assertDirectory(dir, options.directoryMode, seam)

  const lock = acquireLock(`${destination}.lock`, seam)
  let outcome: PublishOutcome | undefined
  let failure: unknown

  try {
    outcome = publishUnderLock(destination, bytes, options, seam, dir)
  } catch (e) {
    failure = e
  }

  const release = lock.release()

  if (failure !== undefined) {
    // Publication did not happen. The ORIGINAL error stays primary — a lock we
    // could not clean up must not mask why nothing was published — but it is
    // appended rather than dropped, because the surviving lock will block the
    // operator's next attempt and they need to know that now.
    if (!release.released) {
      const primary = failure instanceof Error ? failure.message : String(failure)
      throw new Error(
        `${primary} (additionally: the publication lock ${lock.path} could not be released ` +
        `(${release.error ?? 'unlink failed'}); it will block later runs until inspected and removed by hand)`,
      )
    }
    throw failure
  }

  const result = outcome as PublishOutcome
  result.cleanup.lockReleased = release.released
  if (!release.released) {
    result.cleanup.lockPath = lock.path
    result.cleanup.lockReleaseError = release.error
  }
  return result
}

/** The publication itself, with the lock already held. */
function publishUnderLock(
  destination: string,
  bytes: Buffer,
  options: PublishOptions,
  seam: PublishSeam,
  dir: string,
): PublishOutcome {
  const cleanup: CleanupState = { temporary: 'removed', lockReleased: true }

  const before = inspectDestination(destination, seam)
  if (before.exists && before.bytes?.equals(bytes)) {
    return { published: false, unchanged: true, cleanup }
  }
  if (before.exists && options.mode === 'create') {
    throw new Error(`destination ${destination} already exists; an explicit replacement is required.`)
  }
  if (!before.exists && options.mode === 'replace') {
    throw new Error(`destination ${destination} does not exist; a replacement was requested but there is nothing to replace.`)
  }

  const temp = join(dir, `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`)
  let ownsTemp = false
  let fd: number | undefined

  const fsyncDirectory = (): string | undefined => {
    try {
      const dirFd = seam.openSync(dir, constants.O_RDONLY)
      try { seam.fsyncSync(dirFd) } finally { seam.closeSync(dirFd) }
      return undefined
    } catch (e) {
      return (e as Error).message
    }
  }

  try {
    try {
      fd = seam.openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, options.fileMode)
      ownsTemp = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // NOT ours. Leaving it alone is the entire point of O_EXCL.
        throw new Error(`temporary ${temp} already exists and is not ours; refusing to touch it.`)
      }
      throw e
    }

    let written = 0
    while (written < bytes.length) {
      const n = checkCount(seam.writeSync(fd, bytes, written, bytes.length - written), bytes.length - written, 'write')
      if (n === 0) throw new Error('short write; nothing was published')
      written += n
    }
    seam.fsyncSync(fd)
    seam.closeSync(fd)
    fd = undefined

    if (options.validate) options.validate(temp)

    if (options.mode === 'create') {
      // link() fails with EEXIST rather than destroying a competing writer.
      try {
        seam.linkSync(temp, destination)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`destination ${destination} was created by another writer; nothing was published and their file is untouched.`)
        }
        throw e
      }
    } else {
      seam.renameSync(temp, destination)
      ownsTemp = false          // rename consumed the temp name
    }
    // Reaching here means the destination is correct; the catch below is
    // therefore the PRE-publication path by construction.
  } catch (e) {
    // PRE-PUBLICATION FAILURE. By the time a write, fsync, close, validation or
    // link can fail, the bytes are ALREADY in the temporary — for the installer
    // those bytes are the credential. Removing it is therefore not tidying, it
    // is containment, and a failure to remove it cannot be swallowed: the
    // destination is absent, so an operator told only "publication failed" would
    // never learn that secret material is sitting under a dotfile.
    //
    // The ORIGINAL failure stays primary; the cleanup problem is appended.
    if (fd !== undefined) { try { seam.closeSync(fd) } catch { /* ignore */ } fd = undefined }
    const primary = e instanceof Error ? e.message : String(e)
    if (ownsTemp) {
      try {
        seam.unlinkSync(temp)
      } catch (unlinkError) {
        const code = (unlinkError as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          throw new Error(
            `${primary} (additionally: the destination was NOT published, but the temporary ${temp} ` +
            `could NOT be removed (${code ?? (unlinkError as Error).message}). It may still contain ` +
            'credential material and requires manual inspection and removal. Its contents are not reported.)',
          )
        }
      }
    }
    throw e
  } finally {
    if (fd !== undefined) { try { seam.closeSync(fd) } catch { /* ignore */ } }
  }

  // ── from here the destination IS correct; nothing below may undo it ───────
  cleanup.directoryFsyncFailed = fsyncDirectory()

  if (ownsTemp) {
    // link() left the temporary name pointing at the same inode. Until it is
    // gone the published bytes have two names — for a credential file that is a
    // second, unmanaged copy, so a failure here is REPORTED, never swallowed.
    try {
      seam.unlinkSync(temp)
      cleanup.temporary = 'removed'
      cleanup.postUnlinkFsyncFailed = fsyncDirectory()
    } catch (e) {
      cleanup.temporary = 'retained'
      cleanup.temporaryPath = temp
      cleanup.temporaryUnlinkError = (e as NodeJS.ErrnoException).code ?? (e as Error).message
    }
  }

  return { published: true, unchanged: false, cleanup }
}
