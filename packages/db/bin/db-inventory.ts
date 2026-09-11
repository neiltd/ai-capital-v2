#!/usr/bin/env tsx
/**
 * `db-inventory` — a strictly read-only catalogue collector.
 *
 * WHAT IT IS FOR. Before anything decides whether this database's privileges
 * are correct, somebody has to be able to say what they ARE. This is that step
 * and only that step: it opens one read-only transaction, reads the catalogue,
 * rolls back, disconnects, and publishes one canonical fact document bound to
 * the database, the instance, the moment and the source revision it came from.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It emits no PASS, no FAIL and no policy verdict of any kind. It ends with
 * `INVENTORY COMPLETE — NO VERDICT`, which is a statement about the collection
 * having finished, not about the database being acceptable. It never issues
 * `SET ROLE`, never writes, never migrates, never grants and never revokes.
 * Enforcement is a separate slice, and keeping it separate is what makes it
 * safe to point this at a real-money production database.
 *
 * ── THE CREDENTIAL ──────────────────────────────────────────────────────────
 *
 * One variable, `VERIFY_INVENTORY_DATABASE_URL`, and no fallback. Not
 * `DATABASE_URL`, not `AGENT_DATABASE_URL`, not `TEST_DATABASE_URL`, not
 * `BOOTSTRAP_DATABASE_URL`, not anything generic. A fallback chain is how a
 * tool aimed at an inspection replica ends up connected to the live book
 * because a shell happened to export something — and CLAUDE.md actively
 * encourages exporting `DATABASE_URL`. Requiring a name that exists for no
 * other purpose means the operator has to say, explicitly and separately,
 * "inventory this". The URL is never printed, logged, serialized or hashed, and
 * the endpoint recorded in the artifact is asked of the SERVER rather than
 * parsed out of the URL, so there is no path by which a user name or password
 * reaches the evidence file.
 *
 * ── ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER ───────────────────────────
 *
 *   1. Parse and validate arguments (mode, absolute output, MANDATORY run id)
 *   2. Check the output directory is private (0700) and the artifact absent  ─┐
 *   3. Read the credential                                                    │
 *   4. Capture the repository revision through the read-only seam            ─┘
 *      — every refusal above happens BEFORE a client object exists, so a
 *        malformed invocation cannot reach the network at all.
 *   5. Construct the client, connect
 *   6. `BEGIN TRANSACTION READ ONLY` — the FIRST statement on the session, so
 *      there is no window in which a non-read-only statement could be sent.
 *   7. Prove `transaction_read_only = on` from inside the session, rather than
 *      trusting that step 6 was honoured.
 *   8. Prove the database and BOTH `current_user` and `session_user`.
 *   9. Prove inspection authority with capability probes — see PROBE_QUERIES.
 *  10. Read. SELECT only.
 *  11. ONE centralized cleanup: one ROLLBACK attempt, one `end()` attempt.
 *  12. Only if collection AND cleanup both succeeded, publish the artifact.
 *
 * Publishing last is deliberate: an artifact on disk means the session was
 * closed cleanly. There is no partial artifact and no artifact at all on
 * failure.
 */

import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '../src/pool.js'
import {
  EXPECTED_DATABASE,
  EXPECTED_PRINCIPAL,
  INVENTORY_QUERIES,
  PROBE_QUERIES,
  SERVER_BINDING_QUERY,
  SESSION_IDENTITY_QUERY,
} from '../src/inventory-queries.js'
import type { ProbeRow, ServerBindingRow, SessionIdentityRow } from '../src/inventory-queries.js'
import { buildFactDocument, canonicalJson, markComplete } from '../src/inventory-facts.js'

export const COMPLETE_MESSAGE = 'INVENTORY COMPLETE — NO VERDICT'
export const INSUFFICIENT_AUTHORITY_MESSAGE =
  'INVENTORY INCOMPLETE — INSUFFICIENT INSPECTION AUTHORITY'

const CREDENTIAL_VARIABLE = 'VERIFY_INVENTORY_DATABASE_URL'
const BEGIN_STATEMENT = 'BEGIN TRANSACTION READ ONLY'
const ROLLBACK_STATEMENT = 'ROLLBACK'

/** The output directory must be exactly this: owner-only, no group, no world. */
const REQUIRED_DIRECTORY_MODE = 0o700
const REQUIRED_ARTIFACT_MODE = 0o600

/**
 * Variables this CLI must never read.
 *
 * Listed rather than merely "not read" so the prohibition is testable: a test
 * sets every one of them to a URL that would fail loudly if used, and asserts
 * the run still refuses for want of the one variable that matters.
 */
export const FORBIDDEN_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([
  'DATABASE_URL',
  'AGENT_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_RUNTIME_DATABASE_URL',
  'BOOTSTRAP_DATABASE_URL',
  'CLAIM_WRITER_DATABASE_URL',
  'PGDATABASE',
  'PGHOST',
])

// ── Exit contract ───────────────────────────────────────────────────────────
//
// TWO FAILURE CODES, AND THE DIFFERENCE MATTERS TO A HUMAN. Exit 2 means the
// collector REFUSED: the invocation was wrong, the credential was absent, the
// session was not what it must be, or it could not prove it sees the whole
// catalogue. Nothing was read and nothing is wrong with the tool — an operator
// fixes the invocation or the grant and runs it again. Exit 1 means something
// BROKE: a query, the connection, the filesystem, the collector itself. That is
// a bug or an outage, and it needs a different person and a different response.
// Collapsing them into one non-zero code is what makes a scheduled evidence run
// impossible to triage without reading the log.

export const EXIT_COMPLETE = 0
export const EXIT_FAILURE = 1
export const EXIT_REFUSED = 2

/** A refusal raised before any client is constructed. */
export class InventoryRefusal extends Error {
  readonly exitCode = EXIT_REFUSED
  constructor(message: string) {
    super(message)
    this.name = 'InventoryRefusal'
  }
}

/** The session is not the one this collector may read. */
export class UnsafeSessionError extends Error {
  readonly exitCode = EXIT_REFUSED
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSessionError'
  }
}

/** Fail-closed: the session could not prove it sees the whole catalogue. */
export class InsufficientInspectionAuthority extends Error {
  readonly exitCode = EXIT_REFUSED
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`${INSUFFICIENT_AUTHORITY_MESSAGE}: ${detail}`, options)
    this.name = 'InsufficientInspectionAuthority'
  }
}

/** The collection succeeded and the session would not close. No artifact. */
export class SessionCleanupError extends Error {
  readonly exitCode = EXIT_FAILURE
  constructor(errors: readonly Error[]) {
    super(
      'The inventory was collected but the session did not close cleanly, so no artifact was ' +
      `published: ${errors.map(e => e.message).join('; ')}`,
    )
    this.name = 'SessionCleanupError'
  }
}

export function exitCodeFor(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode
  return typeof code === 'number' ? code : EXIT_FAILURE
}

// ── Injectable seams ────────────────────────────────────────────────────────

/** The narrowest client shape this CLI uses. Structural, so a test can supply
 *  its own without a driver — and so nothing here can reach for a `pg` API that
 *  writes. */
export interface InventoryClient {
  connect(): Promise<void>
  query(text: string): Promise<{ rows: unknown[] }>
  end(): Promise<void>
}

/**
 * The filesystem operations publication needs, injectable.
 *
 * WHY. The publication contract has failure modes that matter — an exclusive
 * create that loses the race, a write that fails, an fsync that fails, a rename
 * that fails, a directory fsync that fails — and every one of them must leave
 * no `complete: true` artifact and no temporary residue. Proving that on the
 * real filesystem would mean filling a disk or revoking permissions on a live
 * host mid-test. Injecting the seam lets each failure be provoked exactly once,
 * deterministically, with nothing outside the test's own temporary directory
 * ever touched.
 */
export interface ArtifactFs {
  statSync: (path: string) => { isDirectory(): boolean; mode: number }
  existsSync: (path: string) => boolean
  openSync: (path: string, flags: string, mode?: number) => number
  /**
   * Byte-oriented, offset-aware, and its RETURN VALUE IS LOAD-BEARING.
   *
   * `write(2)` is permitted to write fewer bytes than asked and report success.
   * The previous signature took a string and discarded the count, so a short
   * write produced a truncated file that was then fsynced, published and marked
   * `complete: true` — a partial map of the database's privileges, indistinguishable
   * from a whole one. Buffers and byte offsets rather than strings and character
   * counts, because a UTF-8 payload with any multi-byte character (this file's
   * own em dashes reach the artifact through error text) has more bytes than
   * characters, and resuming at a character index would corrupt it.
   */
  writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number
  fsyncSync: (fd: number) => void
  closeSync: (fd: number) => void
  /** Atomic create-if-absent. Fails EEXIST rather than replacing. */
  linkSync: (existing: string, created: string) => void
  unlinkSync: (path: string) => void
  chmodSync: (path: string, mode: number) => void
  rmSync: (path: string, options: { force: boolean }) => void
}

const DEFAULT_FS: ArtifactFs = {
  statSync: (path) => nodeFs.statSync(path),
  existsSync: (path) => nodeFs.existsSync(path),
  openSync: (path, flags, mode) => nodeFs.openSync(path, flags, mode),
  writeSync: (fd, buffer, offset, length) => nodeFs.writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => nodeFs.fsyncSync(fd),
  closeSync: (fd) => nodeFs.closeSync(fd),
  linkSync: (existing, created) => nodeFs.linkSync(existing, created),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
  chmodSync: (path, mode) => nodeFs.chmodSync(path, mode),
  rmSync: (path, options) => nodeFs.rmSync(path, options),
}

/**
 * Capture the source revision this artifact was produced by, read-only.
 *
 * Implemented by READING `.git`, not by spawning `git`: no subprocess, no
 * dependence on a `git` binary or on the process's working directory, and no
 * possibility of a write. The seam exists so tests can supply a fixed revision
 * (the artifact must be byte-stable) and provoke the failure path without
 * disturbing the repository.
 */
export type ReadRepositoryHead = () => string

/**
 * A Git object name: 40 lower-case hex digits (SHA-1) or 64 (SHA-256).
 *
 * ONE function, used for the detached HEAD, for a loose ref's contents and for
 * a packed-refs line alike. Before this, only the detached case was checked, so
 * a `refs/heads/main` file containing an abbreviated id, an uppercase id, a
 * branch name, an error message or nothing at all was copied straight into the
 * artifact's `repository_head` and published as the binding — an evidence file
 * confidently attesting to a revision that does not exist.
 *
 * SHA-256 repositories are admitted because Git has them: a repository created
 * with `extensions.objectFormat = sha256` has 64-character object names, and
 * refusing those would be the same class of latent defect being fixed here.
 * Nothing in between is accepted — an abbreviated id is not a valid object
 * name, it is a prefix that only means something to a repository that can
 * expand it, and the artifact must not record a value nobody else can resolve.
 */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function assertObjectId(value: string, source: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value
    throw new Error(
      `@common/db inventory: ${source} is not a Git object name ("${shown}"); the artifact ` +
      'would claim a revision that cannot be resolved. Refusing.',
    )
  }
  return value
}

/**
 * Validate a symbolic ref name BEFORE it is joined to a filesystem path.
 *
 * `HEAD` is a file whose contents decide which path this process opens next.
 * Joining `ref: ../../../../etc/passwd` — or anything else a corrupted,
 * truncated or hostile HEAD might hold — to the Git directory walks straight
 * out of the repository, and whatever came back would be validated only as
 * "some string" and then published as the source revision. The rules below are
 * `git check-ref-format`'s, kept deliberately strict: this resolver needs to
 * read branch refs, not to accept everything Git tolerates.
 *
 *   must begin `refs/`      — that is where a symbolic HEAD always points, and
 *                             it also forecloses an absolute path outright.
 *   at least two components — `refs/heads/main`, never bare `refs`.
 *   no empty component, no `.`, no `..`, no component starting with `.`
 *   no backslash            — a path separator on some platforms, never part of
 *                             a ref name.
 *   no NUL, no control char, no space
 *   none of ~ ^ : ? * [ \   — Git's own forbidden set, plus `@{` and `.lock`,
 *                             so a name Git could never have written is refused
 *                             rather than turned into an open(2).
 */
const FORBIDDEN_REF_CHARACTERS = /[\0-\x20~^:?*[\\\x7f]/

function assertRefName(ref: string): string {
  const bad = (why: string): never => {
    throw new Error(`@common/db inventory: HEAD names an unusable ref ("${ref}"): ${why}. Refusing.`)
  }
  if (!ref) bad('it is empty')
  if (ref.length > 255) bad('it is implausibly long')
  if (FORBIDDEN_REF_CHARACTERS.test(ref)) bad('it contains a character no Git ref may hold')
  if (ref.includes('@{')) bad('it contains "@{"')
  if (ref.endsWith('.lock')) bad('it ends with ".lock"')
  if (ref.startsWith('/')) bad('it is an absolute path')
  if (!ref.startsWith('refs/')) bad('a symbolic HEAD must point inside refs/')
  const components = ref.split('/')
  if (components.length < 3) bad('it has too few components to be a ref')
  for (const component of components) {
    if (component === '') bad('it has an empty path component')
    if (component === '.' || component === '..') bad('it contains a traversal component')
    if (component.startsWith('.')) bad('a component begins with a dot')
  }
  return ref
}

/** The read-only filesystem surface HEAD resolution needs. */
export interface RepositoryFs {
  existsSync: (path: string) => boolean
  statSync: (path: string) => { isDirectory(): boolean }
  readFileSync: (path: string, encoding: 'utf-8') => string
}

const DEFAULT_REPOSITORY_FS: RepositoryFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  statSync: (path) => nodeFs.statSync(path),
  readFileSync: (path, encoding) => nodeFs.readFileSync(path, encoding),
}

/**
 * Resolve `.git`, which is not always a directory.
 *
 * In a LINKED WORKTREE — `git worktree add`, which is how a reviewer or a CI job
 * checks this repository out beside an existing clone — `.git` is a FILE
 * containing `gitdir: <path>`, and that path is a per-worktree directory holding
 * its own `HEAD` and a `commondir` pointer back to the real repository. Treating
 * `.git` as a directory there fails outright, and the artifact is unbound: the
 * run dies at step 4 with "no .git found", in the one situation where an
 * inventory is most likely to be taken from a scratch checkout.
 *
 * Both paths inside the metadata may be relative, and are resolved against the
 * file or directory that named them, exactly as Git does.
 */
function resolveGitDirectories(
  startDirectory: string,
  fs: RepositoryFs,
): { gitDirectory: string; commonDirectory: string } {
  let directory = startDirectory
  let dotGit: string | null = null
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(directory, '.git')
    if (fs.existsSync(candidate)) { dotGit = candidate; break }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (!dotGit) {
    throw new Error('@common/db inventory: cannot bind the artifact — no .git found above this module.')
  }

  let gitDirectory = dotGit
  if (!fs.statSync(dotGit).isDirectory()) {
    const contents = fs.readFileSync(dotGit, 'utf-8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(contents)
    if (!match) {
      throw new Error(
        `@common/db inventory: ${dotGit} is a file but does not name a gitdir; the artifact ` +
        'would be unbound. Refusing.',
      )
    }
    gitDirectory = resolve(dirname(dotGit), match[1].trim())
    if (!fs.existsSync(gitDirectory)) {
      throw new Error(
        `@common/db inventory: ${dotGit} points at ${gitDirectory}, which does not exist.`,
      )
    }
  }

  // `commondir` exists only in a linked worktree's git directory. Its contents
  // locate the ORIGINAL repository, where the branch refs actually live — a
  // worktree's own git directory holds HEAD and index but not refs/heads.
  let commonDirectory = gitDirectory
  const commonDirFile = join(gitDirectory, 'commondir')
  if (fs.existsSync(commonDirFile)) {
    const raw = fs.readFileSync(commonDirFile, 'utf-8').trim()
    if (!raw) {
      throw new Error(`@common/db inventory: ${commonDirFile} is empty; the artifact would be unbound.`)
    }
    commonDirectory = resolve(gitDirectory, raw)
    if (!fs.existsSync(commonDirectory)) {
      throw new Error(
        `@common/db inventory: ${commonDirFile} points at ${commonDirectory}, which does not exist.`,
      )
    }
  }
  return { gitDirectory, commonDirectory }
}

export function defaultReadRepositoryHead(
  startDirectory: string = dirname(fileURLToPath(import.meta.url)),
  fs: RepositoryFs = DEFAULT_REPOSITORY_FS,
): string {
  const { gitDirectory, commonDirectory } = resolveGitDirectories(startDirectory, fs)

  const head = fs.readFileSync(join(gitDirectory, 'HEAD'), 'utf-8').trim()
  // DETACHED HEAD: the file holds the object name itself. A worktree checked out
  // at a tag or a specific commit — which is how an evidence run SHOULD be
  // pinned — has no branch ref to follow.
  // `ref:` rather than `ref: ` — a HEAD whose ref name is empty or oddly spaced
  // is a malformed SYMBOLIC ref, and saying so beats reporting it as a bad
  // object id, which is what a stricter prefix test would do.
  if (!head.startsWith('ref:')) {
    return assertObjectId(head, 'HEAD')
  }

  // VALIDATED BEFORE IT BECOMES A PATH. Everything below joins `ref` to a
  // directory and opens the result; the check has to happen first, not after
  // the read, or a malformed HEAD decides which file this process reads.
  const ref = assertRefName(head.slice('ref:'.length).trim())

  // The per-worktree directory first (a worktree may hold its own refs), then
  // the common directory, which is where refs/heads/* actually lives.
  for (const base of [gitDirectory, commonDirectory]) {
    const looseRef = join(base, ref)
    if (fs.existsSync(looseRef)) {
      return assertObjectId(fs.readFileSync(looseRef, 'utf-8').trim(), `the loose ref ${ref}`)
    }
  }
  for (const base of [commonDirectory, gitDirectory]) {
    const packed = join(base, 'packed-refs')
    if (!fs.existsSync(packed)) continue
    for (const line of fs.readFileSync(packed, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue
      const [sha, name] = trimmed.split(/\s+/)
      if (name === ref && sha) {
        return assertObjectId(sha, `the packed ref ${ref}`)
      }
    }
  }
  throw new Error(`@common/db inventory: cannot resolve ${ref}; the artifact would be unbound.`)
}

export interface InventoryDeps {
  env?: Readonly<Record<string, string | undefined>>
  /** Injected seam. The default is the canonical guarded factory in src/pool.ts;
   *  tests pass their own so the suite never constructs a real connection. */
  createClient?: (connectionString: string) => InventoryClient
  now?: () => Date
  fs?: ArtifactFs
  readRepositoryHead?: ReadRepositoryHead
}

export interface InventoryOutcome {
  message: string
  artifactPath: string
  runId: string
  /** Every statement sent, in order — including a ROLLBACK that then rejected. */
  statements: string[]
  rollbackAttempts: number
  endAttempts: number
}

// ── Argument parsing ────────────────────────────────────────────────────────

export interface ParsedArguments {
  mode: 'inventory'
  output: string
  runId: string
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let mode: string | null = null
  let output: string | null = null
  let runId: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const takeValue = (): string => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new InventoryRefusal(`${flag} requires a value.`)
      }
      i += 1
      return value
    }
    switch (flag) {
      case '--mode':   mode   = takeValue(); break
      case '--output': output = takeValue(); break
      case '--run-id': runId  = takeValue(); break
      default:
        throw new InventoryRefusal(
          `Unknown argument "${flag}". This CLI accepts only --mode, --output and --run-id.`,
        )
    }
  }

  // MODE IS MANDATORY AND HAS NO DEFAULT. A default would mean a future
  // enforcement mode could be reached by an invocation that never named one —
  // and the whole point of this slice is that inventory and enforcement are
  // separate acts, each requested out loud.
  if (mode === null) {
    throw new InventoryRefusal('--mode is required. The only mode this build implements is "inventory".')
  }
  if (mode !== 'inventory') {
    throw new InventoryRefusal(
      `--mode "${mode}" is not implemented. This build collects inventory only and issues no verdict.`,
    )
  }
  if (output === null) {
    throw new InventoryRefusal('--output is required: an absolute path for the fact document.')
  }
  // A relative path resolves against the process's working directory, which the
  // operator does not necessarily control when this runs from a script or a
  // scheduler. An absolute path is the only one that means the same thing to
  // the person who typed it and the process that writes it.
  if (!isAbsolute(output)) {
    throw new InventoryRefusal(`--output "${output}" is relative. Give an absolute path.`)
  }
  // THE RUN ID IS MANDATORY AND IS NEVER GENERATED. A generated default would
  // make every run equally well-attested and none of them traceable: the id is
  // what ties this artifact to the change, ticket or maintenance window it was
  // taken for, and only the operator knows that.
  if (runId === null) {
    throw new InventoryRefusal(
      '--run-id is required. It binds the artifact to the operation it was taken for, and is ' +
      'never generated — a machine-made id would attest to nothing.',
    )
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new InventoryRefusal(
      `--run-id "${runId}" is not a plain identifier. Use letters, digits, dot, dash or underscore.`,
    )
  }
  return { mode: 'inventory', output, runId }
}

// ── Preconditions that must hold before a client exists ─────────────────────

/**
 * The evidence directory must be PRIVATE, exactly 0700.
 *
 * An inventory artifact is a complete map of who may read and write what in a
 * real-money database. Writing that into a directory another account can list
 * or traverse hands out reconnaissance, and 0600 on the file does not help if
 * the directory is 0755 — the name, size and mtime are still readable, and a
 * group-writable directory lets someone else replace the file entirely. The
 * check is for the exact mode rather than "no world bits", because 0750 is
 * still a group that did not need to know.
 */
function assertOutputDirectoryPrivate(output: string, fs: ArtifactFs): void {
  const directory = dirname(output)
  let info: { isDirectory(): boolean; mode: number }
  try {
    info = fs.statSync(directory)
  } catch {
    throw new InventoryRefusal(
      `The output directory ${directory} does not exist or cannot be inspected. Create it first.`,
    )
  }
  if (!info.isDirectory()) {
    throw new InventoryRefusal(`The output path's parent ${directory} is not a directory.`)
  }
  const mode = info.mode & 0o777
  if (mode !== REQUIRED_DIRECTORY_MODE) {
    throw new InventoryRefusal(
      `The output directory ${directory} is mode ${mode.toString(8).padStart(4, '0')}; an ` +
      'inventory artifact maps every privilege in the database and must land in a directory ' +
      'that is exactly 0700. Run: chmod 700 ' + directory,
    )
  }
}

/** Never silently overwrite evidence. */
function assertArtifactAbsent(output: string, fs: ArtifactFs): void {
  if (fs.existsSync(output)) {
    throw new InventoryRefusal(
      `${output} already exists. Evidence is never overwritten silently — choose another ` +
      '--output, or move the existing artifact aside deliberately.',
    )
  }
}

function readCredential(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env[CREDENTIAL_VARIABLE]
  if (raw === undefined || raw.trim() === '') {
    // The message names the variable and NOTHING else. It must not hint at what
    // other variables happen to be set — that is a map of the operator's
    // environment printed into a log.
    throw new InventoryRefusal(
      `${CREDENTIAL_VARIABLE} is not set. This CLI reads that variable and no other, and ` +
      'never falls back to a generic database URL.',
    )
  }
  return raw.trim()
}

// ── The one cleanup path ────────────────────────────────────────────────────

interface Lifecycle {
  rollbackAttempts: number
  endAttempts: number
  errors: Error[]
}

/**
 * Close a connected session. ONE implementation, used by every connected path.
 *
 * Three properties, each of which was wrong before and each of which is a real
 * failure mode:
 *
 *   THE ATTEMPT IS COUNTED BEFORE IT IS AWAITED. Counting after the await means
 *   a rejected call is not counted at all, so "exactly one ROLLBACK" silently
 *   becomes "exactly one ROLLBACK that happened to succeed" — and the statement
 *   log loses the very statement whose failure is being investigated.
 *
 *   A REJECTED ROLLBACK NEVER SKIPS THE `end()`. If the rollback throws and the
 *   close is in the same `try`, the connection leaks: on a production database
 *   that is a held session, an open snapshot and a blocked VACUUM, caused by
 *   the read-only inspector.
 *
 *   BOTH FAILURES ARE COLLECTED, NEITHER IS THROWN FROM HERE. The caller
 *   decides what they mean, because that differs: after a primary error they
 *   are extra diagnosis, and after a successful collection they are themselves
 *   the failure.
 */
async function closeSession(
  client: InventoryClient,
  lifecycle: Lifecycle,
  statements: string[],
): Promise<void> {
  lifecycle.rollbackAttempts += 1
  statements.push(ROLLBACK_STATEMENT)
  try {
    await client.query(ROLLBACK_STATEMENT)
  } catch (err) {
    lifecycle.errors.push(asError(err, 'ROLLBACK failed'))
  }

  lifecycle.endAttempts += 1
  try {
    await client.end()
  } catch (err) {
    lifecycle.errors.push(asError(err, 'closing the connection failed'))
  }
}

function asError(err: unknown, context: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const wrapped = new Error(`${context}: ${message}`)
  wrapped.name = 'CleanupError'
  return wrapped
}

/**
 * Append cleanup failures to the primary diagnosis WITHOUT replacing it.
 *
 * The primary error is why the inventory stopped; the cleanup errors are what
 * else went wrong on the way out. Re-throwing a cleanup error instead would
 * leave the operator debugging a disconnect that was itself a symptom — and,
 * because the exit code is carried on the error class, would also silently
 * reclassify a refusal (exit 2) as a breakage (exit 1).
 */
function augmentWithCleanupErrors(primary: unknown, errors: readonly Error[]): unknown {
  if (errors.length === 0) return primary
  if (primary instanceof Error) {
    primary.message = `${primary.message}\n  cleanup also failed: ${errors.map(e => e.message).join('; ')}`
    return primary
  }
  return primary
}

// ── The run ─────────────────────────────────────────────────────────────────

export async function runInventory(
  argv: readonly string[],
  deps: InventoryDeps = {},
): Promise<InventoryOutcome> {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const fs = deps.fs ?? DEFAULT_FS
  const readRepositoryHead = deps.readRepositoryHead ?? (() => defaultReadRepositoryHead())

  const args = parseArguments(argv)
  assertOutputDirectoryPrivate(args.output, fs)
  assertArtifactAbsent(args.output, fs)
  const connectionString = readCredential(env)
  const repositoryHead = readRepositoryHead()

  const collectedAt = now().toISOString()
  const statements: string[] = []
  const lifecycle: Lifecycle = { rollbackAttempts: 0, endAttempts: 0, errors: [] }
  const client = (deps.createClient ?? defaultCreateClient)(connectionString)

  let connected = false
  let primary: unknown = null
  let document: Record<string, unknown> | null = null

  const send = async (sql: string): Promise<unknown[]> => {
    assertPermittedStatement(sql)
    statements.push(sql)
    const result = await client.query(sql)
    return result.rows
  }

  try {
    await client.connect()
    connected = true

    // FIRST statement on the session. Nothing precedes it, so there is no
    // moment at which this connection could have written.
    await send(BEGIN_STATEMENT)

    const session = (await send(SESSION_IDENTITY_QUERY.sql))[0] as SessionIdentityRow | undefined
    if (!session) throw new Error('The session identity query returned no row.')
    assertSessionIsSafe(session)

    const probes = await runProbes(send)

    const server = (await send(SERVER_BINDING_QUERY.sql))[0] as ServerBindingRow | undefined
    if (!server) throw new Error('The server binding query returned no row; the artifact would be unbound.')

    const raw: Record<string, unknown[]> = {}
    for (const query of INVENTORY_QUERIES) {
      raw[query.id] = await send(query.sql)
    }

    document = buildFactDocument({
      run_id: args.runId,
      collected_at: collectedAt,
      repository_head: repositoryHead,
      session,
      server,
      probes,
      raw,
    })
  } catch (err) {
    primary = err
  }

  // ONE cleanup path, taken by success and failure alike. Never duplicated.
  if (connected) await closeSession(client, lifecycle, statements)

  if (primary !== null) throw augmentWithCleanupErrors(primary, lifecycle.errors)
  // A collection that succeeded but would not close cleanly does NOT publish.
  // The rows may be fine; the claim "this session was released" would not be,
  // and that claim is part of what an artifact on disk asserts.
  if (lifecycle.errors.length > 0) throw new SessionCleanupError(lifecycle.errors)
  if (document === null) throw new Error('Internal: collection produced no document and no error.')

  publishArtifact(args.output, canonicalJson(markComplete(document)), fs)

  return {
    message: COMPLETE_MESSAGE,
    artifactPath: args.output,
    runId: args.runId,
    statements,
    rollbackAttempts: lifecycle.rollbackAttempts,
    endAttempts: lifecycle.endAttempts,
  }
}

/**
 * Run every capability probe, before a single inventory query.
 *
 * A denial is an ERROR from PostgreSQL, not a `false`: `has_table_privilege`
 * raises on an object the session cannot see and on a role that does not exist.
 * A missing row is just as disqualifying — it means the probe found no
 * non-self-owned subject to ask about, which is indistinguishable from a
 * filtered view of the catalogue. Both fail closed.
 */
async function runProbes(
  send: (sql: string) => Promise<unknown[]>,
): Promise<Record<string, string>> {
  const probes: Record<string, string> = {}
  for (const probe of PROBE_QUERIES) {
    let rows: unknown[]
    try {
      rows = await send(probe.sql)
    } catch (err) {
      throw new InsufficientInspectionAuthority(
        `probe ${probe.id} could not be evaluated`, { cause: err },
      )
    }
    const row = rows[0] as ProbeRow | undefined
    if (!row) {
      throw new InsufficientInspectionAuthority(
        `probe ${probe.id} found no non-self subject to ask about; an empty catalogue and a ` +
        'filtered view are indistinguishable from here.',
      )
    }
    if (row.observed !== 'true' && row.observed !== 'false') {
      throw new InsufficientInspectionAuthority(
        `probe ${probe.id} returned ${String(row.observed)} rather than a boolean; the question ` +
        'was not answerable, so the inventory would be silently incomplete.',
      )
    }
    probes[probe.id] = `${row.observed} (${probe.id === 'probe_pg_has_role' ? 'role' : 'object'}: ${row.object_description}, subject: ${row.subject})`
  }
  return probes
}

/**
 * The permitted vocabulary, enforced at the point of sending.
 *
 * `inventory-queries.ts` already contains nothing else, but that is a property
 * of a file someone edits. This is the check that holds even if a future edit
 * introduces something that is not a read — the collector refuses to send it
 * rather than discovering the problem in a production write.
 */
function assertPermittedStatement(sql: string): void {
  if (sql === BEGIN_STATEMENT || sql === ROLLBACK_STATEMENT) return
  if (/^SELECT\b/.test(sql)) return
  throw new Error(
    `@common/db inventory: refusing to send a statement that is not SELECT, ` +
    `"${BEGIN_STATEMENT}" or "${ROLLBACK_STATEMENT}".`,
  )
}

/**
 * Prove, from inside the session, that it is the session we meant to open.
 *
 * All four checks are separate on purpose. Read-only says the transaction
 * cannot write; the database name says we are inspecting the right book; and
 * `current_user` and `session_user` are checked INDEPENDENTLY because `SET ROLE`
 * moves the first and not the second. Equal-and-expected is the only shape that
 * means "this is the migrator, and nothing has assumed another identity".
 */
export function assertSessionIsSafe(session: SessionIdentityRow): void {
  if (session.transaction_read_only !== 'on') {
    throw new UnsafeSessionError(
      `The session reports transaction_read_only=${session.transaction_read_only}. ` +
      'A read-only transaction was requested and not granted; refusing to read further.',
    )
  }
  if (session.current_database !== EXPECTED_DATABASE) {
    throw new UnsafeSessionError(
      `Connected to database "${session.current_database}", expected "${EXPECTED_DATABASE}".`,
    )
  }
  if (session.session_user !== EXPECTED_PRINCIPAL) {
    throw new UnsafeSessionError(
      `session_user is "${session.session_user}", expected "${EXPECTED_PRINCIPAL}".`,
    )
  }
  if (session.current_user !== EXPECTED_PRINCIPAL) {
    throw new UnsafeSessionError(
      `current_user is "${session.current_user}", expected "${EXPECTED_PRINCIPAL}". ` +
      'Something assumed another role on this session; the inventory would describe that ' +
      "role's view rather than the deployment identity's.",
    )
  }
}

/**
 * Write the whole payload. `write(2)` is allowed to do less than it was asked.
 *
 * A short write is not an error at the syscall level — it returns a smaller
 * count and success — so ignoring the count is how a truncated file gets
 * fsynced, published and stamped `complete: true`. The loop resumes at a BYTE
 * offset into a Buffer, never a character index into a string: the canonical
 * payload is UTF-8 and any multi-byte character (the em dashes in this
 * collector's own messages reach the artifact through error text) makes the two
 * disagree, so resuming by character would splice the file at the wrong place
 * and still report success.
 *
 * Anything the platform cannot have meant fails closed rather than looping:
 * zero progress (an endless loop that never terminates), a negative count, a
 * count larger than what remained, a non-integer. None of these can happen on a
 * sane filesystem, which is exactly why an implementation that silently
 * tolerated them would never be exercised until the day it mattered.
 *
 * The encoding happens HERE, once, so there is exactly one representation of
 * the payload in play and no way for a caller to hand in a string alongside it.
 */
function writeAllBytes(fs: ArtifactFs, handle: number, contents: string): void {
  const payload = Buffer.from(contents, 'utf-8')
  let written = 0
  while (written < payload.length) {
    const remaining = payload.length - written
    const n = fs.writeSync(handle, payload, written, remaining)
    if (!Number.isInteger(n) || n <= 0 || n > remaining) {
      throw new Error(
        `@common/db inventory: refusing to publish a possibly truncated artifact — writing ` +
        `${payload.length} bytes reported ${String(n)} after ${written}, which is not forward ` +
        'progress within the remaining ' + remaining + ' bytes.',
      )
    }
    written += n
  }
}

/**
 * Publish the document so a reader never sees a half-written one, a failed
 * publication leaves nothing at all, and a concurrent winner is never replaced.
 *
 * ── THE EXACT SEQUENCE, AND WHAT EACH STEP BUYS ─────────────────────────────
 *
 *   1. `openSync(temp, 'wx', 0600)` — a UNIQUELY named temporary in the SAME
 *      directory. `wx` is O_EXCL: never adopt a file already sitting there,
 *      which is how a stale or planted temp file gets published as evidence.
 *      Same directory because both `link` and `rename` are confined to one
 *      filesystem.
 *   2. `writeAllBytes` — every byte, loop-verified. See above.
 *   3. `fsync(file)` — the CONTENTS are durable before any name points at them.
 *      Do this after linking and a crash can leave a correctly-named empty
 *      artifact.
 *   4. `close`, then `chmod 0600` — `umask` can only remove bits from the
 *      creation mode, never add them, so this is belt-and-braces rather than
 *      load-bearing; it costs nothing and states the intent in the file itself.
 *   5. `link(temp, output)` — THE PUBLICATION. This is the only step that makes
 *      the artifact visible under its final name, and `link(2)` fails with
 *      EEXIST if the destination exists. It is atomic create-if-absent.
 *      `existsSync` followed by `rename` is NOT: `rename(2)` replaces its
 *      destination unconditionally, so anything created in the window between
 *      the check and the call is silently destroyed. That window is not
 *      hypothetical here — two operators, or an operator and a scheduled run,
 *      pointed at the same evidence path is exactly the situation the
 *      no-overwrite rule exists for, and the loser would have overwritten the
 *      winner's artifact while both reported success.
 *   6. `fsync(directory)` — the new NAME is durable. Without it the link can be
 *      lost on power failure even though the bytes survived.
 *   7. `unlink(temp)` — drop the second name. The inode now has exactly one
 *      link, the published artifact, and the directory holds no residue.
 *   8. `fsync(directory)` — the removal is durable too, so a crash cannot
 *      resurrect the temporary name.
 *
 * ── FAILURE CLEANUP ─────────────────────────────────────────────────────────
 *
 *   Before the link succeeds — remove the temporary, leave the destination
 *   ALONE. On EEXIST the destination belongs to somebody else: this collector
 *   never created it and must not delete, truncate or replace it. The run ends
 *   as a REFUSAL (exit 2), which is what "that artifact already exists" is.
 *
 *   After the link succeeded — the destination is ours, created by this call,
 *   so both names are removed. A `complete: true` document whose publication did
 *   not complete must not survive, and here it cannot be mistaken for anyone
 *   else's.
 */
function publishArtifact(output: string, contents: string, fs: ArtifactFs): void {
  const directory = dirname(output)
  const temporary = `${output}.${randomBytes(8).toString('hex')}.tmp`
  let linked = false

  const fsyncDirectory = (): void => {
    const handle = fs.openSync(directory, 'r')
    try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  }

  try {
    const handle = fs.openSync(temporary, 'wx', REQUIRED_ARTIFACT_MODE)
    try {
      writeAllBytes(fs, handle, contents)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.chmodSync(temporary, REQUIRED_ARTIFACT_MODE)

    try {
      fs.linkSync(temporary, output)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new InventoryRefusal(
          `${output} already exists. Evidence is never overwritten, and a concurrent run that ` +
          'reached this path first has been left byte-for-byte untouched. Choose another ' +
          '--output, or move the existing artifact aside deliberately.',
        )
      }
      throw err
    }
    linked = true
    fsyncDirectory()
    fs.unlinkSync(temporary)
    fsyncDirectory()
  } catch (err) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* the original error stands */ }
    // ONLY if this call created it. A destination we did not link is somebody
    // else's artifact and is not ours to remove.
    if (linked) {
      try { fs.rmSync(output, { force: true }) } catch { /* the original error stands */ }
    }
    throw err
  }
}

function defaultCreateClient(connectionString: string): InventoryClient {
  return createClient(connectionString) as unknown as InventoryClient
}

// ── Entry point ─────────────────────────────────────────────────────────────
//
// IMPORTING THIS MODULE MUST DO NOTHING. The tests import `runInventory`
// directly, and a module that ran on import would connect, write and exit the
// test runner. `bin/verify-architecture.ts` ends in a bare `process.exit` with
// no such guard; this file does not repeat that.

export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try {
    return nodeFs.realpathSync(argv1) === nodeFs.realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  runInventory(process.argv.slice(2))
    .then(outcome => {
      console.log(`artifact: ${outcome.artifactPath}`)
      console.log(`run id:   ${outcome.runId}`)
      console.log(`statements sent: ${outcome.statements.length} (SELECT / BEGIN READ ONLY / ROLLBACK only)`)
      console.log(COMPLETE_MESSAGE)
      process.exit(EXIT_COMPLETE)
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(exitCodeFor(err))
    })
}
