// LEGACY COPY - the one-time deployment-window copy of the legacy SQLite,
// JSONL and LanceDB stores into PostgreSQL.
//
// WHAT THIS REPLACES, AND WHY. `bin/migrate-from-sqlite.ts` and
// `bin/migrate-from-lance.ts` were two independently executing CLIs. Each took
// its target from `getPool()` - which resolves
// `(inTestRuntime() && TEST_DATABASE_URL) || DATABASE_URL`, so a copy could
// silently retarget under VITEST - and each opened its own transaction per
// source. Running both, or running the first without `--source`, could leave
// four sources committed and the fifth truncated-and-rolled-back, with nothing
// on disk recording that it happened. Neither imported the write-intent gate.
//
// So: ONE module owns the destination, ONE pool, ONE client, ONE transaction.
// The six adapters are given that client and cannot open, commit or abort
// anything. There is no path that reaches a destructive statement without
// passing every gate below, because there is only one path.
//
// FRESH-TARGET ONLY. The old header claimed idempotence "because TRUNCATE".
// That claim is withdrawn: a TRUNCATE that runs is a TRUNCATE that destroyed
// whatever was there, and "rerunnable" is not the same as "safe to point at a
// populated database". Every one of the 21 target tables must be EMPTY before
// the first destructive statement. Deterministic reproducibility is proved by
// copying twice onto two FRESH targets and comparing canonical manifests - not
// by rerunning onto a populated one.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { escapeIdentifier } from 'pg'

import { createPool, databaseNameOfRaw } from './pool.js'
import { requireExplicitPostgresUrl } from './credential-url.js'
import { recognizeManifest } from './inventory-facts.js'
import { CURRENT_V19_MANIFEST } from './inventory-queries.js'
import { withProductionWrite, assertPoolWriteAuthorized } from './write-intent.js'

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** The only credential this copy accepts. No fallback, by construction. */
export const CREDENTIAL_VAR = 'AI_CAPITAL_COPY_DATABASE_URL'
/** The immutable snapshot root. Never a repository path, never cwd. */
export const SOURCE_ROOT_VAR = 'AI_CAPITAL_COPY_SOURCE_ROOT'
/**
 * The snapshot's own record of WHICH COMMIT it was taken at.
 *
 * Specifically: the commit of the PARENT runtime repository whose gitlink pins
 * the capital-intelligence-ingestion submodule. It is NOT a version of the data
 * - SQLite, JSONL and LanceDB stores are runtime state and are versioned by
 * nothing - and it is NOT a commit "of every source". It identifies the code
 * and submodule pin the snapshot was taken against, which is what makes one
 * confirmation refer to one snapshot of one deployment.
 */
export const SOURCE_HEAD_FILE = 'SOURCE_HEAD'
/** The credential must name this role and no other. */
export const REQUIRED_CREDENTIAL_ROLE = 'ai_capital_migrator'
/** The role assumed for the copy window, via SET LOCAL ROLE. */
export const COPY_OWNER_ROLE = 'ai_capital_owner'
/** Migration ledger the target must be at. */
export const REQUIRED_MIGRATION_COUNT = 19

/**
 * Variables that must NOT be consulted. Named here so a test can assert the
 * module never reads them, and so a reviewer can see the list rather than infer
 * it from absence.
 */
export const FORBIDDEN_FALLBACK_VARS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_RUNTIME_DATABASE_URL',
  'BOOTSTRAP_DATABASE_URL',
  'DASHBOARD_DATABASE_URL',
  'PGDATABASE',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'LANCE_PATH',
] as const

/**
 * THE 21 TARGET TABLES, in FK-safe order: a child never precedes its parent, so
 * this order is valid for INSERT read top-down and for TRUNCATE read bottom-up.
 * The list is the single source of truth for the empty check, the truncation
 * and the verification - a table copied but absent here would never be checked.
 */
export const TARGET_TABLES = [
  'portfolio.positions',
  'portfolio.trade_log',
  'capital.watchlist',
  'capital.documents',
  'capital.fetch_log',
  'capital.short_interest',
  'capital.api_budget',
  'capital.pending_manual_input',
  'capital.chunks',
  'thesis.theses',
  'thesis.assumptions',
  'thesis.narratives',
  'thesis.proposals',
  'thesis.proposal_changes',
  'thesis.theme_memberships',
  'briefing.predictions',
  'briefing.qa',
  'graph.nodes',
  'graph.edges',
  'graph.proposals',
  'graph.proposal_edges',
] as const

/**
 * The THREE generated sequences behind the three serial columns.
 * `briefing.qa.id` is BIGSERIAL and was missed in an earlier pass; it is listed
 * here so that omission cannot recur silently.
 */
export const TARGET_SEQUENCES = [
  { sequence: 'portfolio.trade_log_id_seq', table: 'portfolio.trade_log', column: 'id' },
  { sequence: 'capital.fetch_log_id_seq', table: 'capital.fetch_log', column: 'id' },
  { sequence: 'briefing.qa_id_seq', table: 'briefing.qa', column: 'id' },
] as const

/**
 * Tables copied but held with NO runtime grant to any LOGIN role. They are
 * COLD-PRESERVED: retained data with no product consumer. Naming them is the
 * point - expanding runtime privilege is a separate, separately reviewed
 * decision and is explicitly not part of this slice.
 */
export const COLD_PRESERVED_TABLES = [
  'capital.api_budget',
  'briefing.qa',
  'thesis.theme_memberships',
  'graph.nodes',
  'graph.edges',
  'graph.proposals',
  'graph.proposal_edges',
] as const

// ---------------------------------------------------------------------------
// SHARED TYPES
// ---------------------------------------------------------------------------

/**
 * The narrow client surface an adapter is given. Deliberately NOT a PoolClient:
 * an adapter has no `release`, and nothing to call it on.
 */
export interface CopyClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

export interface TableResult {
  table: string
  rows: number
}

export interface CopyContext {
  /** The immutable snapshot root. Adapters resolve every path beneath it. */
  sourceRoot: string
}

export class CopyRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CopyRefused'
  }
}

/**
 * COMMIT DID NOT ANSWER, WHICH IS NOT THE SAME AS "NOTHING HAPPENED".
 *
 * A COMMIT response can be lost after the server has already committed - a
 * dropped connection, a killed backend, a network hiccup. The transaction may
 * therefore be durable even though the client saw an error. The earlier code
 * left `began` true, issued a ROLLBACK against a connection that may have had
 * no open transaction, and reported an ordinary failure: an operator reading
 * that would have concluded nothing was copied and rerun the copy onto a target
 * that was no longer fresh.
 *
 * So this is its own type, it carries the original error as `cause`, and NO
 * ROLLBACK is attempted after it. Cleanup still runs - release and pool.end -
 * but cleanup cannot resolve commit state and does not pretend to.
 */
export class CopyCommitOutcomeUnknown extends Error {
  readonly commitError: unknown
  constructor(commitError: unknown) {
    super(
      'COMMIT did not return a result, so the outcome is UNKNOWN. The target may ' +
      'already hold the copied rows. Inspect the target before doing anything else, ' +
      'and do not rerun the copy. Original COMMIT error: ' +
      (commitError instanceof Error ? commitError.message : String(commitError)),
      { cause: commitError },
    )
    this.name = 'CopyCommitOutcomeUnknown'
    this.commitError = commitError
  }
}

// ---------------------------------------------------------------------------
// INPUT RESOLUTION - explicit, or refused
// ---------------------------------------------------------------------------

/**
 * The credential. `requireExplicitPostgresUrl` already refuses an unset, blank,
 * whitespace-padded, wrongly-schemed or component-incomplete value, and pins
 * the role - so an `ai_capital_owner` or administrator credential is refused
 * here even though it would work.
 */
export function resolveCredential(env: NodeJS.ProcessEnv): string {
  return requireExplicitPostgresUrl(CREDENTIAL_VAR, env[CREDENTIAL_VAR], {
    user: REQUIRED_CREDENTIAL_ROLE,
  })
}

/**
 * The snapshot root. ABSOLUTE, EXISTING and CANONICAL, with no default.
 *
 * The tools this replaces derived every source path from
 * `join(process.cwd(), '..', '..')`, which is correct only when invoked exactly
 * one way and silently wrong otherwise. A relative root is REFUSED rather than
 * resolved against cwd, because resolving it would reintroduce the same
 * dependency under another name. A root that is not its own realpath is refused
 * too: a symlinked root can be repointed between the fingerprint and the read.
 */
export function resolveSourceRoot(env: NodeJS.ProcessEnv): string {
  const raw = env[SOURCE_ROOT_VAR]
  if (raw === undefined) {
    throw new CopyRefused(
      `${SOURCE_ROOT_VAR} is not set. The copy reads an immutable snapshot root ` +
      'supplied explicitly; it never derives source paths from process.cwd(), from ' +
      'the repository layout, or from a live data directory.',
    )
  }
  if (raw.trim() === '') {
    throw new CopyRefused(`${SOURCE_ROOT_VAR} is empty or whitespace-only.`)
  }
  if (raw !== raw.trim()) {
    throw new CopyRefused(
      `${SOURCE_ROOT_VAR} has leading or trailing whitespace. It is refused rather ` +
      'than trimmed, so the value validated is the value used.',
    )
  }
  if (!isAbsolute(raw)) {
    throw new CopyRefused(
      `${SOURCE_ROOT_VAR} must be an absolute path. A relative path would be ` +
      'resolved against process.cwd(), which is the defect this replaces.',
    )
  }
  if (!existsSync(raw)) {
    throw new CopyRefused(`${SOURCE_ROOT_VAR} does not exist: ${raw}`)
  }
  const real = realpathSync(raw)
  if (real !== raw) {
    throw new CopyRefused(
      `${SOURCE_ROOT_VAR} is not canonical (it resolves to ${real}). A symlinked ` +
      'root can be repointed between the fingerprint and the read; supply the real path.',
    )
  }
  if (!statSync(real).isDirectory()) {
    throw new CopyRefused(`${SOURCE_ROOT_VAR} is not a directory: ${real}`)
  }
  return real
}

/** Resolve a path beneath the snapshot root, refusing anything that escapes it. */
export function resolveUnderRoot(root: string, ...parts: string[]): string {
  const p = join(root, ...parts)
  const rel = relative(root, p)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new CopyRefused(`source path escapes the snapshot root: ${p}`)
  }
  return p
}

// ---------------------------------------------------------------------------
// SOURCE FINGERPRINTS
// ---------------------------------------------------------------------------
//
// TWO HASH CLASSES, DELIBERATELY. These are RAW byte hashes and answer exactly
// one question: did the snapshot change while we were reading it? They are
// taken before the copy and rechecked before COMMIT. They are NOT the
// cross-run comparison: SQLite page layout and Lance fragment layout vary with
// tool version, so equality across runs is proved with the canonical LOGICAL
// count manifest (canonicalCountManifest) instead - and see its own note: row
// counts are a tripwire, not a value proof.

export interface SourceFingerprint {
  path: string
  sha256: string
  bytes: number
}

function hashFile(path: string): SourceFingerprint {
  const buf = readFileSync(path)
  return {
    path,
    bytes: buf.byteLength,
    sha256: createHash('sha256').update(buf).digest('hex'),
  }
}


/**
 * Every file the copy may read, hashed. A LanceDB table is a directory tree, so
 * it is walked; SQLite and JSONL are single files. Ordering is by path, so the
 * manifest is stable across runs on the same snapshot.
 */
export function sourceFingerprints(root: string, paths: string[]): SourceFingerprint[] {
  const out: SourceFingerprint[] = []
  for (const p of paths) {
    // NOT `if (!existsSync(p)) continue`. Skipping a missing path is what let an
    // incomplete snapshot produce a digest that looked fine.
    let st
    try {
      st = lstatSync(p)
    } catch {
      throw new CopyRefused(`snapshot path is missing and cannot be fingerprinted: ${p}`)
    }
    if (st.isSymbolicLink()) throw new CopyRefused(`snapshot path is a symlink: ${p}`)
    if (st.isDirectory()) {
      for (const f of walkFilesStrict(root, p)) out.push(hashFile(f))
    } else if (st.isFile()) {
      out.push(hashFile(p))
    } else {
      throw new CopyRefused(`snapshot path is not a regular file or directory: ${p}`)
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

export function readSourceHead(root: string): string {
  const p = resolveUnderRoot(root, SOURCE_HEAD_FILE)
  if (!existsSync(p)) {
    throw new CopyRefused(
      `the snapshot has no ${SOURCE_HEAD_FILE}. The confirmation names the parent ` +
      'runtime commit whose gitlink pins the ingestion submodule; a snapshot that ' +
      'cannot say which commit it was taken at cannot be confirmed.',
    )
  }
  const head = readFileSync(p, 'utf-8').trim()
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new CopyRefused(`${SOURCE_HEAD_FILE} does not hold a 40-character commit id.`)
  }
  return head
}

export function fingerprintDigest(fps: SourceFingerprint[]): string {
  const h = createHash('sha256')
  for (const f of fps) h.update(`${f.path} ${f.sha256} ${f.bytes}\n`)
  return h.digest('hex')
}

/**
 * Which snapshot files each source group reads. The paths mirror the legacy
 * layout so an operator builds the snapshot by copying, not by renaming.
 */
export function snapshotPaths(root: string): Record<string, string[]> {
  return {
    portfolio: [resolveUnderRoot(root, 'apps/scenario-simulator/data/portfolio.db')],
    capital: [resolveUnderRoot(root, 'apps/capital-intelligence-ingestion/data/sqlite.db')],
    thesis: [resolveUnderRoot(root, 'apps/thesis-memory/data/thesis.db')],
    briefing: [
      resolveUnderRoot(root, 'apps/investment-analyst-agents/archive/predictions.jsonl'),
      resolveUnderRoot(root, 'apps/investment-analyst-agents/archive/qa.jsonl'),
    ],
    graph: [resolveUnderRoot(root, 'apps/dependency-graph-engine/data/graph.db')],
    lance: [resolveUnderRoot(root, 'apps/capital-intelligence-ingestion/data/lancedb')],
    // The head file is fingerprinted with everything else: a plan confirmed for
    // one snapshot must not authorise a snapshot whose head was edited after.
    head: [resolveUnderRoot(root, SOURCE_HEAD_FILE)],
  }
}

// ---------------------------------------------------------------------------
// SNAPSHOT COMPLETENESS
// ---------------------------------------------------------------------------

/** Exactly what a complete snapshot must contain. Nothing is optional. */
export const REQUIRED_SNAPSHOT_FILES = [
  'apps/scenario-simulator/data/portfolio.db',
  'apps/capital-intelligence-ingestion/data/sqlite.db',
  'apps/thesis-memory/data/thesis.db',
  'apps/dependency-graph-engine/data/graph.db',
  'apps/investment-analyst-agents/archive/predictions.jsonl',
  'apps/investment-analyst-agents/archive/qa.jsonl',
  SOURCE_HEAD_FILE,
] as const

export const REQUIRED_SNAPSHOT_DIRS = [
  'apps/capital-intelligence-ingestion/data/lancedb',
] as const

/**
 * ORDINARY NODES ONLY, AND ALL OF THEM.
 *
 * `existsSync` follows symlinks and answers yes for a FIFO, so the earlier
 * fingerprint walk would have hashed whatever a link pointed at - including
 * something outside the snapshot - and would have BLOCKED on a FIFO. Each
 * required path is therefore lstat'd, and every node beneath a required
 * directory is checked the same way. A missing path is a refusal, never a skip:
 * copying five of six stores is the partial-completion failure this whole
 * design exists to prevent.
 */
export function assertCompleteSnapshot(root: string): void {
  const checkNode = (abs: string, expect: 'file' | 'dir'): void => {
    let st
    try {
      st = lstatSync(abs)
    } catch {
      throw new CopyRefused(`required snapshot ${expect} is missing: ${abs}`)
    }
    if (st.isSymbolicLink()) {
      throw new CopyRefused(
        `${abs} is a symlink. A snapshot node that points elsewhere can be repointed ` +
        'between the fingerprint and the read, and may resolve outside the snapshot.',
      )
    }
    if (expect === 'file' && !st.isFile()) {
      throw new CopyRefused(
        `${abs} is not a regular file (mode ${(st.mode & 0o170000).toString(8)}). A FIFO, ` +
        'socket or device is not a source.',
      )
    }
    if (expect === 'dir' && !st.isDirectory()) {
      throw new CopyRefused(`${abs} is not a directory.`)
    }
    // The node must still be inside the root once resolved.
    const real = realpathSync(abs)
    const rel = relative(root, real)
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
      throw new CopyRefused(`${abs} resolves to ${real}, outside the snapshot root.`)
    }
  }

  for (const rel of REQUIRED_SNAPSHOT_FILES) checkNode(resolveUnderRoot(root, rel), 'file')
  for (const rel of REQUIRED_SNAPSHOT_DIRS) {
    const dir = resolveUnderRoot(root, rel)
    checkNode(dir, 'dir')
    const files = walkFilesStrict(root, dir)
    if (files.length === 0) {
      throw new CopyRefused(
        `${dir} is empty. An empty LanceDB tree is not "zero chunks" - it is an ` +
        'incomplete snapshot.',
      )
    }
  }
}

/** walkFiles, but every node is lstat'd and anything unusual refuses. */
export function walkFilesStrict(root: string, dir: string, acc: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) {
      throw new CopyRefused(`${full} is a symlink; snapshot trees must contain ordinary nodes only.`)
    }
    if (st.isDirectory()) walkFilesStrict(root, full, acc)
    else if (st.isFile()) acc.push(full)
    else {
      throw new CopyRefused(
        `${full} is neither a regular file nor a directory (mode ` +
        `${(st.mode & 0o170000).toString(8)}); snapshot trees must contain ordinary nodes only.`,
      )
    }
  }
  return acc
}

export function allSnapshotPaths(root: string): string[] {
  const groups = snapshotPaths(root)
  const out: string[] = []
  for (const key of Object.keys(groups).sort()) out.push(...groups[key])
  return out
}

// ---------------------------------------------------------------------------
// IN-TRANSACTION PROOFS
// ---------------------------------------------------------------------------

export interface TargetIdentity {
  database: string
  sessionUser: string
  currentUser: string
  serverVersionNum: number
  systemIdentifier: string
  /**
   * `current_setting('port')`, NOT `inet_server_port()`.
   *
   * PostgreSQL documents that `inet_server_port()` returns NULL when the
   * current connection uses a Unix-domain socket - and this rehearsal connects
   * exactly that way, `?host=<socket-directory>&port=<port>`. The earlier
   * version therefore recorded NULL for every valid target and the numeric
   * comparison refused all of them. The configured port is a server fact that
   * exists over either transport, so the equality check keeps its force.
   */
  configuredPort: number | null
  /**
   * TRANSPORT, derived from the server: `inet_server_addr()` is NULL over a
   * Unix socket and an address over TCP. A TCP session to the same cluster,
   * database and port is a different connection and is refused.
   */
  unixTransport: boolean
  socketDirectories: string
}

/**
 * WHERE DID THIS CONNECTION ACTUALLY LAND. A URL is a request, not proof. The
 * system_identifier is what makes the answer non-forgeable: a same-named
 * database on a different cluster answers with a different identifier.
 */
export async function readTargetIdentity(client: CopyClient): Promise<TargetIdentity> {
  const r = await client.query(
    `SELECT current_database()                         AS database,
            session_user                               AS session_user,
            current_user                               AS current_user,
            current_setting('server_version_num')::int AS server_version_num,
            (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
            current_setting('port')::int               AS configured_port,
            (inet_server_addr() IS NULL)               AS unix_transport,
            current_setting('unix_socket_directories') AS socket_directories`,
  )
  const row = r.rows[0] as Record<string, unknown>
  return {
    database: String(row.database),
    sessionUser: String(row.session_user),
    currentUser: String(row.current_user),
    serverVersionNum: Number(row.server_version_num),
    systemIdentifier: String(row.system_identifier),
    configuredPort:
      row.configured_port === null || row.configured_port === undefined
        ? null
        : Number(row.configured_port),
    unixTransport: row.unix_transport === true,
    socketDirectories: String(row.socket_directories),
  }
}

/**
 * The configured socket directories, as a list.
 *
 * PostgreSQL does NOT expose which socket directory the current session came
 * in through - there is no such function - so "the session used THIS socket"
 * cannot be asked directly. What makes the proof sound for this controlled
 * rehearsal is the combination: the session is proved to be on Unix transport,
 * the configured port matches, and the server is configured with EXACTLY ONE
 * socket directory. With one directory configured, a Unix session can only
 * have arrived through it. Zero is unusable and more than one is ambiguous, so
 * both are refused rather than reasoned about.
 */
export function configuredSocketDirectories(setting: string): string[] {
  return setting.split(',').map(x => x.trim()).filter(x => x !== '')
}

/** The cluster-identifying half of a confirmed plan. */
export interface ExpectedTargetIdentity {
  database: string
  systemIdentifier: string
  port: number
  socketDirectory: string
}

/**
 * ENFORCED, NOT RECORDED. The earlier version compared the database name and a
 * version floor and let everything else past, so a same-named database on
 * another cluster - a colleague's, a restored copy, a second local instance -
 * satisfied it. The system identifier is the cluster's own identity and cannot
 * be spelled differently by accident; the port and socket directory pin WHICH
 * listener answered.
 *
 * All of it runs BEFORE SET LOCAL ROLE and before any target-table query, so a
 * wrong cluster is refused while the session still holds no owner privilege.
 */
export function assertTargetIdentity(
  actual: TargetIdentity,
  expected: ExpectedTargetIdentity,
): void {
  if (actual.database !== expected.database) {
    throw new CopyRefused(
      `target database is ${actual.database}, not the required ${expected.database}.`,
    )
  }
  if (actual.sessionUser !== REQUIRED_CREDENTIAL_ROLE) {
    throw new CopyRefused(
      `session_user is ${actual.sessionUser}; the copy must connect as ${REQUIRED_CREDENTIAL_ROLE}.`,
    )
  }
  if (actual.currentUser !== REQUIRED_CREDENTIAL_ROLE) {
    throw new CopyRefused(
      `current_user is ${actual.currentUser} before SET LOCAL ROLE; the migrator ` +
      'deliberately inherits nothing, so it must still be itself at this point.',
    )
  }
  // PostgreSQL 17 EXACTLY: a floor alone would admit 18, which this rehearsal
  // has proved nothing about.
  if (actual.serverVersionNum < 170000 || actual.serverVersionNum >= 180000) {
    throw new CopyRefused(
      `server_version_num is ${actual.serverVersionNum}; PostgreSQL major 17 is ` +
      'required (>= 170000 and < 180000).',
    )
  }
  if (actual.systemIdentifier !== expected.systemIdentifier) {
    throw new CopyRefused(
      `the cluster system identifier is ${actual.systemIdentifier}, not the confirmed ` +
      `${expected.systemIdentifier}. A same-named database on another cluster is not ` +
      'the target that was confirmed.',
    )
  }
  // TRANSPORT FIRST. Everything below is about which socket answered, and that
  // question is meaningless for a TCP session.
  if (!actual.unixTransport) {
    throw new CopyRefused(
      'this session is connected over TCP. The rehearsal copy runs over a ' +
      'Unix-domain socket only: a TCP session to the same cluster, database and ' +
      'port is a different connection and is refused.',
    )
  }
  if (actual.configuredPort === null) {
    throw new CopyRefused(
      "current_setting('port') returned no value; the server port could not be proved.",
    )
  }
  if (actual.configuredPort !== expected.port) {
    throw new CopyRefused(
      `the server is configured on port ${actual.configuredPort}, not the confirmed ` +
      `${expected.port}.`,
    )
  }
  const sockets = configuredSocketDirectories(actual.socketDirectories)
  if (sockets.length !== 1) {
    throw new CopyRefused(
      `the server has ${sockets.length} unix_socket_directories configured ` +
      `[${sockets.join(', ')}]. This proof requires exactly one: with several ` +
      'configured, nothing the server exposes says which one this session used.',
    )
  }
  if (sockets[0] !== expected.socketDirectory) {
    throw new CopyRefused(
      `the server's only socket directory is ${sockets[0]}, not the confirmed ` +
      `${expected.socketDirectory}.`,
    )
  }
}

/**
 * After SET LOCAL ROLE: the SESSION identity must be unchanged and the CURRENT
 * identity must be the owner. Both halves matter - a SET ROLE that silently did
 * nothing, and one that changed who we are answerable as, are both failures.
 */
export function assertAssumedOwner(actual: TargetIdentity): void {
  if (actual.sessionUser !== REQUIRED_CREDENTIAL_ROLE) {
    throw new CopyRefused(`session_user changed to ${actual.sessionUser} after SET LOCAL ROLE.`)
  }
  if (actual.currentUser !== COPY_OWNER_ROLE) {
    throw new CopyRefused(
      `current_user is ${actual.currentUser} after SET LOCAL ROLE ${COPY_OWNER_ROLE}; ` +
      'the owner role was not assumed.',
    )
  }
}

/**
 * EXACT recognition, not a row count. Nineteen rows is satisfied by nineteen
 * rows naming nineteen fictional migrations, and by nineteen real names applied
 * from edited bytes.
 *
 * The manifest is NOT restated here. `CURRENT_V19_MANIFEST` and
 * `recognizeManifest` are the repository's published pair, already used by the
 * inventory surface; a second editable copy would drift from the first and
 * whichever one a reader found would look authoritative.
 */
export async function assertMigrationLedger(client: CopyClient): Promise<number> {
  const r = await client.query(
    'SELECT filename, sha256, applied_at FROM db.schema_migrations',
  )
  const rows = r.rows as { filename: string; sha256: string; applied_at: string }[]
  const facts = recognizeManifest(rows, CURRENT_V19_MANIFEST)
  if (facts.recognition !== 'CURRENT_V19') {
    const parts: string[] = []
    if (facts.missing.length) parts.push(`missing [${facts.missing.join(', ')}]`)
    if (facts.additional.length) parts.push(`unexpected [${facts.additional.join(', ')}]`)
    if (facts.hash_mismatched.length) {
      parts.push(`hash mismatch [${facts.hash_mismatched.map(h => h.filename).join(', ')}]`)
    }
    if (facts.recorded_count !== facts.expected_count) {
      parts.push(`${facts.recorded_count} rows recorded, ${facts.expected_count} expected`)
    }
    throw new CopyRefused(
      `the migration ledger is UNRECOGNIZED, not CURRENT_V19: ${parts.join('; ')}. ` +
      'The copy targets exactly the nineteen published migrations.',
    )
  }
  if (facts.recorded_count !== REQUIRED_MIGRATION_COUNT) {
    throw new CopyRefused(
      `the ledger recognises as CURRENT_V19 but holds ${facts.recorded_count} rows.`,
    )
  }
  return facts.recorded_count
}

/**
 * FRESH-TARGET ONLY, and checked AFTER SET LOCAL ROLE - the migrator inherits
 * no owner privilege, so as itself it cannot even count these rows.
 */
export async function assertFreshTargets(client: CopyClient): Promise<void> {
  const populated: string[] = []
  for (const table of TARGET_TABLES) {
    const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`)
    if (Number((r.rows[0] as { n: number }).n) !== 0) populated.push(table)
  }
  if (populated.length > 0) {
    throw new CopyRefused(
      `the target is not fresh: ${populated.join(', ')} already hold rows. This copy ` +
      'is a one-time deployment-window operation onto an empty target and will not ' +
      'TRUNCATE data it did not write.',
    )
  }
}

export interface SequenceState {
  sequence: string
  lastValue: string | null
  isCalled: boolean
}

/**
 * READ ONLY, AND READ FROM THE SEQUENCE RELATION ITSELF.
 *
 * NOT `pg_sequences`. That view does not expose `is_called` — in PostgreSQL 17
 * its column list is schemaname, sequencename, sequenceowner, data_type,
 * start_value, min_value, max_value, increment_by, cycle, cache_size and
 * last_value, and nothing else (share/postgresql/system_views.sql). Selecting
 * `is_called` from it raises 42703 at runtime; the database-free suite hid that
 * because its fake client fabricated the column. The view's `last_value` is not
 * equivalent either: it is `pg_sequence_last_value()`, which answers NULL for a
 * sequence that has never been advanced and for a caller without privileges.
 *
 * A sequence RELATION exposes both columns directly. This read calls no
 * `nextval`, `setval` or `currval` and modifies no sequence state — but it is
 * NOT lock-free, and claiming so would be wrong: it is an ordinary SELECT and
 * takes the ordinary ACCESS SHARE relation lock that every SELECT takes. That
 * is what makes it safe for OBSERVING state, not what makes it invisible.
 *
 * Nor is any probe insert made: sequence advancement is NOT rolled back, so a
 * "harmless" test insert inside a transaction would still burn a value and
 * leave the target differing from a replay of the same fixtures.
 *
 * The relation name is interpolated, so BOTH components are escaped with the
 * driver's own `escapeIdentifier`. There is no `regclass` cast and no reliance
 * on `search_path` — the orchestrator has already pinned it to `pg_catalog`, so
 * an unqualified or unquoted name would resolve to nothing or, worse, to
 * something else.
 */
export async function readSequenceStates(client: CopyClient): Promise<SequenceState[]> {
  const out: SequenceState[] = []
  for (const s of TARGET_SEQUENCES) {
    const parts = s.sequence.split('.')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new CopyRefused(
        `sequence "${s.sequence}" is not a schema-qualified name of exactly two ` +
        'non-empty components; it will not be interpolated into a query.',
      )
    }
    const relation = `${escapeIdentifier(parts[0])}.${escapeIdentifier(parts[1])}`
    const r = await client.query(
      `SELECT last_value::text AS last_value, is_called FROM ${relation}`,
    )
    if (r.rows.length === 0) {
      throw new CopyRefused(`sequence ${s.sequence} returned no row; it does not exist.`)
    }
    if (r.rows.length > 1) {
      throw new CopyRefused(
        `sequence ${s.sequence} returned ${r.rows.length} rows. A sequence relation ` +
        'holds exactly one row; more than one means this is not the object it claims ' +
        'to be, and the state is not trustworthy.',
      )
    }
    const row = r.rows[0] as { last_value: unknown; is_called: unknown }
    if (typeof row.is_called !== 'boolean') {
      throw new CopyRefused(
        `sequence ${s.sequence} reported is_called as ${JSON.stringify(row.is_called)}, ` +
        'which is not a boolean.',
      )
    }
    // VALIDATED, NOT CONVERTED. The expression is `last_value::text`, so the only
    // shapes the driver may hand back are a string and SQL NULL. `String(v)` -
    // what this used to do - turns a number into a rounded decimal, `undefined`
    // into the four characters "undefined", an object into "[object Object]" and
    // `false` into "false", and every one of those reaches the evidence manifest
    // looking like a sequence value somebody read.
    if (row.last_value !== null && typeof row.last_value !== 'string') {
      throw new CopyRefused(
        `sequence ${s.sequence} reported last_value as ${JSON.stringify(row.last_value)} ` +
        `(type ${typeof row.last_value}); last_value::text yields a string or SQL NULL, ` +
        'and nothing else is accepted.',
      )
    }
    out.push({ sequence: s.sequence, lastValue: row.last_value, isCalled: row.is_called })
  }
  return out
}

export interface FailureProbeResult {
  label: string
  sqlstate: string
  message: string
}

/**
 * An expected-failure probe runs inside its OWN savepoint and is rolled back to
 * it. Several expected failures in one un-recovered transaction would leave that
 * transaction aborted, and every later statement would then fail for the wrong
 * reason - which reads exactly like the proof succeeding.
 */
export async function expectFailure(
  client: CopyClient,
  label: string,
  sql: string,
  values?: unknown[],
): Promise<FailureProbeResult> {
  const savepoint = `probe_${createHash('sha256').update(label).digest('hex').slice(0, 16)}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let sawExpectedFailure: FailureProbeResult | null = null
  try {
    await client.query(sql, values)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    sawExpectedFailure = {
      label,
      sqlstate: e.code ?? 'unknown',
      message: e.message ?? String(err),
    }
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  if (sawExpectedFailure === null) {
    throw new CopyRefused(`probe "${label}" was expected to fail and did not.`)
  }
  return sawExpectedFailure
}

// ---------------------------------------------------------------------------
// CANONICAL RESULT MANIFEST
// ---------------------------------------------------------------------------

/**
 * ROW COUNTS, AND ONLY ROW COUNTS.
 *
 * Deterministic and independent of adapter order, which makes it a useful
 * tripwire - but it is NOT a target-state manifest and must never be described
 * as one. Two databases holding the same number of rows with entirely different
 * VALUES produce identical text here. The exact ordered per-column checksums
 * that can tell those apart require a live server, so they belong to the
 * PostgreSQL artifact; this count manifest is not the replay proof and cannot
 * stand in for it.
 */
export function canonicalCountManifest(results: TableResult[]): string {
  const byTable = new Map<string, number>()
  for (const r of results) byTable.set(r.table, (byTable.get(r.table) ?? 0) + r.rows)
  const lines: string[] = []
  for (const table of TARGET_TABLES) lines.push(`${table} ${byTable.get(table) ?? 0}`)
  const declared = new Set<string>(TARGET_TABLES as readonly string[])
  const extra = [...byTable.keys()].filter(t => !declared.has(t)).sort()
  for (const t of extra) lines.push(`UNDECLARED ${t} ${byTable.get(t)}`)
  return lines.join('\n') + '\n'
}

export function canonicalDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------
// THE ORCHESTRATOR
// ---------------------------------------------------------------------------

export type Adapter = (client: CopyClient, ctx: CopyContext) => Promise<TableResult[]>

/**
 * WHAT THE OPERATOR CONFIRMED. Authorization is bound to these exact bytes: a
 * plan confirmed for snapshot A cannot authorise snapshot B, and a plan
 * confirmed for one cluster cannot authorise another.
 */
export interface ConfirmedPlan {
  sourceRoot: string
  sourceHead: string
  sourceDigest: string
  database: string
  systemIdentifier: string
  port: number
  socketDirectory: string
}

export interface CopyOptions {
  env: NodeJS.ProcessEnv
  /** The plan the operator confirmed. Required: there is no implicit plan. */
  plan: ConfirmedPlan
  /** Injectable for the database-free tests. Production passes none. */
  adapters?: Record<string, Adapter>
  createPoolFn?: (url: string) => Pool
  log?: (line: string) => void
}

export interface CopyOutcome {
  identityBefore: TargetIdentity
  identityAfterSetRole: TargetIdentity
  migrationCount: number
  results: TableResult[]
  sequences: SequenceState[]
  /** ROW COUNTS ONLY - see canonicalCountManifest. Not a target-state proof. */
  countManifest: string
  countManifestDigest: string
  sourceDigest: string
  fingerprints: SourceFingerprint[]
}

/** The six adapters, loaded lazily so importing this module opens nothing. */
export async function defaultAdapters(): Promise<Record<string, Adapter>> {
  const [portfolio, capital, thesis, briefing, graph, lance] = await Promise.all([
    import('./legacy-copy/portfolio.js'),
    import('./legacy-copy/capital.js'),
    import('./legacy-copy/thesis.js'),
    import('./legacy-copy/briefing.js'),
    import('./legacy-copy/graph.js'),
    import('./legacy-copy/lance.js'),
  ])
  return {
    portfolio: portfolio.copyPortfolio,
    capital: capital.copyCapital,
    thesis: thesis.copyThesis,
    briefing: briefing.copyBriefing,
    graph: graph.copyGraph,
    lance: lance.copyLance,
  }
}

/** FK-safe execution order: parents before children, across source groups. */
export const ADAPTER_ORDER = ['portfolio', 'capital', 'thesis', 'briefing', 'graph', 'lance'] as const

/**
 * ONE POOL, ONE CLIENT, ONE TRANSACTION, ONE COMMIT OR ONE ROLLBACK.
 *
 * Everything before `createPool` is offline: the credential and the snapshot
 * root are validated, and the source is fingerprinted, without a socket being
 * opened. That is what lets the CLI's default mode share this code and still
 * promise that it connected to nothing.
 */
export async function runLegacyCopy(opts: CopyOptions): Promise<CopyOutcome> {
  const log = opts.log ?? (() => {})
  const plan = opts.plan

  // -- OFFLINE: inputs, completeness, and the plan comparison ---------------
  const url = resolveCredential(opts.env)
  const sourceRoot = resolveSourceRoot(opts.env)
  if (sourceRoot !== plan.sourceRoot) {
    throw new CopyRefused(
      `the confirmed plan names snapshot root ${plan.sourceRoot}, but ` +
      `${SOURCE_ROOT_VAR} resolves to ${sourceRoot}.`,
    )
  }
  const database = requireDatabaseName(url)
  if (database !== plan.database) {
    throw new CopyRefused(
      `the confirmed plan names database ${plan.database}, but the credential names ` +
      `${database}.`,
    )
  }

  // Completeness FIRST: a digest computed over five of six stores would agree
  // with itself all day.
  assertCompleteSnapshot(sourceRoot)

  const head = readSourceHead(sourceRoot)
  if (head !== plan.sourceHead) {
    throw new CopyRefused(
      `the snapshot was taken at ${head}, but the confirmed plan names ${plan.sourceHead}.`,
    )
  }
  const fingerprints = sourceFingerprints(sourceRoot, allSnapshotPaths(sourceRoot))
  const sourceDigest = fingerprintDigest(fingerprints)
  if (sourceDigest !== plan.sourceDigest) {
    throw new CopyRefused(
      'the snapshot has changed since it was confirmed ' +
      `(confirmed ${plan.sourceDigest}, now ${sourceDigest}). No connection was opened.`,
    )
  }
  log(`source root:   ${sourceRoot}`)
  log(`source head:   ${head}`)
  log(`source digest: ${sourceDigest}`)

  const adapters = opts.adapters ?? (await defaultAdapters())
  const makePool = opts.createPoolFn ?? ((u: string) => createPool(u))

  return withProductionWrite(
    {
      // A ONE-TIME DATA COPY, not a schema change. `migration` means DDL applied
      // by db-migrate and recorded in db.schema_migrations; this is neither, and
      // classifying it as one would let an intent opened for either satisfy an
      // assertion written for the other.
      operation: 'legacy-copy',
      context: 'admin',
      reason:
        `S4F-C-COPY one-time legacy copy into ${plan.database} on cluster ` +
        `${plan.systemIdentifier} port ${plan.port} from snapshot ${sourceRoot} ` +
        `at ${head} (digest ${sourceDigest})`,
    },
    async () => {
      // -- CLEANUP MATRIX -------------------------------------------------
      // Once the pool exists, EVERY exit path ends at pool.end(): an
      // authorization failure, a connect rejection, a BEGIN rejection, an
      // adapter rejection, a COMMIT rejection. Once the client exists, release
      // is attempted exactly once, and a release that throws must not stop
      // pool.end() from being attempted - a leaked pool outlives the process's
      // usefulness, and a cleanup failure must never replace the primary error
      // or the fact that COMMIT may already have succeeded.
      const pool = makePool(url)
      let client: (PoolClient & CopyClient) | null = null
      let released = false
      let committed = false
      let primary: unknown = null
      let outcome: CopyOutcome | null = null

      try {
        assertPoolWriteAuthorized(pool, 'legacy-copy')
        client = (await pool.connect()) as unknown as PoolClient & CopyClient

        let began = false
        try {
          await client.query('BEGIN')
          began = true

          const identityBefore = await readTargetIdentity(client)
          assertTargetIdentity(identityBefore, {
            database: plan.database,
            systemIdentifier: plan.systemIdentifier,
            port: plan.port,
            socketDirectory: plan.socketDirectory,
          })

          const migrationCount = await assertMigrationLedger(client)

          // 010 grants the owner role to the migrator `WITH INHERIT FALSE, SET
          // TRUE`, so the elevation is explicit and nothing is held passively.
          // SET LOCAL reverts it at COMMIT and at ROLLBACK alike.
          await client.query(`SET LOCAL ROLE ${COPY_OWNER_ROLE}`)
          const identityAfterSetRole = await readTargetIdentity(client)
          assertAssumedOwner(identityAfterSetRole)
          await client.query('SET LOCAL search_path = pg_catalog')

          await assertFreshTargets(client)

          const results: TableResult[] = []
          for (const name of ADAPTER_ORDER) {
            const adapter = adapters[name]
            if (!adapter) throw new CopyRefused(`adapter ${name} is not registered.`)
            log(`[copy] ${name}`)
            const produced = await adapter(client, { sourceRoot })
            for (const r of produced) {
              log(`  + ${r.table}: ${r.rows}`)
              results.push(r)
            }
          }

          // THE SAME THREE CHECKS AGAIN, before COMMIT. Head, completeness and
          // digest: the snapshot must still be the one that was authorised.
          assertCompleteSnapshot(sourceRoot)
          const headAfter = readSourceHead(sourceRoot)
          if (headAfter !== plan.sourceHead) {
            throw new CopyRefused(
              `${SOURCE_HEAD_FILE} changed during the copy (${plan.sourceHead} -> ${headAfter}).`,
            )
          }
          const after = sourceFingerprints(sourceRoot, allSnapshotPaths(sourceRoot))
          const afterDigest = fingerprintDigest(after)
          if (afterDigest !== plan.sourceDigest) {
            throw new CopyRefused(
              'the source snapshot changed during the copy ' +
              `(${plan.sourceDigest} -> ${afterDigest}); the transaction is rolled back.`,
            )
          }

          const sequences = await readSequenceStates(client)
          const countManifest = canonicalCountManifest(results)

          // THE COMMIT, ON ITS OWN. A rejection here is indeterminate, so
          // `began` is cleared FIRST: no ROLLBACK may be issued against a
          // transaction that may already be committed, and no code path below
          // may report that nothing was copied.
          try {
            await client.query('COMMIT')
            began = false
            committed = true
          } catch (commitErr) {
            began = false
            throw new CopyCommitOutcomeUnknown(commitErr)
          }

          outcome = {
            identityBefore,
            identityAfterSetRole,
            migrationCount,
            results,
            sequences,
            countManifest,
            countManifestDigest: canonicalDigest(countManifest),
            sourceDigest,
            fingerprints,
          }
        } catch (err) {
          primary = err
          if (began) {
            try {
              await client.query('ROLLBACK')
            } catch {
              /* the original error is the one that matters */
            }
          }
        }
      } catch (err) {
        primary = err
      } finally {
        if (client && !released) {
          released = true
          try {
            client.release()
          } catch (err) {
            log(`cleanup: client.release() failed: ${messageOf(err)}`)
          }
        }
        try {
          await pool.end()
        } catch (err) {
          log(`cleanup: pool.end() failed: ${messageOf(err)}`)
        }
      }

      if (primary !== null) {
        if (committed) {
          // Nothing below COMMIT may report the copy as not done.
          log('note: COMMIT had already succeeded when the failure occurred.')
        }
        throw primary
      }
      if (!outcome) throw new CopyRefused('the copy produced no outcome.')
      return outcome
    },
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The database name the credential names.
 *
 * This used to split the string by hand, which is exactly the mistake
 * `databaseNameOfRaw` exists to prevent: the driver percent-decodes the path
 * once and takes a socket URL's database from `?db=`, and a hand-rolled parser
 * agrees with it only for the shapes whoever wrote it remembered. The driver's
 * own answer is the only one that matches where the connection will actually go.
 */
export function requireDatabaseName(url: string): string {
  const name = databaseNameOfRaw(url)
  if (!name) {
    throw new CopyRefused(
      `${CREDENTIAL_VAR} does not name a database the driver can resolve. An ` +
      'unparseable or empty destination is refused rather than guessed.',
    )
  }
  return name
}

// ---------------------------------------------------------------------------
// SOURCE READING HELPERS - shared by the SQLite adapters
// ---------------------------------------------------------------------------

export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

/**
 * Open a snapshot SQLite file READ-ONLY. `better-sqlite3` is imported lazily so
 * that importing this module loads no native addon and touches no file.
 *
 * A missing file is REFUSED, not treated as zero rows: a source that should be
 * there and is not means the snapshot is incomplete, and copying four of five
 * stores is the partial-completion failure this design exists to prevent.
 */
export async function openSourceSqlite(path: string): Promise<SqliteLike> {
  if (!existsSync(path)) {
    throw new CopyRefused(`required source database is missing from the snapshot: ${path}`)
  }
  const mod = await import('better-sqlite3')
  const Database = (mod.default ?? mod) as unknown as new (p: string, o?: unknown) => SqliteLike
  try {
    return new Database(path, { readonly: true, fileMustExist: true })
  } catch (err) {
    throw new CopyRefused(
      `source database could not be opened (it may be corrupt): ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * THE SOURCE SCHEMA IS ASSERTED, NOT ASSUMED.
 *
 * The tools this replaces read `SELECT *` into a hand-written interface. A
 * renamed source column produced `undefined` for that field and inserted NULL;
 * an ADDED column was silently ignored. Both are schema drift, and both are
 * failures - so the column set must match EXACTLY. An extra column is refused
 * for the same reason a missing one is: nobody decided it should be dropped.
 */
export function assertSqliteSchema(db: SqliteLike, table: string, expected: string[]): void {
  let info: { name: string }[]
  try {
    info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  } catch (err) {
    throw new CopyRefused(
      `source table ${table} could not be inspected: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (info.length === 0) {
    throw new CopyRefused(`source table ${table} does not exist in the snapshot.`)
  }
  const actual = info.map(c => c.name).sort()
  const want = [...expected].sort()
  const missing = want.filter(c => !actual.includes(c))
  const added = actual.filter(c => !want.includes(c))
  if (missing.length > 0 || added.length > 0) {
    throw new CopyRefused(
      `source table ${table} does not match the expected schema. ` +
      `missing: [${missing.join(', ')}]; unexpected: [${added.join(', ')}]. ` +
      'Schema drift fails closed - an unexpected column has never been reviewed ' +
      'and silently dropping it would lose data without saying so.',
    )
  }
}

/**
 * SQLite has no boolean type; these arrive as integers. The target columns are
 * `BOOLEAN NOT NULL`, so NULL and every value other than 0 or 1 is refused.
 * `!!value` - what the old tools did - turns 2, -1 and "false" into TRUE and
 * NULL into FALSE, none of which anybody decided.
 */
export function requireBooleanInt(table: string, column: string, id: string, value: unknown): boolean {
  if (value === 0 || value === 1) return value === 1
  throw new CopyRefused(
    `${table}.${column} for row ${id} is ${JSON.stringify(value)}; the target column is ` +
    'BOOLEAN NOT NULL and only integer 0 or 1 is accepted.',
  )
}

/** The same, for a column whose target is nullable BOOLEAN. */
export function requireNullableBooleanInt(
  table: string, column: string, id: string, value: unknown,
): boolean | null {
  if (value === null || value === undefined) return null
  if (value === 0 || value === 1) return value === 1
  throw new CopyRefused(
    `${table}.${column} for row ${id} is ${JSON.stringify(value)}; only integer 0, 1 ` +
    'or NULL is accepted.',
  )
}
