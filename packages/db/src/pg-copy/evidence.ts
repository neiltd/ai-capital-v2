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
  readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync,
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
  | 'the temporary tag is not in the reviewed form'
  | 'the retained scratch directory is not the complete record'
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
  | 'the publication outcome could not be determined'

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
  /**
   * THE `device:inode` OF A TEMPORARY DIRECTORY THIS PUBLICATION ITSELF CREATED.
   *
   * Set - once, by `publishEvidence`, immediately after its OWN `mkdir` returned -
   * on every failure that happens after that point, and left null on every failure
   * before it, EEXIST included. It is the only evidence that the directory now
   * sitting under the temporary name was made by this call and not adopted from
   * something that was already there.
   *
   * WHY IT CANNOT BE RECONSTRUCTED LATER. A caller that observed the path absent
   * and then stat'ed it in its catch block would adopt whatever appeared in
   * between - which is exactly the directory it must never delete. Absence a moment
   * ago plus existence now is not creation.
   */
  createdIdentity: string | null = null

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
 * THE PUBLICATION OUTCOME IS UNKNOWN. Nothing may be assumed or touched.
 *
 * Reached when the atomic helper did not report - killed, timed out, died on a
 * signal - AND the subsequent fail-closed examination could not establish
 * which side of the rename the filesystem ended up on. `renamex_np` is atomic,
 * but the REPORTING of it is not, so a helper can complete the rename and then
 * be killed microseconds before its exit code is observed.
 *
 * This is deliberately NOT retryable and deliberately not tidied. A retry
 * would either publish a second bundle beside a first one nobody knows about,
 * or refuse on a destination it created itself. Both the temporary and the
 * final names are preserved exactly, and a person has to look.
 */
export class EvidencePublicationUnknown extends Error {
  /**
   * THE `device:inode` OF A TEMPORARY DIRECTORY THIS PUBLICATION ITSELF CREATED.
   *
   * Set - once, by `publishEvidence`, immediately after its OWN `mkdir` returned -
   * on every failure that happens after that point, and left null on every failure
   * before it, EEXIST included. It is the only evidence that the directory now
   * sitting under the temporary name was made by this call and not adopted from
   * something that was already there.
   *
   * WHY IT CANNOT BE RECONSTRUCTED LATER. A caller that observed the path absent
   * and then stat'ed it in its catch block would adopt whatever appeared in
   * between - which is exactly the directory it must never delete. Absence a moment
   * ago plus existence now is not creation.
   */
  createdIdentity: string | null = null

  constructor(
    readonly publishedName: string,
    readonly temporaryName: string,
  ) {
    super(
      'the publication outcome could not be determined, and nothing has been removed or ' +
      'repaired. Inspect both names before any retry; a retry is NOT safe. ' +
      `published=${publishedName} temporary=${temporaryName}`)
    this.name = 'EvidencePublicationUnknown'
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
  /**
   * THE `device:inode` OF A TEMPORARY DIRECTORY THIS PUBLICATION ITSELF CREATED.
   *
   * Set - once, by `publishEvidence`, immediately after its OWN `mkdir` returned -
   * on every failure that happens after that point, and left null on every failure
   * before it, EEXIST included. It is the only evidence that the directory now
   * sitting under the temporary name was made by this call and not adopted from
   * something that was already there.
   *
   * WHY IT CANNOT BE RECONSTRUCTED LATER. A caller that observed the path absent
   * and then stat'ed it in its catch block would adopt whatever appeared in
   * between - which is exactly the directory it must never delete. Absence a moment
   * ago plus existence now is not creation.
   */
  createdIdentity: string | null = null

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
  /**
   * REMOVAL, and only of a scratch directory this module has just PROVED.
   *
   * WHY IT EXISTS AT ALL. A publication that fails before its rename retains its
   * temporary directory, and until now every retry of one record made another
   * one - so a persistent rename, fsync, freeze or verification failure created
   * directories for as long as the hold held, which is for ever. Bounding that
   * needs the ability to reuse ONE scratch directory, and reusing it needs the
   * ability to clear it.
   *
   * WHY THESE TWO PRIMITIVES AND NOT A RECURSIVE REMOVE. `rmSync(_, {recursive})`
   * would descend wherever it was pointed and is exactly the wrong tool for a
   * directory tree that may be somebody else's published evidence. `unlinkSync`
   * removes ONE named entry and `rmdirSync` fails unless the directory is
   * already empty, so a scratch directory can only be cleared entry by entry,
   * each one named, after the guard in `discardScratch` has proved what it is
   * about to clear. A subdirectory it did not expect makes the removal FAIL
   * rather than widen.
   */
  unlinkSync: typeof unlinkSync
  rmdirSync: typeof rmdirSync
}

export const REAL_EVIDENCE_OPS: EvidenceOps = {
  lstatSync, mkdirSync, openSync, writeSync, fsyncSync, fstatSync, closeSync,
  chmodSync, renameNoReplace: atomicRenameNoReplace, readdirSync, readFileSync,
  unlinkSync, rmdirSync,
}

// ---------------------------------------------------------------------------
// NAMES
// ---------------------------------------------------------------------------

/** The only prefixes this repository publishes evidence under. */
export const REVIEWED_PREFIXES: readonly string[] = Object.freeze([
  'source-manifest', 'verification', 'release-gate', 'copy-lifecycle',
  // The operational-rehearsal family. Each states its own temporary name below.
  'operational-rehearsal', 'producer-restoration', 'rehearsal-review',
  'intervention-intent', 'intervention-outcome', 'commit-disposition',
  'pristine-release',
  // The failed-flow retirement family. A retirement is an irreversible removal of
  // production queue state, so it publishes its INTENT before the first mutation
  // and its OUTCOME afterwards: two bundles, because one written at the end could
  // not distinguish "nothing happened" from "something happened and was not
  // recorded".
  'queue-flow-retirement-intent', 'queue-flow-retirement-outcome',
])

/**
 * The temporary name each reviewed prefix builds under. A TABLE, not a formula.
 *
 * A uniform `.tmp-<prefix>-<runId>` rule would have been tidier to write and
 * would have RENAMED something already reviewed: Stage 1 builds under
 * `.tmp-<runId>`, and that name is what its reviewed tests and an operator
 * looking for an abandoned directory both expect. Verification states its own
 * name instead of inheriting one, so neither prefix's temporary name can be
 * changed by an edit aimed at the other.
 *
 * Both are `.tmp`-prefixed, both carry the run identifier, and both live in the
 * same parent as the bundle they will become - which is what the publication
 * actually depends on.
 */
export const TEMPORARY_NAME_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  'source-manifest': '.tmp-',
  verification: '.tmp-verification-',
  'release-gate': '.tmp-release-gate-',
  'copy-lifecycle': '.tmp-copy-lifecycle-',
  'operational-rehearsal': '.tmp-operational-rehearsal-',
  'producer-restoration': '.tmp-producer-restoration-',
  'rehearsal-review': '.tmp-rehearsal-review-',
  'intervention-intent': '.tmp-intervention-intent-',
  'intervention-outcome': '.tmp-intervention-outcome-',
  'commit-disposition': '.tmp-commit-disposition-',
  'pristine-release': '.tmp-pristine-release-',
  'queue-flow-retirement-intent': '.tmp-queue-flow-retirement-intent-',
  'queue-flow-retirement-outcome': '.tmp-queue-flow-retirement-outcome-',
})

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
  /** The prefix's reviewed temporary name, in the SAME parent. */
  readonly temporaryName: string
}

/**
 * THE ONE EXTRA SCRATCH NAME A RECORD MAY USE. One value, not a counter.
 *
 * WHAT WAS WRONG WITH A COUNTER. K1.4 gave each retry its own temporary
 * directory, numbered, so that a record whose first attempt left wreckage under
 * the untagged name could still be retried. That bounded nothing: a persistent
 * pre-rename failure - a read-only device, an fsync that keeps failing, a freeze
 * that cannot take - produced one more preserved directory per cycle, and the
 * hold cycles for as long as the fence is held, which is for ever.
 *
 * SO THERE ARE EXACTLY TWO NAMES PER RECORD. The untagged one, which the first
 * attempt builds under and which is PRESERVED UNTOUCHED as the diagnostic
 * directory if that attempt fails, and this one, which every later attempt
 * reuses. Two directories, whatever the retry count.
 */
export const EVIDENCE_RETRY_SCRATCH = 'retry'

/**
 * The two names, derived from ONE run identifier.
 *
 * The temporary name carries the same identifier as the final one, so a
 * retained temporary directory can be matched to the run that abandoned it
 * without reading anything inside it.
 *
 * `temporaryTag` NAMES THE RETRY SCRATCH DIRECTORY, and touches the temporary
 * name only. A failure before the rename retains its temporary directory for
 * diagnosis and never reuses it, which is deliberate - but it means a caller
 * whose contract is "publish THIS record, under THIS name, until it lands"
 * could never succeed on a second attempt: the final name it must keep implies
 * a temporary name that is now occupied by the wreckage of the first. So there
 * is ONE extra name, `EVIDENCE_RETRY_SCRATCH`, that every later attempt reuses.
 * The first failure's directory is preserved for diagnosis; the record's
 * identity - the final name - never moves; and the number of directories one
 * record can occupy is two, however many times it is retried.
 */
export function evidenceNames(
  prefix: string, stamp: string, runId: string, temporaryTag?: string,
): EvidenceNames {
  if (!REVIEWED_PREFIXES.includes(prefix)) {
    throw new EvidenceRefused('name', 'the prefix is not a reviewed evidence prefix')
  }
  if (!STAMP.test(stamp)) {
    throw new EvidenceRefused('name', 'the timestamp is not a basic-format UTC instant')
  }
  assertRunId(runId)
  if (temporaryTag !== undefined && temporaryTag !== EVIDENCE_RETRY_SCRATCH) {
    throw new EvidenceRefused('name', 'the temporary tag is not in the reviewed form')
  }
  const tag = temporaryTag === undefined ? '' : `-${temporaryTag}`
  return Object.freeze({
    finalName: `${prefix}-${stamp}-${runId}`,
    temporaryName: `${TEMPORARY_NAME_PREFIX[prefix]}${runId}${tag}`,
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
/**
 * A path's filesystem IDENTITY - `device:inode` - or null if it is absent.
 *
 * Identity, not existence, is what resolves an unreported rename: after
 * `renamex_np` the SAME directory object lives under a new name, so finding
 * the temporary directory's original device and inode at the final path is
 * proof the syscall ran, and finding it still at the temporary path is proof
 * it did not. Comparing names or mere presence could not tell either apart
 * from a directory somebody else created.
 *
 * Fail-closed, exactly like `pathIsPresent`: only ENOENT means absent.
 */
export function pathIdentity(
  path: string, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): string | null {
  try {
    const st = ops.lstatSync(path, { bigint: true }) as unknown as
      { dev: bigint; ino: bigint }
    return `${String(st.dev)}:${String(st.ino)}`
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw new EvidenceRefused('publish', 'a path could not be examined')
  }
}

/** What an unreported rename turned out to have done. */
export type PublicationDisposition =
  | 'published'
  | 'not-published'
  | 'destination-exists'
  | 'unknown'

/**
 * Resolve an unreported rename by LOOKING, never by assuming.
 *
 * Four outcomes, and anything that is not exactly one of the first three -
 * including a probe that throws - is `unknown`. There is no default that
 * guesses in the direction of "nothing happened", because that is the guess
 * that reports a published bundle as absent.
 */
export function classifyUnreportedRename(
  temporaryPath: string, finalPath: string, temporaryIdentityBefore: string,
  ops: EvidenceOps = REAL_EVIDENCE_OPS,
): PublicationDisposition {
  let tempNow: string | null
  let finalNow: string | null
  try {
    tempNow = pathIdentity(temporaryPath, ops)
    finalNow = pathIdentity(finalPath, ops)
  } catch {
    return 'unknown'
  }
  // The bundle moved: the object that was the temporary directory is now the
  // final name, and the temporary name is gone.
  if (tempNow === null && finalNow === temporaryIdentityBefore) return 'published'
  // The bundle did not move: it is still itself, under its own name, and
  // nothing is at the destination.
  if (tempNow === temporaryIdentityBefore && finalNow === null) return 'not-published'
  // The bundle did not move, and something ELSE is at the destination.
  if (tempNow === temporaryIdentityBefore && finalNow !== null) return 'destination-exists'
  return 'unknown'
}

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
  /**
   * Discriminates one retry's TEMPORARY directory. See `evidenceNames`.
   *
   * The published name is unaffected, so this cannot be used to publish the
   * same record twice: the second publication still finds the final name
   * occupied and still refuses.
   */
  readonly temporaryTag?: string
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
  const names = evidenceNames(input.prefix, input.stamp, input.runId, input.temporaryTag)
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

  // 3. THE EXCLUSIVE CREATION. `mkdir` fails with EEXIST rather than adopting a
  //    directory that is already there, so a success here means this call made it.
  try {
    ops.mkdirSync(tempPath, { mode: BUILD_DIR_MODE })
  } catch {
    // BEFORE THE CREATION, SO NO RECEIPT. EEXIST lands here too, which is the
    // case that matters: a directory that was already there was not created by us.
    throw new EvidenceRefused('construct', 'a filesystem operation did not complete')
  }
  // 3a. THE RECEIPT, TAKEN IMMEDIATELY, from the object `mkdir` just made.
  //
  // AND TAKING IT CANNOT FAIL THE PUBLICATION. `pathIdentity` refuses rather than
  // guesses when a path cannot be examined, which is right for a caller that needs
  // an answer - but here a missing receipt is a perfectly good answer: it means no
  // later cleanup may touch this directory. Letting it throw would turn an
  // unreadable inode into a failed publication, and a failure with no receipt into
  // a failure that never reports at all.
  const createdIdentity = (() => {
    try { return pathIdentity(tempPath, ops) } catch { return null }
  })()
  /** Attach the receipt to anything thrown from here on, and rethrow. */
  const withReceipt = (e: unknown): never => {
    if (e instanceof EvidenceRefused || e instanceof EvidencePublishedButUnverified ||
        e instanceof EvidencePublicationUnknown) {
      e.createdIdentity = createdIdentity
    }
    throw e
  }
  try {
    return publishCreated()
  } catch (e) { return withReceipt(e) }

  /** Everything from step 3b onwards, so one wrapper can carry the receipt. */
  function publishCreated(): PublishedEvidence {
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

  // 10-12. CLAIM THE NAME, FINISH THE BUNDLE, VERIFY IT.
  return finalizeScratch(root, names, tempPath, finalPath, digestBytes, ops)
  }
}

/**
 * STEPS 10-12, AS ONE FUNCTION: claim the name, finish the bundle, verify it.
 *
 * FACTORED OUT SO A RETAINED SCRATCH DIRECTORY CAN BE PUBLISHED WITHOUT BEING
 * REBUILT. A bundle whose bytes are already frozen on disk and whose rename was
 * the thing that failed does not need writing again - and rewriting it would
 * mean unfreezing files that are already 0400, which is a mutation of something
 * that may be one rename away from being evidence. So the caller proves the
 * retained directory holds exactly the frozen record and then re-enters HERE.
 *
 * NOTHING ABOVE STEP 10 HAPPENS IN THIS FUNCTION, and nothing in it removes or
 * repairs anything. The single mutation it performs is the one no-replace
 * rename, plus the two metadata operations that step 10b and 11 exist for.
 */
function finalizeScratch(
  root: string, names: EvidenceNames, tempPath: string, finalPath: string,
  digestBytes: Buffer, ops: EvidenceOps,
): PublishedEvidence {
  // 10. ONE atomic no-replace publication. There is NO absence check here and
  //     no need for one: `renamex_np(..., RENAME_EXCL)` is a single syscall
  //     that fails with EEXIST rather than replacing, so there is no window
  //     between deciding and acting. The earlier check-then-rename could lose
  //     an EMPTY destination created in the gap; this cannot lose anything.
  //     `unavailable` is a REFUSAL, never a fallback: publishing through an
  //     overwrite-capable primitive would silently downgrade the one guarantee
  //     this function exists to make.
  //
  //     IDENTITY IS TAKEN FIRST, because the helper can complete the rename
  //     and then be killed before its exit code is observed. `device:inode` is
  //     what makes that resolvable afterwards: the same directory OBJECT under
  //     a new name is proof the syscall ran.
  const temporaryIdentity = pathIdentity(tempPath, ops)
  if (temporaryIdentity === null) {
    throw new EvidenceRefused('publish', 'a path could not be examined')
  }

  let outcome = ops.renameNoReplace(tempPath, finalPath)

  // THE HELPER DID NOT REPORT. Resolve it by looking at both paths, and never
  // by assuming which side of the rename the filesystem ended up on.
  if (outcome === 'indeterminate') {
    const disposition = classifyUnreportedRename(tempPath, finalPath, temporaryIdentity, ops)
    if (disposition === 'unknown') {
      // NOT retryable, NOT tidied. Everything stays exactly as it is.
      throw new EvidencePublicationUnknown(names.finalName, names.temporaryName)
    }
    outcome = disposition === 'published' ? 'published'
      : disposition === 'destination-exists' ? 'destination-exists'
        : 'failed'
  }

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

// ---------------------------------------------------------------------------
// BOUNDED PUBLICATION SCRATCH
// ---------------------------------------------------------------------------

/**
 * What a record's scratch directory turns out to be.
 *
 * `complete`   holds EXACTLY the frozen record - the reviewed file set, the exact
 *              bytes, a DIGEST that covers them - and is therefore one rename
 *              away from being evidence.
 * `incomplete` is provably this record's scratch directory and is NOT that, so it
 *              may be cleared and rebuilt.
 * `absent`     nothing is there.
 * `unproved`   the question was not answered. NEVER touched: a directory whose
 *              state could not be established is a directory that may be
 *              anything, including evidence.
 * `foreign`    something is there that this record did not prove it owns - a
 *              symlink, another user's directory, another device, a different
 *              object under the same name. NEVER touched.
 */
export type ScratchDisposition = 'complete' | 'incomplete' | 'absent' | 'unproved' | 'foreign'

/**
 * WHAT A CLEANUP ACTUALLY DID. Four answers, because there are four situations.
 *
 * `absent`            nothing was there.
 * `refused-untouched` nothing passed validation and NOTHING WAS CHANGED. This is
 *                     the only outcome that may be reported as "nothing was
 *                     removed", and it is decidable because every check happens
 *                     before the first mutation.
 * `discarded`         the whole validated tree is gone.
 * `partial-or-unknown` a chmod, unlink or rmdir failed AFTER the first mutation.
 *
 * WHY THE FOURTH ONE EXISTS. A multi-entry deletion cannot be rolled back: once one
 * `unlink` has returned, those bytes are gone, and a later failure leaves a tree
 * that is neither what it was nor empty. Reporting that as a refusal - which this
 * did - tells an operator nothing was removed while something was. The mode is put
 * back where it can be, and the rest is reported as unknown rather than guessed at.
 */
export type ScratchCleanup =
  | 'absent' | 'refused-untouched' | 'discarded' | 'partial-or-unknown'

/** Everything needed to say what a scratch directory should contain. */
export interface ScratchInput {
  readonly root: string
  readonly prefix: string
  readonly stamp: string
  readonly runId: string
  /** `EVIDENCE_RETRY_SCRATCH`, or omitted for the first attempt's own name. */
  readonly temporaryTag?: string
  readonly artifacts: readonly EvidenceArtifact[]
  readonly manifest: EvidenceArtifact
}

/** The reviewed paths one record may occupy, derived once. */
function scratchPaths(i: ScratchInput, ops: EvidenceOps): {
  root: string; names: EvidenceNames; tempPath: string; finalPath: string
} {
  const root = assertEvidenceRoot(i.root, ops)
  const names = evidenceNames(i.prefix, i.stamp, i.runId, i.temporaryTag)
  const tempPath = join(root, names.temporaryName)
  const finalPath = join(root, names.finalName)
  // THE SAME PARENT, ASSERTED. A rename across directories is not the atomic
  // operation this module publishes with, and a temporary name that escaped the
  // root is a path this module must not remove.
  if (dirname(tempPath) !== root || dirname(finalPath) !== root) {
    throw new EvidenceRefused('publish', 'a path is already present at the publication destination')
  }
  return { root, names, tempPath, finalPath }
}

/**
 * IS THIS DIRECTORY PROVABLY THIS RECORD'S SCRATCH DIRECTORY?
 *
 * Every one of these is a way a path under the right NAME can still be the wrong
 * THING, and each is checked rather than assumed, because what follows a `true`
 * here is either a rename or a removal:
 *
 *   - it is under the exact evidence root, which `scratchPaths` derived and
 *     `assertEvidenceRoot` proved is an owned, 0700, non-symlink directory;
 *   - it carries the exact reviewed temporary name for THIS record;
 *   - it is a real directory and not a symbolic link, so nothing that follows
 *     acts on whatever a link points at;
 *   - it is owned by this process's user;
 *   - it is on the evidence root's device, so a mount moved underneath it is not
 *     mistaken for the directory this run created;
 *   - it is not the final published path, whose identity is compared rather than
 *     its name.
 */
function scratchIsOurs(
  tempPath: string, finalPath: string, root: string, ops: EvidenceOps,
): 'ours' | 'foreign' | 'absent' | 'unproved' {
  let st
  try {
    st = ops.lstatSync(tempPath, { bigint: true }) as unknown as {
      dev: bigint; ino: bigint; uid: bigint; mode: bigint
      isDirectory: () => boolean; isSymbolicLink: () => boolean
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'absent'
    // EVERY OTHER ERROR IS "NOT ANSWERED", never "absent": EACCES on the parent,
    // EIO from the device, ELOOP from a link cycle.
    return 'unproved'
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'foreign'
  let rootSt
  try {
    rootSt = ops.lstatSync(root, { bigint: true }) as unknown as
      { dev: bigint; uid: bigint }
  } catch { return 'unproved' }
  if (st.dev !== rootSt.dev) return 'foreign'
  if (st.uid !== rootSt.uid) return 'foreign'
  if (typeof process.getuid === 'function' && st.uid !== BigInt(process.getuid())) {
    return 'foreign'
  }
  // NOT THE PUBLISHED PATH. Compared by IDENTITY, because two names can be one
  // object and a name comparison would miss it.
  let finalIdentity: string | null
  try { finalIdentity = pathIdentity(finalPath, ops) } catch { return 'unproved' }
  if (finalIdentity !== null && finalIdentity === `${String(st.dev)}:${String(st.ino)}`) {
    return 'foreign'
  }
  return 'ours'
}

/**
 * Look at a record's scratch directory and say what it is. NEVER MUTATES.
 *
 * This is the question asked before every retry, and the answer decides between
 * three very different actions - rename it, clear and rebuild it, or leave it
 * strictly alone - so it is a measurement and nothing else.
 */
export function inspectScratch(
  i: ScratchInput, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): ScratchDisposition {
  let paths
  try { paths = scratchPaths(i, ops) } catch { return 'unproved' }
  const owned = scratchIsOurs(paths.tempPath, paths.finalPath, paths.root, ops)
  if (owned !== 'ours') return owned
  // IS IT THE WHOLE RECORD? Verified through the same reader an operator would
  // use weeks later, then compared byte for byte against what we meant to write.
  let files: readonly string[]
  try {
    // AT THE BUILD MODE, NOT THE PUBLISHED ONE. A scratch directory is 0700 until
    // after its rename; everything inside it is already frozen. See
    // `verifyFrozenTree`.
    files = verifyFrozenTree(paths.tempPath, BUILD_DIR_MODE, ops)
  } catch {
    // IT DOES NOT VERIFY. That is not a refusal here: a half-built directory is
    // exactly what an interrupted attempt leaves, and saying so is the point.
    return 'incomplete'
  }
  const all: EvidenceArtifact[] = [...i.artifacts, i.manifest]
  const expected = [...all.map(a => a.path), DIGEST_FILE].sort()
  const found = [...files].sort()
  if (found.length !== expected.length) return 'incomplete'
  if (found.some((f, n) => f !== expected[n])) return 'incomplete'
  for (const a of all) {
    let onDisk: Buffer
    try { onDisk = ops.readFileSync(join(paths.tempPath, a.path)) as Buffer } catch {
      return 'incomplete'
    }
    if (onDisk.length !== a.bytes.length || !onDisk.equals(a.bytes)) return 'incomplete'
  }
  return 'complete'
}

/**
 * THE COMPLETE SET OF PATHS ONE RECORD'S SCRATCH TREE MAY CONTAIN.
 *
 * Derived from the artifacts, the manifest and DIGEST - the same three things the
 * publisher writes - plus every parent directory those relative paths imply. This
 * is an ALLOW-LIST, and it is what makes "unexpected" a decidable question rather
 * than a guess: an entry whose relative path is not in here is refused, whatever
 * it looks like.
 */
function allowedScratchTree(i: ScratchInput): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const rel of [...i.artifacts.map(a => a.path), i.manifest.path, DIGEST_FILE]) {
    files.add(rel)
    const parent = dirname(rel)
    if (parent !== '.') {
      const parts = parent.split('/')
      for (let n = 0; n < parts.length; n += 1) dirs.add(parts.slice(0, n + 1).join('/'))
    }
  }
  return { files, dirs }
}

/**
 * WHAT A NODE IS, DECIDED IN ONE PLACE.
 *
 * `link` and `other` can never be expected, so a symlink, a FIFO, a socket and a
 * device node are all refused by the one comparison that uses this - and every one
 * of them is something `unlink` WOULD have removed, since `unlink` refuses only
 * directories. Used by the read-only preflight and again immediately before each
 * removal, so the two agree by construction rather than by coincidence.
 */
function nodeKind(st: {
  isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean
}): 'dir' | 'file' | 'link' | 'other' {
  if (st.isSymbolicLink()) return 'link'
  if (st.isDirectory()) return 'dir'
  if (st.isFile()) return 'file'
  return 'other'
}

/** One validated node, with the identity its removal will be re-checked against. */
interface ScratchNode {
  readonly path: string
  readonly identity: string
  readonly mode: number
}

/**
 * PHASE 1: WALK THE WHOLE TREE AND VALIDATE IT, MUTATING NOTHING.
 *
 * WHY THIS IS SEPARATE FROM THE REMOVAL. The previous version chmod'ed the
 * directory before it had finished looking at it and unlinked each entry as it
 * inspected the next, so a refusal could be returned AFTER the mode had been
 * changed and earlier entries destroyed - a "refusal" that had already done
 * damage. Nothing here writes. Either the entire tree passes and a plan comes
 * back, or nothing has been touched at all.
 *
 * WHAT EVERY NODE MUST SATISFY, and why each one:
 *   - NOT A SYMLINK. `unlink` REMOVES a symlink; it is only directories it
 *     refuses. So a link planted under an expected name is an entry this function
 *     would happily delete, and the link is not the only thing at stake - what it
 *     names tells you what somebody wanted deleted.
 *   - A REGULAR FILE OR A DIRECTORY, AND NOTHING ELSE. A FIFO, a socket, a device
 *     node are all unlinkable too. `isFile()` is false for every one of them,
 *     which is exactly why the type check is load-bearing rather than decorative.
 *   - IN THE ALLOW-LIST. An expected name is not enough on its own; an unexpected
 *     regular file is refused as firmly as an unexpected directory.
 *   - THE PROCESS'S OWN, ON THE ROOT'S DEVICE. Ownership and device, checked at
 *     every level rather than only at the top.
 *   - LINK COUNT 1 for a file, so nothing else on the filesystem names these bytes.
 *   - A PERMITTED MODE: files 0600 while being built or 0400 once frozen,
 *     directories 0700 or 0500. A half-built tree is legitimate; an arbitrary mode
 *     is not.
 */
function planScratchRemoval(
  i: ScratchInput, tempPath: string, finalPath: string, root: string,
  receipt: string | null, ops: EvidenceOps,
): { files: ScratchNode[]; dirs: ScratchNode[]; rootIdentity: string }
  | 'absent' | 'refused' {
  const owned = scratchIsOurs(tempPath, finalPath, root, ops)
  if (owned === 'absent') return 'absent'
  if (owned !== 'ours') return 'refused'

  // THE RECEIPT, REQUIRED HERE - inside the destructive operation itself.
  //
  // A caller-side check is a diagnostic, not an authority: between the caller's
  // look and this call the root can be replaced, and the caller's conclusion would
  // then be about an object that no longer exists. So this function asks for the
  // receipt and proves the root against it itself. No receipt is no permission.
  // AND THE PROBE THAT COMPARES IT CANNOT THROW.
  //
  // `pathIdentity` REFUSES rather than guesses when a path cannot be examined -
  // right for a caller that needs an answer, wrong here. This function's whole
  // contract is that it either returns a plan or refuses without touching
  // anything, and an exception escaping it would leave `discardScratch` throwing
  // out of the hold: a filesystem error on one lstat would unwind a held fence.
  // Unreadable is simply not-proved, which is a refusal like any other.
  const rootIdentity = (() => {
    try { return pathIdentity(tempPath, ops) } catch { return null }
  })()

  // ONE DECISION, NOT THREE. No receipt, an unreadable root and a root that is not
  // the receipted object are the same answer: this is not the thing we were given
  // permission to remove.
  //
  // WHY THEY ARE ONE LINE. They were three, and the identity comparison refused a
  // null receipt all by itself - so deleting the `receipt === null` guard changed no
  // behaviour and a mutation matrix reported the receipt requirement as unkillable.
  // That is the same defect shape as the entry-type gate in K1.5.1: one decision
  // spread across several lines, each implying the others, none of them testable.
  if (receipt === null || rootIdentity === null || rootIdentity !== receipt) {
    return 'refused'
  }

  let rootSt
  try {
    rootSt = ops.lstatSync(root, { bigint: true }) as unknown as { dev: bigint; uid: bigint }
  } catch { return 'refused' }
  const liveUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null

  const allowed = allowedScratchTree(i)
  const files: ScratchNode[] = []
  const dirs: ScratchNode[] = []

  /** Validate one node and record it. Returns false on any refusal. */
  const node = (abs: string, rel: string, expect: 'dir' | 'file'): boolean => {
    void rel
    let st
    try {
      st = ops.lstatSync(abs, { bigint: true }) as unknown as {
        dev: bigint; ino: bigint; uid: bigint; nlink: bigint; mode: bigint
        isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean
      }
    } catch { return false }

    // WHAT THIS NODE IS, DECIDED IN ONE PLACE.
    //
    // WHY ONE PLACE. This used to be a symlink test, then a directory branch, then
    // an `isFile` test, and each of the three separately implied the other two - so
    // removing any ONE of them changed no behaviour at all, and a mutation matrix
    // reported the entry-type check as unkillable. That was not defence in depth; it
    // was one decision spread thinly enough that no test could hold it.
    //
    // NOW THE TYPE IS A VALUE, and disagreeing with what was expected is a single
    // refusal. `link` and `other` can never be expected, so a symlink, a FIFO, a
    // socket and a device node are all refused HERE - and every one of them is
    // something `unlink` would have removed, since `unlink` refuses only
    // directories.
    const kind = nodeKind(st)
    if (kind !== expect) return false

    if (st.dev !== rootSt.dev) return false
    if (st.uid !== rootSt.uid) return false
    if (liveUid !== null && st.uid !== liveUid) return false
    const mode = Number(st.mode & 0o777n)
    const identity = `${String(st.dev)}:${String(st.ino)}`
    if (expect === 'dir') {
      if (mode !== BUILD_DIR_MODE && mode !== FROZEN_DIR_MODE) return false
      dirs.push({ path: abs, identity, mode })
      return true
    }
    // LINK COUNT 1, so nothing else on the filesystem names these bytes.
    if (st.nlink !== 1n) return false
    if (mode !== BUILD_FILE_MODE && mode !== FROZEN_FILE_MODE) return false
    files.push({ path: abs, identity, mode })
    return true
  }

  // THE SCRATCH ROOT ITSELF, then every level below it.
  if (!node(tempPath, '', 'dir')) return 'refused'
  const walk = (absDir: string, relDir: string): boolean => {
    let entries
    try {
      entries = ops.readdirSync(absDir, { withFileTypes: true })
    } catch { return false }
    for (const e of entries) {
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`
      const abs = join(absDir, e.name)
      // THE ALLOW-LIST, ENFORCED IN ONE PLACE, before the entry is stat'ed at all.
      //
      // An entry the record does not name is refused whatever it turns out to be -
      // and an unexpected REGULAR FILE is the case that matters, because it passes
      // every type, owner, device, link-count and mode test there is. This is the
      // only thing that refuses it.
      const expect: 'dir' | 'file' | null =
        allowed.dirs.has(rel) ? 'dir' : allowed.files.has(rel) ? 'file' : null
      if (expect === null) return false
      if (!node(abs, rel, expect)) return false
      if (expect === 'dir' && !walk(abs, rel)) return false
    }
    return true
  }
  if (!walk(tempPath, '')) return 'refused'
  return { files, dirs, rootIdentity }
}

/**
 * Clear a scratch directory THIS RECORD OWNS - after proving all of it, first.
 *
 * TWO PHASES, AND THE FIRST ONE WRITES NOTHING. `planScratchRemoval` walks the
 * whole tree read-only and either approves every node or refuses; only then does
 * anything change. A refusal therefore leaves the directory's mode, its entries,
 * their bytes and their identities exactly as they were - which the previous
 * version could not claim, because it chmod'ed before it had finished looking and
 * unlinked while it was still inspecting.
 *
 * AND EVERY REMOVAL IS RE-CHECKED IMMEDIATELY BEFORE IT HAPPENS. The identity
 * captured in phase 1 is compared again in phase 2, so a node swapped for another
 * object between the two phases is not the node that gets removed. Bottom-up, by
 * explicit path, with `unlink` and `rmdir` - never a recursive remove.
 *
 * AND THE OUTCOME SAYS WHICH OF THOSE HAPPENED. `refused-untouched` is claimed only
 * while nothing has been modified; once a chmod or an unlink has succeeded the
 * answer is `partial-or-unknown`, because a multi-entry deletion cannot be rolled
 * back and pretending otherwise tells an operator that nothing was removed when
 * something was. The modes are put back where they can be; bytes already unlinked
 * are gone and are reported as such.
 *
 * THE RECEIPT IS REQUIRED, and it is proved here rather than by the caller. See
 * `planScratchRemoval`.
 */
export function discardScratch(
  i: ScratchInput, receipt: string | null, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): ScratchCleanup {
  let paths
  try { paths = scratchPaths(i, ops) } catch { return 'refused-untouched' }
  const plan = planScratchRemoval(
    i, paths.tempPath, paths.finalPath, paths.root, receipt, ops)
  if (plan === 'absent') return 'absent'
  if (plan === 'refused') return 'refused-untouched'

  // THE ROOT, RE-PROVED IMMEDIATELY BEFORE THE FIRST MUTATION.
  //
  // The preflight walked the tree; between its last read and this line the root
  // could have been replaced, and everything below is about to modify it. Re-asking
  // costs one lstat and is the difference between "the object I validated" and "the
  // object now under that name".
  const rootNow = (() => {
    try { return pathIdentity(paths.tempPath, ops) } catch { return null }
  })()
  if (rootNow === null || rootNow !== plan.rootIdentity) return 'refused-untouched'

  // PHASE 2. From the first mutation onwards, a failure is NOT a refusal.
  let mutated = false
  const relaxed: ScratchNode[] = []
  const restoreModes = (): void => {
    for (const d of relaxed) {
      try { ops.chmodSync(d.path, d.mode) } catch { /* reported as unknown */ }
    }
  }
  /** Re-prove a node is still the same object, of the same type, right now. */
  const unchanged = (n: ScratchNode, want: 'dir' | 'file'): boolean => {
    try {
      const st = ops.lstatSync(n.path, { bigint: true }) as unknown as {
        dev: bigint; ino: bigint
        isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean
      }
      if (nodeKind(st) !== want) return false
      return `${String(st.dev)}:${String(st.ino)}` === n.identity
    } catch { return false }
  }
  /** Whatever went wrong, told truthfully: untouched before, unknown after. */
  const stop = (): ScratchCleanup => {
    restoreModes()
    return mutated ? 'partial-or-unknown' : 'refused-untouched'
  }

  // The directories are made writable, deepest LAST, so each parent can be
  // traversed while its children are still being removed.
  for (const d of [...plan.dirs].sort((a, b) => a.path.length - b.path.length)) {
    if (!unchanged(d, 'dir')) return stop()
    if (d.mode !== BUILD_DIR_MODE) {
      try { ops.chmodSync(d.path, BUILD_DIR_MODE) } catch { return stop() }
      mutated = true
      relaxed.push(d)
    }
  }
  for (const f of plan.files) {
    if (!unchanged(f, 'file')) return stop()
    try { ops.unlinkSync(f.path) } catch { return stop() }
    // FROM HERE THERE IS NO GOING BACK. Those bytes are gone, so no later failure
    // may be reported as though nothing had happened.
    mutated = true
  }
  // DEEPEST FIRST, so a directory is empty by the time it is removed.
  for (const d of [...plan.dirs].sort((a, b) => b.path.length - a.path.length)) {
    if (!unchanged(d, 'dir')) return stop()
    try { ops.rmdirSync(d.path) } catch { return stop() }
    mutated = true
  }
  return 'discarded'
}

/**
 * Publish a retained scratch directory by RETRYING ITS RENAME, nothing else.
 *
 * The bytes on disk are the frozen record, they are already 0400 under a 0700
 * directory, and they have already been fsynced - so there is nothing to write and
 * nothing to freeze, and writing them again would mean unfreezing a directory that
 * is one syscall away from being evidence.
 *
 * IT PROVES THAT FOR ITSELF, IMMEDIATELY BEFORE THE RENAME. A caller-side
 * `inspectScratch` is not enough and a documented precondition is not enough: this
 * function's one mutation is an atomic no-replace rename that TURNS A DIRECTORY
 * INTO PUBLISHED EVIDENCE, and what it publishes must be the record, not whatever
 * is sitting under the scratch name by the time it runs. A wrong answer here
 * cannot be taken back - the bundle is immutable and nothing removes it.
 *
 * So `inspectScratch` runs again, here, and anything but `complete` refuses with
 * the final path still ABSENT.
 *
 * THE DIGEST DIGEST IS READ, NOT RECOMPUTED FROM THE INPUTS, because what this
 * function returns has to describe what is actually on disk.
 */
export function publishRetainedScratch(
  i: ScratchInput, ops: EvidenceOps = REAL_EVIDENCE_OPS,
): PublishedEvidence {
  const { root, names, tempPath, finalPath } = scratchPaths(i, ops)
  if (inspectScratch(i, ops) !== 'complete') {
    throw new EvidenceRefused(
      'publish', 'the retained scratch directory is not the complete record')
  }
  let digestBytes: Buffer
  try {
    digestBytes = ops.readFileSync(join(tempPath, DIGEST_FILE)) as Buffer
  } catch {
    throw new EvidenceRefused('publish', 'the published bundle carries no digest file')
  }
  return finalizeScratch(root, names, tempPath, finalPath, digestBytes, ops)
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
  return verifyFrozenTree(finalPath, FROZEN_DIR_MODE, ops)
}

/**
 * The verification, with the ROOT's expected mode as a parameter.
 *
 * WHY THE ROOT IS THE ONLY THING THAT VARIES. A published bundle's root is 0500.
 * A scratch directory that has been fully built and frozen is 0700 and stays
 * 0700 until step 10b, AFTER the rename - because macOS/APFS needs write
 * permission on a directory to rename it, which was measured, not assumed. So the
 * two states differ in exactly one bit of metadata and in nothing else: the files
 * are already 0400, the subdirectories already 0500, and DIGEST already covers
 * the bytes.
 *
 * Without this parameter, asking "is this scratch directory already the complete
 * record?" through `verifyPublishedEvidence` could only ever answer no - the root
 * mode alone would fail it - and the whole point of preferring a rename over a
 * rebuild would be unreachable code. It was, until this was measured.
 */
function verifyFrozenTree(
  finalPath: string, rootMode: number, ops: EvidenceOps,
): readonly string[] {
  const dirSt = (() => {
    try { return ops.lstatSync(finalPath) } catch { return null }
  })()
  if (dirSt === null || dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new EvidenceRefused(
      'verify', 'a published entry is not the type, mode or link count it was frozen at')
  }
  if ((dirSt.mode & 0o777) !== rootMode) {
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
