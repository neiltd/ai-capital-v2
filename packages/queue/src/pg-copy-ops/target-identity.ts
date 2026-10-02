/**
 * THE TARGET IDENTITY SESSION, OPENED FROM THE ONE TARGET CREDENTIAL.
 *
 * K8-B: `--target-passfile` and `--target-user` are gone. The target had two
 * independently selected authorities - a driver URL for the node-postgres
 * sessions and a separate pgpass path plus a separately typed user for the
 * psql-backed identity session - and nothing compared them. Two containers can
 * carry different roles, databases or servers, and a pgpass file can carry
 * wildcard rows matching endpoints nobody reviewed. The reviewed driver
 * credential is now the single target authentication authority: this module
 * reads it through the same reviewed-container discipline, proves it against
 * the already-known target endpoint, derives exactly one pgpass record from it,
 * and exposes that record ONLY through an anonymous inherited descriptor.
 *
 * NOTHING HERE ACQUIRES A PATHNAME THE SECRET CAN BE READ FROM. The scratch
 * entry is unlinked before a single secret byte is written, so a crash can
 * leave at most an empty mode-0600 file and never the password.
 */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync,
  writeSync, type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  TARGET_COPY_LOGIN_ROLE, TARGET_COPY_TRANSPORT,
  openPsqlBackend, parseDriverCredentialUrl, pgpassRecordFor,
  type ParsedDriverCredential, type SqlResult,
} from '@common/db/pg-copy'
import { openReviewedContainer } from './secure-file.js'

const { O_CREAT, O_EXCL, O_RDWR, O_NOFOLLOW } = constants

export class TargetIdentityRefused extends Error {
  constructor(readonly reason: string) {
    super(`the target identity session is refused: ${reason}`)
    this.name = 'TargetIdentityRefused'
  }
}

/** Where to look for the target, as the apply already knows it. */
export interface TargetEndpointExpectation {
  readonly host: string
  readonly port: string
  readonly database: string
}

/** The filesystem and spawn capabilities this module needs, and nothing more. */
export interface TargetIdentityOps {
  readonly openSync: (p: string, flags: number, mode: number) => number
  /** NARROWED DELIBERATELY: one descriptor in, one `Stats` out. The `node:fs`
   *  overloads admit a `bigint` variant this module never wants, and a seam
   *  that is wider than its use is a seam a test has to satisfy twice. */
  readonly fstatSync: (fd: number) => Stats
  /** NO-FOLLOW, BY NAME. A descriptor cannot prove a pathname, and `stat` would
   *  follow a symlink installed at the scratch name. This is the only pathname
   *  observation in the module, and it is injected like everything else. */
  readonly lstatSync: (p: string) => Stats
  readonly unlinkSync: (p: string) => void
  /** Positional, so the inherited descriptor's read offset stays at 0. */
  readonly writeSync: (fd: number, b: Buffer, off: number, len: number, pos: number) => number
  readonly fsyncSync: (fd: number) => void
  readonly closeSync: (fd: number) => void
  readonly randomBytes: (n: number) => Buffer
  readonly readContainer: (p: string) => { text: string }
  readonly openBackend: typeof openPsqlBackend
}

export const REAL_TARGET_IDENTITY_OPS: TargetIdentityOps = Object.freeze({
  openSync: (p: string, flags: number, mode: number) => openSync(p, flags, mode),
  fstatSync: (fd: number) => fstatSync(fd),
  lstatSync: (p: string) => lstatSync(p),
  unlinkSync: (p: string) => { unlinkSync(p) },
  writeSync: (fd: number, b: Buffer, off: number, len: number, pos: number) =>
    writeSync(fd, b, off, len, pos),
  fsyncSync: (fd: number) => { fsyncSync(fd) },
  closeSync: (fd: number) => { closeSync(fd) },
  randomBytes: (n: number) => randomBytes(n),
  readContainer: (p: string) => openReviewedContainer(p),
  openBackend: openPsqlBackend,
})

/** How many unpredictable scratch names to try before refusing. */
export const SCRATCH_ATTEMPTS = 8

/**
 * READ AND PROVE THE TARGET CREDENTIAL. No psql process exists yet.
 *
 * The expectation is evaluated BEFORE the bytes are used for anything: a
 * credential naming another host, port or database is refused here, so no
 * backend is ever constructed against an endpoint the apply did not intend.
 */
export function provedTargetCredential(
  path: string, expected: TargetEndpointExpectation,
  ops: TargetIdentityOps = REAL_TARGET_IDENTITY_OPS,
): ParsedDriverCredential {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TargetIdentityRefused('the target credential path is not canonical')
  }
  // THE REVIEWED CONTAINER DISCIPLINE, through the existing primitive: absolute
  // canonical path, no symlink traversal, regular file, this user, 0600, one
  // link, and the same descriptor validated and read.
  const text = ops.readContainer(path).text
  // AT MOST ONE TRAILING LF, and no other CR/LF anywhere. The parser refuses
  // embedded newlines itself; this is about the file's own terminator.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (/[\r\n]/.test(body)) {
    throw new TargetIdentityRefused('the target credential is not a single line')
  }
  // ONE PARSER. There is no second URL grammar in this file.
  const parsed = parseDriverCredentialUrl(body)
  // THE REVIEWED TRANSPORT. `pg_hba.conf` has no `host` rule for the copy login,
  // so a TCP credential for it could not authenticate: accepting one would mean
  // switching transports silently and failing later, with a fence already held.
  if (parsed.form !== TARGET_COPY_TRANSPORT) {
    throw new TargetIdentityRefused(
      'the target credential is not the reviewed private-socket form')
  }
  // THE REVIEWED PRINCIPAL, FROM A CONSTANT - not from this credential, not from
  // a session it opened, not from the binding being built. Checked here, before
  // any scratch entry exists and before any child is spawned. The reason names
  // no supplied user, URL, password or digest.
  if (parsed.user !== TARGET_COPY_LOGIN_ROLE) {
    throw new TargetIdentityRefused(
      'the target credential does not name the reviewed copy login')
  }
  if (parsed.host !== expected.host) {
    throw new TargetIdentityRefused('the target credential names another host')
  }
  if (String(parsed.port) !== expected.port) {
    throw new TargetIdentityRefused('the target credential names another port')
  }
  if (parsed.database !== expected.database) {
    throw new TargetIdentityRefused('the target credential names another database')
  }
  return parsed
}

/**
 * ONE ANONYMOUS DESCRIPTOR CARRYING THE PGPASS RECORD.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE POINT:
 *
 *   1  O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW, mode 0600, under the credential's own
 *      already-reviewed directory - same filesystem, same permissions regime.
 *   2  `fstat` the OPEN DESCRIPTOR exactly once. That receipt - device, inode,
 *      type, owner, mode, link count - is the ONLY identity every later
 *      observation is compared against.
 *   3  `lstat` THE EXACT SCRATCH NAME and require it to be that same object.
 *      A DESCRIPTOR CANNOT PROVE A PATHNAME: replacing the name does not change
 *      the inode behind an already-open fd, so without this comparison a
 *      replacement installed at the name is unlinked as a matter of course.
 *      WHAT THE COMPARISON DOES NOT BUY is atomicity. `lstat` then `unlink` is
 *      two calls, and a same-uid actor who renames over the name in between can
 *      still have its replacement removed. The comparison narrows that window to
 *      the gap between the two syscalls; it does not close it. Step 4 is what
 *      keeps the SECRET safe regardless, because no byte is written until the
 *      descriptor itself proves nothing names the object any more.
 *   4  UNLINK THAT NAME, then `fstat` again and require `nlink === 0`. Unlink
 *      success says one name went away, not that none is left: a hard link made
 *      in the race window survives it, and the secret would then land in a file
 *      somebody else can still open by name.
 *   5  only then write the record, positionally from offset 0, and `fsync`.
 *
 * K8-B1 stopped at a second `fstat(fd)` and called that a pathname proof. It is
 * not one, and the test that "proved" it mutated the inode behind an open
 * descriptor, which is not how pathname substitution behaves.
 *
 * The caller passes the descriptor - never a path - to `psql`, which sees it as
 * `/dev/fd/3`. The read offset is still 0 because every write was positional.
 */
export function anonymousPassfileFd(
  directory: string, record: string, ops: TargetIdentityOps = REAL_TARGET_IDENTITY_OPS,
): number {
  let opened: number | null = null
  let candidateUsed: string | null = null
  // WHAT THIS INVOCATION ACTUALLY DID, so cleanup can only ever touch an object
  // this call created. A name that was already there is never ours.
  let created = false
  for (let n = 0; n < SCRATCH_ATTEMPTS; n += 1) {
    // THE NAME IS GENERATED INSIDE A HANDLER OF ITS OWN.
    //
    // K8-B1.2 evaluated this expression BEFORE the per-attempt `try`, and the
    // outer handler only starts once a descriptor exists, so a throw from
    // `ops.randomBytes` left the function as the raw error - an OS message and a
    // syscall name escaping a function whose refusals are supposed to be bounded.
    // The K8-B1.2 report claimed this case was classified. It was not.
    //
    // IT IS NOT A COLLISION, SO IT IS NOT RETRIED. Without an unpredictable name
    // there is nothing to retry with, and no `openSync` runs on this attempt or
    // any later one. An entry an earlier EEXIST attempt bumped into is not ours
    // and is not touched.
    let candidate: string
    try {
      candidate = join(directory, `.pgpass-scratch-${ops.randomBytes(16).toString('hex')}`)
    } catch {
      // THE ORIGINAL IS DISCARDED, NOT WRAPPED AND NOT ATTACHED AS `cause`.
      throw new TargetIdentityRefused(
        'no unpredictable scratch name could be generated and no scratch file was created')
    }
    try {
      opened = ops.openSync(candidate, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0o600)
      candidateUsed = candidate
      created = true
      break
    } catch (e) {
      // ONLY A COLLISION IS RETRIED.
      //
      // K8-B1: every open failure was retried as though it were EEXIST, so
      // EACCES, ENOSPC, EIO or ELOOP burned the whole attempt budget and then
      // reported a collision that never happened. A non-collision failure is a
      // refusal now, on the first attempt, and the reason carries no path and no
      // OS message - only the reviewed vocabulary.
      if ((e as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
        throw new TargetIdentityRefused('the scratch descriptor could not be created')
      }
      opened = null
    }
  }
  if (opened === null || candidateUsed === null || !created) {
    throw new TargetIdentityRefused('no scratch descriptor could be created')
  }
  const fd = opened
  const scratch = candidateUsed

  // EXACTLY ONE CLOSE PER OWNED DESCRIPTOR, ON EVERY PATH. K8-B1's unlink
  // failure branch closed the fd and then threw into a catch that closed it
  // again; a second close of a reused number is a close of somebody else's file.
  let closed = false
  const closeOwned = (): void => {
    if (closed) return
    closed = true
    try { ops.closeSync(fd) } catch { /* already gone */ }
  }

  // DOES THE NAME STILL DENOTE THE RECEIPT'S OBJECT? `lstat` does not follow a
  // symlink, so a name replaced by a link fails this rather than redirecting it.
  // Device and inode are both required, and the rest of the shape with them.
  //
  // THIS IS A NARROWING, NOT A GUARANTEE. The answer is true of the moment it was
  // taken. A same-uid rename landing between this call and the `unlink` that
  // follows it would still be removed, and nothing available here can prevent
  // that. What it does rule out is the far wider case this function got wrong:
  // unlinking a name on the strength of a descriptor that cannot see the name.
  const pathnameIs = (r: Stats): boolean => {
    try {
      const l = ops.lstatSync(scratch)
      return l.isFile() === r.isFile() && l.dev === r.dev && l.ino === r.ino &&
        l.nlink === r.nlink && (l.mode & 0o777) === (r.mode & 0o777) && l.uid === r.uid
    } catch {
      // MISSING, UNREADABLE OR UNPROVED IS NOT A MATCH.
      return false
    }
  }

  // THE DESCRIPTOR, RE-READ against the receipt. Link count is deliberately NOT
  // compared here: it is 1 before the unlink and must be 0 after it, so each
  // caller states the count it requires. This is never pathname proof.
  const descriptorIs = (r: Stats): Stats | null => {
    try {
      const a = ops.fstatSync(fd)
      return a.isFile() === r.isFile() && a.dev === r.dev && a.ino === r.ino &&
        (a.mode & 0o777) === (r.mode & 0o777) && a.uid === r.uid ? a : null
    } catch {
      return null
    }
  }

  let unlinked = false
  const unlinkOwned = (): boolean => {
    if (unlinked) return true
    try {
      ops.unlinkSync(scratch)
      unlinked = true
    } catch {
      unlinked = false
    }
    return unlinked
  }

  try {
    // NO RECEIPT MEANS NO AUTHORITY TO REMOVE A NAME.
    //
    // K8-B1 closed the descriptor here and the report claimed the scratch entry
    // was cleaned up. It was not, and it must not be: nothing had established
    // which object the name denoted, so unlinking it could remove a replacement
    // this call never created. Zero bytes are written, the fd is closed once by
    // the handler below, the empty 0600 name is left, and the reason says so.
    let receipt: Stats
    try {
      receipt = ops.fstatSync(fd)
    } catch {
      throw new TargetIdentityRefused(
        'the scratch descriptor could not be identified and an empty scratch file may be retained')
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    if (!receipt.isFile() || receipt.nlink !== 1 || (receipt.mode & 0o777) !== 0o600 ||
        (uid !== -1 && receipt.uid !== uid)) {
      // IDENTIFIED BUT INVALID. The receipt exists, so the name CAN be compared
      // against it - and only an exact match is removed. Anything else is a
      // possible replacement and is left exactly where it is.
      const gone = pathnameIs(receipt) ? unlinkOwned() : false
      // REMOVING OUR NAME IS NOT CLEANUP WHEN THE OBJECT HAD TWO.
      //
      // A receipt with `nlink !== 1` says some other name already held this
      // object when we looked. THIS CALL DID CREATE THE OBJECT - the `O_EXCL`
      // open above succeeded - so what it never created is the OTHER NAME.
      // Unlinking ours leaves that name still holding this empty object, and we
      // neither look for it nor touch it.
      const alsoNamedElsewhere = receipt.nlink !== 1
      throw new TargetIdentityRefused(
        !gone
          ? 'the scratch descriptor is not a private regular file and an empty scratch file may be retained'
          : alsoNamedElsewhere
            ? 'the scratch descriptor is not a private regular file and another name may still retain an empty scratch file'
            : 'the scratch descriptor is not a private regular file')
    }
    // THE PATHNAME RECEIPT, BEFORE THE FIRST UNLINK - not only before a retry.
    if (!pathnameIs(receipt)) {
      throw new TargetIdentityRefused(
        'the scratch pathname is not the created object and was not unlinked')
    }
    if (!unlinkOwned()) {
      // ZERO SECRET BYTES WRITTEN. At most one retry, and only if BOTH sides
      // re-prove independently: the open descriptor against the receipt, and the
      // name against that same receipt. A second `fstat(fd)` alone would authorize
      // removing whatever now answers to the name.
      const d = descriptorIs(receipt)
      const held = d !== null && d.nlink === receipt.nlink && pathnameIs(receipt)
      if (!held || !unlinkOwned()) {
        throw new TargetIdentityRefused(held
          ? 'the scratch entry could not be unlinked and an empty scratch file is retained'
          : 'the scratch pathname could not be re-proved and an empty scratch file may be retained or substituted')
      }
    }
    // ANONYMITY, PROVED - BEFORE THE FIRST SECRET BYTE.
    const after = descriptorIs(receipt)
    if (after === null || after.nlink !== 0) {
      // A LINK SOMEWHERE ELSE STILL NAMES THIS OBJECT. We do not know that name
      // and will not go looking for it; we write nothing into it.
      throw new TargetIdentityRefused(
        'the scratch descriptor is not anonymous and no bytes were written')
    }
    // POSITIONAL WRITES FROM 0, SHORT WRITES COMPLETED EXPLICITLY.
    const bytes = Buffer.from(record, 'utf-8')
    try {
      let off = 0
      while (off < bytes.length) {
        let n: number
        try {
          n = ops.writeSync(fd, bytes, off, bytes.length - off, off)
        } catch {
          // THE ORIGINAL ERROR IS DISCARDED, NOT WRAPPED.
          //
          // K8-B1.1 let the raw throw through, so a real Node failure left
          // `ENOSPC: no space left on device, write` as this module's reason -
          // an OS message, a syscall name and an errno in a refusal that the
          // reviewed vocabulary was supposed to bound. Nothing is attached as
          // `cause` either: a cause is the same leak one property along.
          throw new TargetIdentityRefused('the scratch write failed and no named file remains')
        }
        if (n <= 0) throw new TargetIdentityRefused('the scratch write did not progress')
        off += n
      }
      try {
        ops.fsyncSync(fd)
      } catch {
        throw new TargetIdentityRefused('the scratch fsync failed and no named file remains')
      }
    } finally {
      // THE ONE COPY WE OWN. A Buffer is mutable, so this is a real erase of
      // this process's copy - no claim is made about the immutable string the
      // record arrived as.
      bytes.fill(0)
    }
    return fd
  } catch (e) {
    // EVERY OWNED DESCRIPTOR IS CLOSED EXACTLY ONCE, HERE AND NOWHERE ELSE. On
    // the write and fsync paths the name is already gone, so there is nothing
    // left to remove; on the earlier paths the refusal already said what remains.
    closeOwned()
    throw e
  }
}

/**
 * The reviewed target identity session: one credential, one record, one fd.
 *
 * `psql` itself reads the descriptor, which is unavoidable and correct - that is
 * what PGPASSFILE exists for. The bytes never reach argv or an environment.
 */
export async function openTargetIdentitySession(
  i: {
    credentialPath: string
    expected: TargetEndpointExpectation
    psqlPath: string
  },
  ops: TargetIdentityOps = REAL_TARGET_IDENTITY_OPS,
): Promise<{
  pid: string
  send: (sql: string) => Promise<SqlResult>
  rows: (sql: string) => Promise<string[][]>
  close: () => Promise<void>
  alive: () => boolean
}> {
  const parsed = provedTargetCredential(i.credentialPath, i.expected, ops)
  const fd = anonymousPassfileFd(dirname(i.credentialPath), pgpassRecordFor(parsed), ops)
  try {
    const backend = await ops.openBackend({
      psqlPath: i.psqlPath,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      // THE USER COMES FROM THE CREDENTIAL, not from argv. There is no
      // `--target-user` to disagree with it any more.
      user: parsed.user,
      passfileFd: fd,
    })
    return {
      pid: backend.pid,
      send: async (sql: string) => await backend.send(sql),
      rows: async (sql: string) => await backend.rows(sql),
      close: async () => { await backend.close() },
      alive: () => backend.alive(),
    }
  } finally {
    // CLOSED ONLY AFTER SPAWN HAS DUPLICATED IT - `openPsqlBackend` has already
    // returned or thrown by here, and Node dups into the child during `spawn`.
    try { ops.closeSync(fd) } catch { /* the child holds its own copy */ }
  }
}
