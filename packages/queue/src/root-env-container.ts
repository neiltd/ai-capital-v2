// THE ROOT .env IS A SECRET CONTAINER, AND IS READ LIKE ONE.
//
// WHAT WAS WRONG WITH READING IT AS A FILE. `loadApprovedRootEnv` opened the root
// `.env` with `readFileSync(path)`. That is a read of a NAME, not of an object:
// the path may be a symlink pointing anywhere, its mode and owner were never
// examined, and nothing established that the bytes came from the file whose
// properties were checked — because none were. The file holds two API keys and,
// on other machines, database credentials; `credential-file.ts` already treats a
// credential path with descriptor-first discipline, and there is no argument for
// holding this one to a weaker standard.
//
// SO EVERY PROPERTY IS ASSERTED ON THE OPEN DESCRIPTOR. `O_NOFOLLOW` makes a
// symlink at the final component fail rather than silently redirect the read;
// `fstat` on the returned fd answers "what am I actually about to read"; and the
// bytes are read from that same fd, which is closed on every path including the
// refusal paths.
//
// THE LIMIT IS STATED RATHER THAN GLOSSED, exactly as in `credential-file.ts`:
// Node exposes no `openat(2)`, so an ancestor DIRECTORY swapped between the
// check and the open is not covered. That requires an attacker who already owns
// the account.
//
// ENOENT REMAINS A NO-OP, which is a deliberate difference from a credential
// file. A machine where every value arrives from launchd has no root `.env`, and
// that is a legitimate state. What must NOT be silent is a `.env` that exists and
// cannot be trusted: wrong owner, group-readable, a symlink, a second hard link,
// an I/O error. Each of those throws, naming the path and never the contents.
//
// THE CONTENTS ARE NEVER REPORTED — not in an error, not a length, not a prefix,
// not a digest. A refusal names the path and the property that failed.

import { constants, closeSync, fstatSync, openSync, readSync } from 'fs'
import { isAbsolute } from 'path'

/** Anything larger is not a configuration file for this purpose. */
export const MAX_ROOT_ENV_BYTES = 64 * 1024

/**
 * The filesystem calls this module makes. Injected so the branches a test runner
 * cannot create — a foreign owner, a second hard link — can still be exercised.
 * The default is the real `fs`, and a non-vacuity control asserts that.
 */
export interface RootEnvSeam {
  openSync: (p: string, flags: number) => number
  fstatSync: (fd: number) => {
    isFile(): boolean; uid: number; mode: number; nlink: number; size: number
  }
  readSync: (fd: number, buf: Uint8Array, offset: number, length: number,
             position: number | null) => number
  closeSync: (fd: number) => void
  currentUid: () => number
}

export const defaultRootEnvSeam: RootEnvSeam = {
  openSync: (p, flags) => openSync(p, flags),
  fstatSync,
  readSync,
  closeSync,
  // process.getuid is absent on Windows; this tool is macOS-only, and a missing
  // uid must fail the ownership check rather than skip it.
  currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
}

export class RootEnvRefused extends Error {}

function refuse(path: string, why: string): never {
  // The path is operator-supplied configuration, not a secret. The CONTENTS are
  // never named, measured or digested.
  throw new RootEnvRefused(`@common/queue: root env file ${path} ${why}`)
}

/** A read count from an injected seam is validated rather than believed. */
function checkedCount(path: string, n: unknown, remaining: number): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) refuse(path, 'produced a non-integer read count.')
  if (n < 0) refuse(path, 'produced a negative read count.')
  if (n > remaining) refuse(path, `produced a read count of ${n}, more than the ${remaining} bytes requested.`)
  return n
}

/**
 * Read the root `.env` from a validated descriptor, or return null if absent.
 *
 * Returns the raw text. Parsing, allowlisting and assignment are the caller's
 * job; this function's only responsibility is that the bytes came from an object
 * this process may trust.
 */
export function readRootEnvContainer(
  path: string,
  seam: RootEnvSeam = defaultRootEnvSeam,
): string | null {
  if (!isAbsolute(path)) {
    refuse(path, 'must be an absolute path; a relative path resolves against a working directory this process does not control.')
  }

  // O_NOFOLLOW makes a symlink AT the final component fail with ELOOP rather
  // than silently reading whatever it points at.
  let fd: number
  try {
    fd = seam.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // THE ONE SILENT CASE, and only this one.
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') refuse(path, 'is a symbolic link.')
    refuse(path, `could not be opened (${code ?? 'unknown error'}).`)
  }

  try {
    const st = seam.fstatSync(fd)

    if (!st.isFile()) refuse(path, 'is not a regular file.')

    const uid = seam.currentUid()
    if (uid < 0) refuse(path, 'cannot be ownership-checked on this platform.')
    if (st.uid !== uid) refuse(path, 'is owned by another user.')

    // EXACTLY 0600. The reviewed installation writes that mode, and this file is
    // read by processes that must not inherit a wider one. A narrower 0400 is
    // refused too, deliberately: it would mean the file cannot be rotated in
    // place by the tooling that owns it, which is a configuration problem worth
    // surfacing rather than tolerating.
    if ((st.mode & 0o777) !== 0o600) refuse(path, 'must be mode 0600.')

    // A second hard link is a second name for the same bytes, outside whatever
    // directory permissions were arranged for this one.
    if (st.nlink !== 1) refuse(path, 'has more than one hard link.')

    if (st.size > MAX_ROOT_ENV_BYTES) {
      refuse(path, `is larger than ${MAX_ROOT_ENV_BYTES} bytes.`)
    }

    // Complete-read loop. A single readSync may return fewer bytes than asked,
    // and an injected seam may return nonsense.
    const buf = new Uint8Array(MAX_ROOT_ENV_BYTES + 1)
    let total = 0
    for (;;) {
      const remaining = buf.length - total
      const n = checkedCount(path, seam.readSync(fd, buf, total, remaining, null), remaining)
      if (n === 0) break
      total += n
      if (total > MAX_ROOT_ENV_BYTES) refuse(path, `is larger than ${MAX_ROOT_ENV_BYTES} bytes.`)
    }

    // FATAL DECODING. `fatal: true` throws on malformed bytes rather than
    // substituting U+FFFD, which would turn a corrupted file into a different,
    // valid-looking one that fails somewhere far away.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, total))
    } catch {
      refuse(path, 'is not valid UTF-8.')
    }
    return text
  } finally {
    // ON EVERY PATH, including each refusal above.
    try { seam.closeSync(fd) } catch { /* already closed */ }
  }
}
