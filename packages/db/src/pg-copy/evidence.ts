// IMMUTABLE EVIDENCE — the reusable publisher for anything this copy proves.
//
// WHAT THIS IS FOR. A manifest is a claim about a moment. If the directory
// holding it can be edited afterwards, the claim is worth exactly as much as
// the last person to touch it, and nobody can tell whether anyone did. This
// module publishes a directory that is complete before it is visible, frozen
// before it is published, and self-describing enough that tampering with it
// afterwards is detectable.
//
// THE SHAPE OF THE GUARANTEE, AND ITS HONEST LIMIT.
//
//   COMPLETE BEFORE VISIBLE. Everything is built under a temporary name in the
//   SAME parent and moved into place with ONE rename. A reader never sees a
//   partial bundle, because the final name does not exist until the bundle is
//   finished. A failure before that point leaves the temporary directory and
//   NO final path at all - the absence of the final name IS the failure signal.
//
//   FROZEN BEFORE PUBLISHED, WITH ONE MEASURED EXCEPTION. Every file goes to
//   0400 and every nested directory to 0500 while still under the temporary
//   name, so a published bundle's contents are read-only at the instant they
//   become reachable. The bundle ROOT is the exception: rename(2) on a
//   directory needs write permission on the directory being moved, and
//   macOS/APFS enforces that even within one parent - freezing the root first
//   makes the publication itself fail with EACCES, which was measured rather
//   than assumed. So the root is frozen in the step immediately after the
//   rename. The window is exactly that: one chmod call during which the
//   published directory is 0700, owner-only, already full of 0400 files and
//   0500 subdirectories. It is stated here rather than glossed, because a
//   guarantee with an undocumented exception is worse than a smaller one.
//
//   THE LIMIT, STATED PLAINLY. 0400/0500 stops accidental writes and stops
//   every non-owner without an override. It does NOT stop the owner: the owner
//   can chmod the tree back and rewrite anything in it, and root ignores the
//   modes entirely. This is not defence against a determined owner and must
//   never be described as one. What makes tampering DETECTABLE is DIGEST -
//   every regular file, hashed, in deterministic order. Anyone can re-run the
//   verification and see that the bytes no longer match. Immutability here
//   means "cannot drift by accident, cannot change without evidence", not
//   "cannot be changed".
//
//   DIGEST IS WRITTEN LAST AND COVERS EVERYTHING ELSE. It cannot cover itself,
//   so it is the one file the digest does not describe; it is also the last
//   byte written, so its presence means every other artifact was already on
//   disk. A bundle whose DIGEST is missing was never finished.
//
// NOTHING HERE KNOWS WHAT A MANIFEST IS. The publisher takes artifacts as
// bytes and one designated document that must carry a completion marker. Any
// later stage that needs an immutable bundle uses this one rather than growing
// a second publisher with its own subtly different rules.

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { atomicRenameNoReplace, type AtomicRenameOutcome } from './atomic-rename.js'

/** The one file that describes every other file, and is written last. */
export const DIGEST_FILE = 'DIGEST'

/** The reviewed mode for a directory under construction, and when frozen. */
export const BUILD_DIR_MODE = 0o700
export const FROZEN_DIR_MODE = 0o500
/** The reviewed mode for a file under construction, and when frozen. */
export const BUILD_FILE_MODE = 0o600
export const FROZEN_FILE_MODE = 0o400

/** The evidence root itself, which this module requires and never creates. */
export const REQUIRED_ROOT_MODE = 0o700

/** Where a refusal happened. Fixed set; never a free-form location. */
export type EvidencePhase =
  | 'root'
  | 'name'
  | 'collision'
  | 'construct'
  | 'manifest'
  | 'digest'
  | 'freeze'
  | 'fsync'
  | 'publish'
  /**
   * Standalone verification of a bundle that already exists.
   *
   * Reachable two ways, which mean different things: an operator re-checking a
   * published bundle weeks later gets an `EvidenceRefused` with this phase,
   * while the same failure DURING a publication is re-raised as
   * `EvidencePublishedButUnverified`, because there the bundle is one this run
   * just created.
   */
  | 'verify'

/**
 * The phases that can only be reached AFTER the atomic rename has succeeded.
 *
 * Kept as a separate type because the difference is not cosmetic: before the
 * rename there is provably no bundle at the final name, and after it there
 * provably is one. A caller that cannot tell those apart will either delete
 * evidence it should have kept or tell an operator nothing was published when
 * something was.
 */
export type PublishedPhase =
  | 'freeze-final'
  | 'fsync-final'
  | 'fsync-parent'
  | 'verify'

/**
 * WHY a refusal happened. A CLOSED union of reviewed sentences.
 *
 * The alternative - interpolating an `errno`, a path the caller supplied, or a
 * directory listing - is how filesystem content reaches a log. Every message
 * this module can emit is written out here and can be read in full without
 * running anything.
 */
export type EvidenceReason =
  | 'the evidence root is not an existing directory'
  | 'the evidence root is a symbolic link'
  | 'the evidence root is not owned by this process'
  | 'the evidence root is not mode 0700'
  | 'the run identifier is not eight lowercase hexadecimal characters'
  | 'the timestamp is not a basic-format UTC instant'
  | 'the prefix is not a reviewed evidence prefix'
  | 'a path is already present at the publication destination'
  | 'a path is already present at the temporary directory'
  | 'no artifact was supplied'
  | 'an artifact path is not a bounded relative path'
  | 'an artifact path is supplied more than once'
  | 'the digest file may not be supplied as an artifact'
  | 'the manifest document does not carry the completion marker'
  | 'a filesystem operation did not complete'
  | 'a published entry is not the type, mode or link count it was frozen at'
  | 'the published digest does not describe the published bytes'
  | 'the published bundle carries no digest file'
  | 'a path could not be examined'
  | 'this platform offers no atomic no-replace publication'

/**
 * A refusal. Carries the phase, the reviewed reason and, at most, a RELATIVE
 * artifact path that the caller itself supplied.
 *
 * No absolute path, no `errno`, no underlying error, no file content. An
 * evidence publisher that failed is going to have its error logged by whoever
 * called it, and the directory it was writing into is the one place operators
 * put things they do not want in logs.
 */
export class EvidenceRefused extends Error {
  constructor(
    readonly phase: EvidencePhase,
    readonly reason: EvidenceReason,
    readonly relativePath: string | null = null,
  ) {
    super(`${reason} (phase ${phase}${relativePath === null ? '' : ` at ${relativePath}`})`)
    this.name = 'EvidenceRefused'
  }
}

/**
 * A failure AFTER the bundle was published. The bundle EXISTS.
 *
 * Distinct from `EvidenceRefused` because the two demand opposite responses. A
 * refusal means nothing reached the final name and a retry is safe. This means
 * the final name is taken, by a bundle that may be unfrozen, unsynced or
 * unverified - and it must be preserved exactly as it is, for a human to look
 * at. Nothing here deletes, overwrites, reuses or repairs it, and a later run
 * will refuse that name rather than tidy it away.
 *
 * It carries the two reviewed NAMES, not absolute paths: the operator supplied
 * the root, so a name is enough to find the bundle, and an absolute path in an
 * error is one more thing that travels into a log.
 */
export class EvidencePublishedButUnverified extends Error {
  constructor(
    readonly phase: PublishedPhase,
    readonly reason: EvidenceReason,
    readonly publishedName: string,
    readonly temporaryName: string,
  ) {
    super(
      `the bundle was published but could not be completed or verified during ` +
      `"${phase}": ${reason}. It has NOT been removed. ` +
      `published=${publishedName} temporary=${temporaryName}`)
    this.name = 'EvidencePublishedButUnverified'
  }
}

/**
 * The filesystem operations publication performs, as one injectable seam.
 *
 * Same reasoning as the credential publisher's `PublishOps`: every branch after
 * a successful write is a branch that only fires when the filesystem
 * misbehaves, and no test can make a real `fsync` fail on demand. The default
 * is the real `node:fs` and nothing but a test ever passes anything else.
 */
export interface EvidenceOps {
  lstatSync: typeof lstatSync
  mkdirSync: typeof mkdirSync
  openSync: typeof openSync
  writeSync: typeof writeSync
  fsyncSync: typeof fsyncSync
  fstatSync: typeof fstatSync
  closeSync: typeof closeSync
  chmodSync: typeof chmodSync
  /**
   * ATOMIC NO-REPLACE publication. NOT `renameSync`.
   *
   * The seam names the guarantee rather than the syscall, so a change that
   * swapped in an overwrite-capable primitive would have to say so here.
   */
  renameNoReplace: (from: string, to: string) => AtomicRenameOutcome
  readdirSync: typeof readdirSync
  readFileSync: typeof readFileSync
}

export const REAL_EVIDENCE_OPS: EvidenceOps = {
  lstatSync, mkdirSync, openSync, writeSync, fsyncSync, fstatSync, closeSync,
  chmodSync, renameNoReplace: atomicRenameNoReplace, readdirSync, readFileSync,
}

// ---------------------------------------------------------------------------
// NAMES
// ---------------------------------------------------------------------------

/** The only prefixes this repository publishes evidence under. */
export const REVIEWED_PREFIXES: readonly string[] = Object.freeze(['source-manifest'])

const RUN_ID = /^[0-9a-f]{8}$/
const STAMP = /^\d{8}T\d{6}Z$/
/**
 * A bounded relative artifact path: reviewed characters only, no absolute
 * form, no `.` or `..` segment, no empty segment, bounded depth and length.
 *
 * Refused rather than normalised. A path that needs normalising is a path
 * whose author and whose reader disagree about where it points, and this
 * module writes files for a living.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SEGMENTS = 4
const MAX_PATH_CHARS = 120

export function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new EvidenceRefused(
      'name', 'the run identifier is not eight lowercase hexadecimal characters')
  }
  return runId
}

/** A fresh run identifier: 32 bits, lowercase hex, never derived from time. */
export function newRunId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * `YYYYMMDDTHHMMSSZ` from an instant, in UTC.
 *
 * Derived from the ISO form rather than from local `getMonth()`-style
 * accessors, because those read the HOST timezone and would make the published
 * name a fact about the machine that generated it.
 */
export function evidenceStamp(when: Date): string {
  const iso = new Date(when.getTime()).toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T` +
                `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  if (!STAMP.test(stamp)) {
    throw new EvidenceRefused('name', 'the timestamp is not a basic-format UTC instant')
  }
  return stamp
}

export interface EvidenceNames {
  /** `<prefix>-<stamp>-<runId>`, the name the bundle is published under. */
  readonly finalName: string
  /** `.tmp-<runId>`, the name it is built under, in the SAME parent. */
  readonly temporaryName: string
}

/**
 * The two names, derived from ONE run identifier.
 *
 * The temporary name carries the same identifier as the final one, so a
 * retained temporary directory can be matched to the run that abandoned it
 * without reading anything inside it.
 */
export function evidenceNames(prefix: string, stamp: string, runId: string): EvidenceNames {
  if (!REVIEWED_PREFIXES.includes(prefix)) {
    throw new EvidenceRefused('name', 'the prefix is not a reviewed evidence prefix')
  }
  if (!STAMP.test(stamp)) {
    throw new EvidenceRefused('name', 'the timestamp is not a basic-format UTC instant')
  }
  assertRunId(runId)
  return Object.freeze({
    finalName: `${prefix}-${stamp}-${runId}`,
    temporaryName: `.tmp-${runId}`,
  })
}

// ---------------------------------------------------------------------------
// ROOT
// ---------------------------------------------------------------------------

/**
 * The evidence root must already exist, correctly, and this never creates it.
 *
 * Creating it would mean a typo in the root path silently produces a brand-new
 * directory with no history and a bundle nobody will find. `lstat`, never
 * `stat`: a symlinked root would publish the bundle wherever the link points.
 */
export function assertEvidenceRoot(root: string, ops: EvidenceOps = REAL_EVIDENCE_OPS): string {
  const st = (() => {
    try {
      return ops.lstatSync(root)
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
      throw new EvidenceRefused('root', 'a path could not be examined')
    }
  })()
  if (st === null) {
    throw new EvidenceRefused('root', 'the evidence root is not an existing directory')
  }
  if (st.isSymbolicLink()) {
    throw new EvidenceRefused('root', 'the evidence root is a symbolic link')
  }
  if (!st.isDirectory()) {
    throw new EvidenceRefused('root', 'the evidence root is not an existing directory')
  }
  if (st.uid !== process.getuid?.()) {
    throw new EvidenceRefused('root', 'the evidence root is not owned by this process')
  }
  if ((st.mode & 0o777) !== REQUIRED_ROOT_MODE) {
    throw new EvidenceRefused('root', 'the evidence root is not mode 0700')
  }
  return resolve(root)
}

/**
 * PRESENT under `-e or -L` semantics: a dangling symlink counts as present.
 *
 * `existsSync` follows the link and reports false for a dangling one, which is
 * precisely the case that must refuse - publishing onto it would write through
 * the link to wherever it points.
 */
export function pathIsPresent(path: string, ops: EvidenceOps = REAL_EVIDENCE_OPS): boolean {
  try {
    ops.lstatSync(path)
    return true
  } catch (e) {
    // ENOENT - and ONLY ENOENT - means absent. Every other failure means the
    // question was not answered: EACCES on the parent, EIO from the device,
    // ENOTDIR because a path component is a file, ELOOP from a symlink cycle.
    // Treating "I could not look" as "nothing is there" is how a publisher
    // walks into the one case it exists to refuse, so it refuses instead.
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw new EvidenceRefused('collision', 'a path could not be examined')
  }
}

// ---------------------------------------------------------------------------
// ARTIFACTS AND THE DIGEST FILE
// ---------------------------------------------------------------------------

/** One artifact: a bounded relative path and the exact bytes to write. */
export interface EvidenceArtifact {
  readonly path: string
  readonly bytes: Buffer
}

export function assertArtifactPath(path: string): string {
  if (path.length === 0 || path.length > MAX_PATH_CHARS || path.startsWith('/')) {
    throw new EvidenceRefused('construct', 'an artifact path is not a bounded relative path')
  }
  const segments = path.split('/')
  if (segments.length > MAX_SEGMENTS) {
    throw new EvidenceRefused('construct', 'an artifact path is not a bounded relative path')
  }
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') {
      throw new EvidenceRefused('construct', 'an artifact path is not a bounded relative path')
    }
  }
  return path
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The DIGEST body: `<sha256>  <relative path>` per line, sorted lexically.
 *
 * SORTED BY PATH, not by the order the caller happened to supply, so two runs
 * over the same bytes produce the same file. `localeCompare` is deliberately
 * NOT used: it is locale-dependent, and a digest file that reorders itself when
 * `LC_ALL` changes is not deterministic.
 */
export function digestFileText(entries: readonly EvidenceArtifact[]): string {
  const lines = entries
    .map(e => ({ path: e.path, digest: sha256Hex(e.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(e => `${e.digest}  ${e.path}`)
  return `${lines.join('\n')}\n`
}

/** Parse a DIGEST body back into path -> digest. Refuses anything malformed. */
export function parseDigestFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = text.split('\n')
  if (lines[lines.length - 1] !== '') {
    throw new EvidenceRefused('verify', 'the published digest does not describe the published bytes')
  }
  for (const line of lines.slice(0, -1)) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (m === null || out.has(m[2])) {
      throw new EvidenceRefused(
        'verify', 'the published digest does not describe the published bytes')
    }
    out.set(m[2], m[1])
  }
  return out
}

// ---------------------------------------------------------------------------
// PUBLICATION
// ---------------------------------------------------------------------------

export interface PublishEvidenceInput {
  /** An existing, owned, 0700, non-symlink directory. Never created here. */
  readonly root: string
  readonly prefix: string
  readonly stamp: string
  readonly runId: string
  /** Everything except the manifest and DIGEST. Written FIRST. */
  readonly artifacts: readonly EvidenceArtifact[]
  /** The document that must carry `complete: true`. Written after the rest. */
  readonly manifest: EvidenceArtifact
}

export interface PublishedEvidence {
  readonly finalPath: string
  readonly temporaryPath: string
  /** Every regular file written, relative, in the order DIGEST records them. */
  readonly files: readonly string[]
  readonly digestFileDigest: string
}

/** A failed write of a file inside the bundle. Never carries the errno. */
function write(
  ops: EvidenceOps, abs: string, bytes: Buffer, rel: string, phase: EvidencePhase,
): void {
  let fd: number | null = null
  try {
    fd = ops.openSync(abs, 'wx', BUILD_FILE_MODE)
    ops.writeSync(fd, bytes)
    const st = ops.fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) {
      throw new EvidenceRefused(
        phase, 'a published entry is not the type, mode or link count it was frozen at', rel)
    }
  } catch (e) {
    if (e instanceof EvidenceRefused) throw e
    throw new EvidenceRefused(phase, 'a filesystem operation did not complete', rel)
  } finally {
    if (fd !== null) { try { ops.closeSync(fd) } catch { /* bounded */ } }
  }
}

/** fsync one path, opened read-only. Works for files and directories alike. */
function sync(ops: EvidenceOps, abs: string, rel: string | null): void {
  let fd: number | null = null
  try {
    fd = ops.openSync(abs, 'r')
    ops.fsyncSync(fd)
  } catch {
    throw new EvidenceRefused('fsync', 'a filesystem operation did not complete', rel)
  } finally {
    if (fd !== null) { try { ops.closeSync(fd) } catch { /* bounded */ } }
  }
}

/**
 * Build the bundle, freeze it, and publish it with exactly one rename.
 *
 * THE ORDER IS THE CONTRACT, so it is written once, here, and every step is
 * numbered against the reviewed sequence:
 *
 *   1  the root is real, owned, 0700 and not a symlink
 *   2  neither the final nor the temporary path is PRESENT (-e or -L)
 *   3  the temporary directory is created 0700 in the SAME parent
 *   4  every artifact is written 0600, link count 1
 *   5  the manifest is written, and must carry the completion marker
 *   6  DIGEST is written LAST, over every regular file except itself
 *   7  every file is frozen to 0400
 *   8  every directory is frozen to 0500, deepest first
 *   9  every file, then every directory deepest-first, then the temporary root
 *      is fsynced - AFTER freezing, so the modes are durable too
 *  10  the final path is re-checked for absence and ONE same-parent rename runs
 *  11  the parent is fsynced, so the new name survives a crash
 *  12  the published bundle is verified from the outside
 *
 * A FAILURE BEFORE STEP 10 NEVER CREATES THE FINAL PATH. The temporary
 * directory is left exactly as it was for diagnosis, and is never reused: a
 * later run gets a different run identifier and therefore a different
 * temporary name, and this function refuses outright if the one it wants is
 * already there.
 */
export function publishEvidence(
  input: PublishEvidenceInput, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): PublishedEvidence {
  // 1.
  const root = assertEvidenceRoot(input.root, ops)
  const names = evidenceNames(input.prefix, input.stamp, input.runId)
  const finalPath = join(root, names.finalName)
  const tempPath = join(root, names.temporaryName)

  // The publication is a rename WITHIN one directory. Asserted rather than
  // assumed: a cross-filesystem rename fails with EXDEV, and a publisher that
  // "helpfully" fell back to a copy would lose the atomicity that is the whole
  // point of building under a temporary name.
  if (dirname(finalPath) !== root || dirname(tempPath) !== root) {
    throw new EvidenceRefused('publish', 'a path is already present at the publication destination')
  }

  // 2.
  if (pathIsPresent(finalPath, ops)) {
    throw new EvidenceRefused(
      'collision', 'a path is already present at the publication destination')
  }
  if (pathIsPresent(tempPath, ops)) {
    throw new EvidenceRefused('collision', 'a path is already present at the temporary directory')
  }

  // Validate EVERYTHING the caller supplied before a single byte is written, so
  // a bad input does not leave a half-built temporary directory behind.
  if (input.artifacts.length === 0) {
    throw new EvidenceRefused('construct', 'no artifact was supplied')
  }
  const all: EvidenceArtifact[] = [...input.artifacts, input.manifest]
  const seen = new Set<string>()
  for (const a of all) {
    assertArtifactPath(a.path)
    if (a.path === DIGEST_FILE) {
      throw new EvidenceRefused('construct', 'the digest file may not be supplied as an artifact')
    }
    if (seen.has(a.path)) {
      throw new EvidenceRefused('construct', 'an artifact path is supplied more than once', a.path)
    }
    seen.add(a.path)
  }
  assertCompletionMarker(input.manifest)

  // 3.
  try {
    ops.mkdirSync(tempPath, { mode: BUILD_DIR_MODE })
  } catch {
    throw new EvidenceRefused('construct', 'a filesystem operation did not complete')
  }
  // `mkdir` is masked by the process umask; the mode is therefore SET, not
  // requested. Without this a umask of 022 yields 0755 and the bundle is world
  // readable while it is being built.
  try {
    ops.chmodSync(tempPath, BUILD_DIR_MODE)
  } catch {
    throw new EvidenceRefused('construct', 'a filesystem operation did not complete')
  }

  const dirs = new Set<string>()
  for (const a of all) {
    const parent = dirname(a.path)
    if (parent !== '.') {
      const parts = parent.split('/')
      for (let i = 0; i < parts.length; i += 1) dirs.add(parts.slice(0, i + 1).join('/'))
    }
  }
  const dirsDeepestFirst = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    try {
      ops.mkdirSync(join(tempPath, d), { mode: BUILD_DIR_MODE })
      ops.chmodSync(join(tempPath, d), BUILD_DIR_MODE)
    } catch {
      throw new EvidenceRefused('construct', 'a filesystem operation did not complete', d)
    }
  }

  // 4. Every artifact FIRST.
  for (const a of input.artifacts) {
    write(ops, join(tempPath, a.path), a.bytes, a.path, 'construct')
  }
  // 5. Then the manifest, which by now describes files that all exist.
  write(ops, join(tempPath, input.manifest.path), input.manifest.bytes, input.manifest.path,
        'manifest')

  // 6. DIGEST LAST, over every regular file except itself.
  const digestText = digestFileText(all)
  const digestBytes = Buffer.from(digestText, 'utf-8')
  write(ops, join(tempPath, DIGEST_FILE), digestBytes, DIGEST_FILE, 'digest')

  // 7. Files to 0400.
  for (const rel of [...all.map(a => a.path), DIGEST_FILE]) {
    try {
      ops.chmodSync(join(tempPath, rel), FROZEN_FILE_MODE)
    } catch {
      throw new EvidenceRefused('freeze', 'a filesystem operation did not complete', rel)
    }
  }
  // 8. Directories to 0500, DEEPEST FIRST - a parent frozen first would deny
  //    the traversal needed to reach its own children.
  //
  //    THE BUNDLE ROOT IS THE ONE EXCEPTION, AND IT IS A MEASURED PLATFORM
  //    CONSTRAINT, NOT A CONVENIENCE. rename(2) on a DIRECTORY requires write
  //    permission on the directory being moved, because its "." entry is part
  //    of what the rename updates - and macOS/APFS enforces that even for a
  //    rename within one parent. Freezing the bundle root to 0500 here makes
  //    the publication itself fail with EACCES, which was measured, not
  //    assumed. So the root is frozen in step 10b, IMMEDIATELY after the
  //    rename, and the honest description of the window is this: between the
  //    rename and that chmod the published directory is 0700 - reachable by
  //    its owner alone, holding files that are already 0400 and subdirectories
  //    that are already 0500, for the duration of one chmod call.
  for (const rel of dirsDeepestFirst) {
    try {
      ops.chmodSync(join(tempPath, rel), FROZEN_DIR_MODE)
    } catch {
      throw new EvidenceRefused('freeze', 'a filesystem operation did not complete', rel)
    }
  }

  // 9. fsync AFTER freezing: files, then directories deepest-first, then the
  //    temporary root. A mode change is metadata, and metadata that was never
  //    flushed is a bundle that comes back writable after a crash.
  for (const rel of [...all.map(a => a.path), DIGEST_FILE]) sync(ops, join(tempPath, rel), rel)
  for (const rel of dirsDeepestFirst) sync(ops, join(tempPath, rel), rel)
  sync(ops, tempPath, null)

  // 10. ONE atomic no-replace publication. There is NO absence check here and
  //     no need for one: `renamex_np(..., RENAME_EXCL)` is a single syscall
  //     that fails with EEXIST rather than replacing, so there is no window
  //     between deciding and acting. The earlier check-then-rename could lose
  //     an EMPTY destination created in the gap; this cannot lose anything.
  //     `unavailable` is a REFUSAL, never a fallback: publishing through an
  //     overwrite-capable primitive would silently downgrade the one guarantee
  //     this function exists to make.
  const outcome = ops.renameNoReplace(tempPath, finalPath)
  if (outcome === 'destination-exists') {
    throw new EvidenceRefused(
      'publish', 'a path is already present at the publication destination')
  }
  if (outcome === 'unavailable') {
    throw new EvidenceRefused(
      'publish', 'this platform offers no atomic no-replace publication')
  }
  if (outcome !== 'published') {
    throw new EvidenceRefused('publish', 'a filesystem operation did not complete')
  }

  // ---- EVERYTHING BELOW THIS LINE HAPPENS WITH THE BUNDLE ALREADY PUBLISHED.
  //
  // The final name now exists. A failure from here on is NOT a refusal, and
  // saying "nothing was published" would be false. Each one is raised as
  // `EvidencePublishedButUnverified`, which names the bundle and states plainly
  // that it has not been removed. Nothing below deletes or repairs it.
  const published = (phase: PublishedPhase, reason: EvidenceReason): never => {
    throw new EvidencePublishedButUnverified(
      phase, reason, names.finalName, names.temporaryName)
  }

  // 10b. The bundle root, now that it has been moved. See step 8.
  try {
    ops.chmodSync(finalPath, FROZEN_DIR_MODE)
  } catch {
    published('freeze-final', 'a filesystem operation did not complete')
  }
  try {
    sync(ops, finalPath, null)
  } catch {
    published('fsync-final', 'a filesystem operation did not complete')
  }

  // 11. The parent, so the NAME survives a crash.
  try {
    sync(ops, root, null)
  } catch {
    published('fsync-parent', 'a filesystem operation did not complete')
  }

  // 12. Verified from the outside, through the published name.
  let files: readonly string[] = []
  try {
    files = verifyPublishedEvidence(finalPath, ops)
  } catch (e) {
    published('verify', e instanceof EvidenceRefused
      ? e.reason
      : 'a published entry is not the type, mode or link count it was frozen at')
  }

  return Object.freeze({
    finalPath,
    temporaryPath: tempPath,
    files,
    digestFileDigest: sha256Hex(digestBytes),
  })
}

/** The manifest must say, in its own bytes, that it is complete. */
export function assertCompletionMarker(manifest: EvidenceArtifact): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest.bytes.toString('utf-8'))
  } catch {
    throw new EvidenceRefused(
      'manifest', 'the manifest document does not carry the completion marker', manifest.path)
  }
  const complete = (parsed as { complete?: unknown } | null)?.complete
  if (complete !== true) {
    throw new EvidenceRefused(
      'manifest', 'the manifest document does not carry the completion marker', manifest.path)
  }
}

/**
 * Verify a PUBLISHED bundle from the outside, reading only what is there.
 *
 * NEVER MUTATES. This is the function an operator runs weeks later to ask
 * whether the bundle still says what it said, and a verifier that repaired
 * what it checked would report success forever.
 */
export function verifyPublishedEvidence(
  finalPath: string, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): readonly string[] {
  const dirSt = (() => {
    try { return ops.lstatSync(finalPath) } catch { return null }
  })()
  if (dirSt === null || dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new EvidenceRefused(
      'verify', 'a published entry is not the type, mode or link count it was frozen at')
  }
  if ((dirSt.mode & 0o777) !== FROZEN_DIR_MODE) {
    throw new EvidenceRefused(
      'verify', 'a published entry is not the type, mode or link count it was frozen at')
  }

  const found: string[] = []
  const walk = (absDir: string, relDir: string): void => {
    let entries
    try {
      entries = ops.readdirSync(absDir, { withFileTypes: true })
    } catch {
      throw new EvidenceRefused('verify', 'a filesystem operation did not complete', relDir || '.')
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`
      const abs = join(absDir, e.name)
      const st = ops.lstatSync(abs)
      if (st.isSymbolicLink()) {
        throw new EvidenceRefused(
          'verify', 'a published entry is not the type, mode or link count it was frozen at', rel)
      }
      if (st.isDirectory()) {
        if ((st.mode & 0o777) !== FROZEN_DIR_MODE) {
          throw new EvidenceRefused(
            'verify', 'a published entry is not the type, mode or link count it was frozen at', rel)
        }
        walk(abs, rel)
        continue
      }
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== FROZEN_FILE_MODE) {
        throw new EvidenceRefused(
          'verify', 'a published entry is not the type, mode or link count it was frozen at', rel)
      }
      found.push(rel)
    }
  }
  walk(finalPath, '')

  if (!found.includes(DIGEST_FILE)) {
    throw new EvidenceRefused('verify', 'the published bundle carries no digest file')
  }
  const recorded = parseDigestFile(ops.readFileSync(join(finalPath, DIGEST_FILE), 'utf-8') as string)

  const covered = found.filter(f => f !== DIGEST_FILE).sort()
  const listed = [...recorded.keys()].sort()
  if (covered.length !== listed.length || covered.some((f, i) => f !== listed[i])) {
    throw new EvidenceRefused('verify', 'the published digest does not describe the published bytes')
  }
  for (const rel of covered) {
    const bytes = ops.readFileSync(join(finalPath, rel)) as Buffer
    if (sha256Hex(bytes) !== recorded.get(rel)) {
      throw new EvidenceRefused(
        'verify', 'the published digest does not describe the published bytes', rel)
    }
  }
  return Object.freeze([...covered, DIGEST_FILE])
}
