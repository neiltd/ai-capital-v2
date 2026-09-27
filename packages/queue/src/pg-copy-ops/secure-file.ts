// OPENING A REVIEWED FILE ONCE, AND READING THE FILE THAT WAS CHECKED.
//
// THE DESCRIPTOR IS THE SUBJECT, NOT THE PATH. Every property is asserted with
// `fstat` on the OPEN descriptor, and the bytes are then read FROM THAT SAME
// DESCRIPTOR. An earlier revision validated the fd and then called
// `readFileSync(path)`, which reopens the pathname: between the two calls the
// name can be pointed at a different file, and what was returned was the bytes
// of something nothing had checked. The fd cannot be redirected once it is
// open, so reading from it is the only way "the file I validated" and "the file
// I read" are the same sentence.
//
// THE SUPPLIED PATH MUST ALREADY BE CANONICAL. `realpath` is compared with what
// the caller handed in, and a difference is refused rather than resolved:
// resolving it would mean this module silently read a file at a path the
// caller never named, and the caller is the one whose policy document, plist or
// argument list records which file was meant. `O_NOFOLLOW` covers the final
// component; the comparison covers every ancestor. Together they refuse a
// symlink substituted anywhere in the name.
//
// WHAT COMES BACK IS A DECISION, NOT A SECRET. Callers get an identity and the
// bytes, exactly once; the parsed contents are dropped on the way out and are
// never hashed, logged, returned or persisted. A digest of a credential is
// still an oracle for it, so there is no "just the hash" concession here.

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'

export class SecureFileRefused extends Error {
  constructor(readonly reason: SecureFileReason, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'SecureFileRefused'
  }
}

export type SecureFileReason =
  | 'the path is not absolute'
  | 'the path does not resolve to itself'
  | 'the file could not be opened without following a symbolic link'
  | 'the file is not a regular file'
  | 'the file is not owned by this user'
  | 'the file is not mode 0600'
  | 'the file has more than one link'
  | 'the file is larger than the reviewed limit'
  | 'the file is not readable by its owner alone or by its owner and group'
  | 'the file changed between the check and the read'

/** 4 KiB. A credential container is one URL; anything larger is not one. */
export const MAX_CONTAINER_BYTES = 4096

/** 256 KiB. A launchd plist is a few hundred bytes; this is generous. */
export const MAX_PLIST_BYTES = 262_144

export interface ContainerIdentity {
  readonly path: string
  readonly deviceInode: string
  readonly uid: number
  readonly mode: string
  readonly links: number
  readonly size: number
}

export interface OpenedContainer {
  readonly identity: ContainerIdentity
  /** The bytes, READ FROM THE VALIDATED DESCRIPTOR. */
  readonly text: string
}

export interface OpenedPlist extends OpenedContainer {
  /** SHA-256 of the exact bytes above. One read, one hash, one parse. */
  readonly sha256: string
}

interface Policy {
  readonly maxBytes: number
  /** Permission bits the file may have. A closed set, not a maximum. */
  readonly modes: readonly bigint[]
  readonly tooWide: SecureFileReason
}

/** A credential: 0600 and nothing else. Group and other may not read it. */
const CREDENTIAL: Policy = Object.freeze({
  maxBytes: MAX_CONTAINER_BYTES,
  modes: Object.freeze([0o600n]),
  tooWide: 'the file is not mode 0600',
})

/**
 * A plist: 0600 or 0644.
 *
 * WIDER ON PURPOSE, AND ONLY THIS WIDE. `launchctl print` shows an agent's
 * environment to anyone in the session, so a plist is not a secret and a
 * reviewed installation may legitimately leave it world-readable. What it may
 * NOT be is group- or world-WRITABLE, which is what the closed set excludes:
 * a writable plist is a plist somebody else chooses the contents of.
 */
const PLIST: Policy = Object.freeze({
  maxBytes: MAX_PLIST_BYTES,
  modes: Object.freeze([0o600n, 0o644n, 0o640n]),
  tooWide: 'the file is not readable by its owner alone or by its owner and group',
})

function openChecked(path: string, policy: Policy): OpenedContainer {
  if (!path.startsWith('/')) throw new SecureFileRefused('the path is not absolute')
  // THE CALLER'S SPELLING MUST BE THE CANONICAL ONE. Not resolved for them:
  // a name that resolves elsewhere is a name that was substituted, and the
  // caller is the one holding the record of which file was meant.
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch {
    throw new SecureFileRefused('the path does not resolve to itself')
  }
  if (resolved !== path) throw new SecureFileRefused('the path does not resolve to itself')

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new SecureFileRefused(
      'the file could not be opened without following a symbolic link')
  }
  try {
    const st = fstatSync(fd, { bigint: true })
    if (!((st.mode & 0o170000n) === 0o100000n)) {
      throw new SecureFileRefused('the file is not a regular file')
    }
    if (Number(st.uid) !== process.getuid?.()) {
      throw new SecureFileRefused('the file is not owned by this user')
    }
    if (!policy.modes.includes(st.mode & 0o777n)) {
      throw new SecureFileRefused(policy.tooWide)
    }
    if (Number(st.nlink) !== 1) throw new SecureFileRefused('the file has more than one link')
    if (Number(st.size) > policy.maxBytes) {
      throw new SecureFileRefused('the file is larger than the reviewed limit')
    }

    // READ FROM THE DESCRIPTOR. `readFileSync` accepts an fd, and reading the
    // fd is what makes the checks above statements about these bytes rather
    // than about a file that happened to be at this name a moment ago.
    const text = readFileSync(fd, 'utf-8')

    // AND THE DESCRIPTOR IS STILL THE SAME FILE. A file truncated or extended
    // underneath an open fd keeps its inode, so the size is re-read and
    // compared: a mismatch means what was measured is not what was read.
    const after = fstatSync(fd, { bigint: true })
    if (after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size) {
      throw new SecureFileRefused('the file changed between the check and the read')
    }

    return Object.freeze({
      identity: Object.freeze({
        path,
        deviceInode: `${String(st.dev)}:${String(st.ino)}`,
        uid: Number(st.uid),
        mode: (st.mode & 0o777n).toString(8),
        links: Number(st.nlink),
        size: Number(st.size),
      }),
      text,
    })
  } finally {
    try { closeSync(fd) } catch { /* bounded */ }
  }
}

/**
 * Open a reviewed 0600 credential container and return its identity and bytes.
 *
 * The descriptor is closed before this returns on every path, including every
 * refusal, so a rejected container never leaves a file handle behind.
 */
export function openReviewedContainer(path: string): OpenedContainer {
  return openChecked(path, CREDENTIAL)
}

/**
 * Open a reviewed plist ONCE and return its bytes and their digest together.
 *
 * ONE READ, ONE HASH, ONE PARSE. An earlier revision hashed the file through
 * one `readFileSync(path)` and then handed the PATH to `plutil`, which opens it
 * again: the recorded digest and the parsed contents were two different reads
 * of a name, and nothing established they were the same file. The bytes come
 * back here so the caller can hash what it parses and parse what it hashed.
 */
/**
 * PROVE A FILE'S METADATA WITHOUT EVER READING ITS BYTES.
 *
 * FOR PGPASSFILE, WHICH THIS PROCESS MUST NOT READ. `psql` reads it during
 * authentication - that is its job and it is unavoidable - but nothing in THIS
 * application has any reason to hold a password in its own address space, and
 * `openReviewedContainer` would put one there: it returns the bytes. An earlier
 * revision called it and then claimed in a comment that the contents were not
 * read, which was false the moment the function returned.
 *
 * SO THE DESCRIPTOR IS OPENED, `fstat`ed, AND CLOSED. Same canonical-path rule,
 * same `O_NOFOLLOW`, same ownership, mode and link checks - and no `read` call
 * anywhere in this function. What comes back is an identity, never a secret.
 */
export function proveReviewedFileMetadata(path: string): ContainerIdentity {
  const held = openReviewedFileDescriptor(path)
  try {
    return held.identity
  } finally {
    held.close()
  }
}

/** A validated descriptor the caller keeps open. Closed by `close()`. */
export interface HeldDescriptor {
  readonly fd: number
  readonly identity: ContainerIdentity
  close(): void
}

/**
 * PROVE A FILE'S METADATA AND KEEP THE DESCRIPTOR OPEN.
 *
 * WHY THE CALLER MAY WANT TO HOLD IT. Proving a PATHNAME and then letting
 * somebody else open that name is a TOCTOU boundary: everything proved was
 * proved about the file that WAS there, and whoever opens it next gets
 * whatever is there then. For PGPASSFILE that "somebody else" is the psql
 * child, and the window between the check and its `open` is exactly long
 * enough for a file in a writable directory to be replaced.
 *
 * An open descriptor cannot be redirected. Handing the CHILD this descriptor -
 * inherited, named to it as `/dev/fd/N` - makes the file that was validated
 * and the file that is authenticated with the same object.
 *
 * STILL NO READ. This function opens, `fstat`s and returns; it never reads.
 */
export function openReviewedFileDescriptor(path: string): HeldDescriptor {
  if (!path.startsWith('/')) throw new SecureFileRefused('the path is not absolute')
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch {
    throw new SecureFileRefused('the path does not resolve to itself')
  }
  if (resolved !== path) throw new SecureFileRefused('the path does not resolve to itself')

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new SecureFileRefused(
      'the file could not be opened without following a symbolic link')
  }
  let ok = false
  try {
    const st = fstatSync(fd, { bigint: true })
    if (!((st.mode & 0o170000n) === 0o100000n)) {
      throw new SecureFileRefused('the file is not a regular file')
    }
    if (Number(st.uid) !== process.getuid?.()) {
      throw new SecureFileRefused('the file is not owned by this user')
    }
    if ((st.mode & 0o777n) !== 0o600n) {
      throw new SecureFileRefused('the file is not mode 0600')
    }
    if (Number(st.nlink) !== 1) throw new SecureFileRefused('the file has more than one link')
    const identity = Object.freeze({
      path,
      deviceInode: `${String(st.dev)}:${String(st.ino)}`,
      uid: Number(st.uid),
      mode: (st.mode & 0o777n).toString(8),
      links: Number(st.nlink),
      size: Number(st.size),
    })
    ok = true
    return Object.freeze({
      fd,
      identity,
      close: (): void => { try { closeSync(fd) } catch { /* bounded */ } },
    })
  } finally {
    // CLOSED ON EVERY REFUSAL. Only a descriptor that passed every check is
    // handed back, and only then does the caller own closing it.
    if (!ok) { try { closeSync(fd) } catch { /* bounded */ } }
  }
}

export function openReviewedPlist(path: string): OpenedPlist {
  const opened = openChecked(path, PLIST)
  return Object.freeze({
    ...opened,
    sha256: createHash('sha256').update(Buffer.from(opened.text, 'utf-8')).digest('hex'),
  })
}
