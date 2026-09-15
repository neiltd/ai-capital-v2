// THE CREDENTIAL FILE IS DATA. IT IS NEVER SHELL CODE.
//
// The pipeline credential reaches a launchd job as the PATH of a file, not as a
// value: the plist is credential-free, `launchctl print` has nothing to show,
// and rotation touches one file rather than three agents. That only holds if
// reading the file is a read — not a `source`, not a dotenv parse, not any step
// that could interpret its contents.
//
// So the format is deliberately not a format:
//
//   * exactly one PostgreSQL URL;
//   * one optional terminating LF, treated as FRAMING and removed as framing;
//   * no CR, no NUL, no second LF, no second line, nothing over 4 KiB;
//   * NO trimming — surrounding whitespace is a defect in the credential and is
//     refused downstream by requireExplicitPostgresUrl, not silently repaired;
//   * no KEY=value, no quoting, no expansion, no comments.
//
// `ANTHROPIC_API_KEY=postgres://…` is therefore not a credential file with a
// key, it is a malformed URL, and it fails.
//
// WHAT THE FILE CHECKS BUY, EXACTLY.
// Every property is asserted on the OPEN DESCRIPTOR rather than on the path,
// because a path can be replaced between looking at it and reading it. fstat on
// the fd answers "what am I actually about to read", which is the only question
// that matters.
//
// ANCESTOR SYMLINKS — THE LIMIT IS STATED, NOT GLOSSED.
// Node exposes no openat(2), so a component-by-component O_NOFOLLOW walk cannot
// be written directly. Instead realpath is compared with the supplied path, and
// the final open uses O_NOFOLLOW. The guarantee is therefore:
//
//   no component was a symlink AT THE TIME OF THE realpath CHECK; the final
//   component was not a symlink AT OPEN TIME; and the bytes come from the
//   object that passed fstat.
//
// NOT covered: an ancestor DIRECTORY swapped between the realpath check and the
// open. That requires an attacker who already controls the account, and the
// mandatory 0700 owner-only parent is the mitigation. This limitation is
// deliberate and tested as written rather than claimed away.
//
// O_CLOEXEC IS NOT USED, because Node does not define it on this platform
// (fs.constants.O_CLOEXEC is undefined on macOS/Node 26). Descriptor hygiene is
// achieved by closing in a `finally` before any dynamic import or spawn, and by
// explicit `stdio` on every child. No close-on-exec claim is made.

import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'fs'
import { dirname, isAbsolute } from 'path'

/** Anything larger is not a credential; it is a mistake or an attack. */
export const MAX_CREDENTIAL_FILE_BYTES = 4096

/**
 * The filesystem calls this module makes. Injected so the security branches —
 * foreign owner, group-readable mode, extra hard link — can be exercised on a
 * runner that cannot create such files. The default is the real `fs`, and a
 * non-vacuity control asserts that.
 */
export interface CredentialFileSeam {
  realpathSync: (p: string) => string
  openSync: (p: string, flags: number) => number
  fstatSync: (fd: number) => { isFile(): boolean; isDirectory(): boolean; uid: number; mode: number; nlink: number; size: number }
  lstatSync: (p: string) => { isSymbolicLink(): boolean }
  readSync: (fd: number, buf: Uint8Array, offset: number, length: number, position: number | null) => number
  closeSync: (fd: number) => void
  currentUid: () => number
}

export const defaultCredentialFileSeam: CredentialFileSeam = {
  realpathSync,
  openSync: (p, flags) => openSync(p, flags),
  fstatSync,
  lstatSync,
  readSync,
  closeSync,
  // process.getuid is absent on Windows; this tool is macOS-only, and a missing
  // uid must fail the ownership check rather than skip it.
  currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
}

/** A read count from an injected seam is validated rather than believed. */
export function checkReadCount(path: string, n: unknown, remaining: number): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) refuse(path, 'produced a non-integer read count.')
  if (n < 0) refuse(path, 'produced a negative read count.')
  if (n > remaining) refuse(path, `produced a read count of ${n}, more than the ${remaining} bytes requested.`)
  return n
}

/**
 * The directory holding a credential must be owner-only, or the file's own mode
 * is not worth much: anyone who can write the directory can replace the file.
 */
export function assertCredentialDirectory(dir: string, seam: CredentialFileSeam = defaultCredentialFileSeam): void {
  // lstat first: stat would follow a symlinked directory and describe its target.
  try {
    if (seam.lstatSync(dir).isSymbolicLink()) refuse(dir, 'is a symbolic link.')
  } catch (e) {
    if (e instanceof Error && e.message.includes('@common/queue')) throw e
    refuse(dir, `could not be inspected (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}).`)
  }

  let fd: number
  try {
    fd = seam.openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ELOOP') refuse(dir, 'is a symbolic link.')
    refuse(dir, `could not be opened as a directory (${code ?? 'unknown error'}).`)
  }
  try {
    const st = seam.fstatSync(fd)
    if (!st.isDirectory()) refuse(dir, 'is not a directory.')
    const uid = seam.currentUid()
    if (uid < 0) refuse(dir, 'cannot be ownership-checked on this platform.')
    if (st.uid !== uid) refuse(dir, 'is owned by another user.')
    if ((st.mode & 0o077) !== 0) refuse(dir, 'must be owner-only (mode 0700).')
  } finally {
    try { seam.closeSync(fd) } catch { /* already closed */ }
  }
}

function refuse(path: string, why: string): never {
  // The path is operator-supplied configuration, not a secret, so naming it is
  // what makes the error actionable. The CONTENTS are never named.
  throw new Error(`@common/queue: credential file ${path} ${why}`)
}

/**
 * Read one credential file and return its single URL, byte-for-byte.
 *
 * Performs no URL validation: that is requireExplicitPostgresUrl's job, and
 * duplicating it here would create a second set of rules to drift.
 */
export function readCredentialFile(
  path: string,
  seam: CredentialFileSeam = defaultCredentialFileSeam,
): string {
  if (!isAbsolute(path)) {
    refuse(path, 'must be an absolute path; a relative path resolves against a working directory this process does not control.')
  }

  // See the header: this rejects a symlinked ANCESTOR at check time. The final
  // component is covered by O_NOFOLLOW below.
  let resolved: string
  try {
    resolved = seam.realpathSync(path)
  } catch {
    refuse(path, 'could not be resolved (it may not exist).')
  }
  if (resolved !== path) {
    refuse(path, 'resolves through a symbolic link; supply the real path instead.')
  }

  // THE CONTAINING DIRECTORY IS CHECKED TOO, on a descriptor.
  //
  // Round 1 documented a directory contract and then never enforced one, which
  // is worse than having none: a 0755 directory lets anyone replace the file
  // between one read and the next, and the file's own mode says nothing about
  // that. O_DIRECTORY|O_NOFOLLOW refuses a symlinked final directory component,
  // and the fstat that follows describes the object actually opened.
  assertCredentialDirectory(dirname(path), seam)

  // O_NOFOLLOW makes a symlink AT the final component fail with ELOOP rather
  // than silently reading whatever it points at.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW
  let fd: number
  try {
    fd = seam.openSync(path, flags)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ELOOP') refuse(path, 'is a symbolic link.')
    refuse(path, `could not be opened (${code ?? 'unknown error'}).`)
  }

  try {
    const st = seam.fstatSync(fd)

    if (!st.isFile()) refuse(path, 'is not a regular file.')

    const uid = seam.currentUid()
    if (uid < 0) refuse(path, 'cannot be ownership-checked on this platform.')
    if (st.uid !== uid) refuse(path, 'is owned by another user.')

    // OWNER-ONLY, which is exactly what is checked: no group or other bit may be
    // set. 0600 is what the installer writes; 0400 is deliberately also accepted
    // because a read-only credential is strictly safer, and the error says
    // "owner-only" rather than naming a single mode it does not actually require.
    if ((st.mode & 0o077) !== 0) refuse(path, 'is readable or writable beyond its owner; it must be owner-only (0600, or 0400).')

    // A second hard link is a second name for the same bytes, outside the
    // directory whose permissions were just verified.
    if (st.nlink !== 1) refuse(path, 'has more than one hard link.')

    if (st.size > MAX_CREDENTIAL_FILE_BYTES) {
      refuse(path, `is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes; it should contain one URL.`)
    }

    // Complete-read loop. A single readSync may return fewer bytes than asked,
    // and an injected seam may return nonsense — a count is validated, not
    // trusted: integer, non-negative, and never more than was requested.
    const buf = new Uint8Array(MAX_CREDENTIAL_FILE_BYTES + 1)
    let total = 0
    for (;;) {
      const remaining = buf.length - total
      const n = checkReadCount(path, seam.readSync(fd, buf, total, remaining, null), remaining)
      if (n === 0) break
      total += n
      if (total > MAX_CREDENTIAL_FILE_BYTES) {
        refuse(path, `is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes; it should contain one URL.`)
      }
    }

    return decodeCredentialBytes(path, buf.subarray(0, total))
  } finally {
    // BEFORE any dynamic import or child spawn — the caller does neither until
    // this function has returned.
    try { seam.closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Apply the framing rules to the raw bytes and return the URL.
 *
 * Exported for tests: the byte-level cases (CRLF, NUL, double LF) are about
 * these rules, not about the filesystem.
 */
export function decodeCredentialBytes(path: string, bytes: Uint8Array): string {
  if (bytes.length === 0) refuse(path, 'is empty.')

  let end = bytes.length
  // ONE terminating LF is framing. A second one is a second line.
  if (bytes[end - 1] === 0x0a) end -= 1

  const body = bytes.subarray(0, end)
  for (const b of body) {
    if (b === 0x00) refuse(path, 'contains a NUL byte.')
    if (b === 0x0a) refuse(path, 'contains more than one line.')
    if (b === 0x0d) refuse(path, 'contains a carriage return; it must use LF framing only.')
  }
  if (body.length === 0) refuse(path, 'contains no credential.')

  // FATAL DECODING. Buffer.toString('utf-8') silently replaces malformed bytes
  // with U+FFFD, so a corrupted credential would become a different, valid-looking
  // string and fail somewhere far away. TextDecoder with fatal:true throws instead.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    refuse(path, 'is not valid UTF-8.')
  }

  // No trimming, by design. Surrounding whitespace is refused by the canonical
  // validator so that the value validated is the value used.
}
