// STAGE 1 — what the source actually held, proved while it could not change.
//
// WHAT A MANIFEST IS. One document saying: at this instant, under this fence,
// these 21 tables held exactly these bytes, this schema described them, and
// these three sequences stood here. Everything later in the copy - the binary
// transport, the sequence policy, the independent verifier - is checked against
// it. So the manifest's own integrity is the floor the whole migration stands
// on, and every guard in this module exists to keep one specific way of
// producing a plausible-but-wrong manifest out of reach.
//
// THE FIVE PROPERTIES, AND WHY EACH NEEDS ITS OWN MACHINERY.
//
//   THE SOURCE CANNOT CHANGE WHILE IT IS READ. The complete 21-table,
//   three-sequence fence is taken on a SUPERVISOR session and proved from a
//   DIFFERENT backend before the export session opens its transaction. A
//   session can always see its own locks, so a self-proof proves nothing.
//
//   EVERYTHING IS ONE MOMENT. The export session opens exactly one
//   `READ ONLY REPEATABLE READ` transaction, as its FIRST statement, and every
//   catalogue read and every content digest happens on that one backend inside
//   that one snapshot. Its pid is proved at the start, re-proved by the
//   contract extractor, and proved again at the end.
//
//   THE READER CANNOT WRITE AND CANNOT REACH WHAT IT MUST NOT READ. The export
//   session authenticates as the export role, whose authority is a reviewed
//   read-only surface. It holds NO sequence privilege, and this module refuses
//   to send it any statement that reads mutable sequence state - `last_value`,
//   `is_called`, `pg_sequences` or `pg_sequence_last_value()`. Those numbers
//   come from the supervisor, after the fence is proved, and from nowhere else.
//
//   NO TARGET IS TOUCHED. Stage 1 states the EXPECTED target as an operator
//   input and never contacts it. There is no target parameter in this file, no
//   target session type, and no connection construction of any kind: the
//   functions here are handed sessions they cannot open.
//
//   THE RESULT CANNOT BE EDITED AFTERWARDS WITHOUT EVIDENCE. Publication goes
//   through the immutable evidence publisher, while the fence is still held,
//   and the fence is released only after publication AND the source rollback
//   have both completed.
//
// NOTHING IS RE-DERIVED HERE. Canonicalisation, the schema contract, the fence
// and the sequence arithmetic are reviewed primitives; this module orders them
// and refuses when the order or the result is not what it requires.

import {
  DEFAULT_BATCH_ROWS, LIVE_COLUMNS_SQL, PGCOPY_PROTOCOL,
  PK_COLUMNS_SQL, VECTOR_384, batchDigestSql, rootDigest, tableDigest,
  type BatchSummary, type ColumnSpec, type TypeContract,
} from './canonical.js'
import {
  DIGEST_FILE, evidenceStamp, publishEvidence, type EvidenceArtifact, type EvidenceOps,
  type PublishedEvidence,
} from './evidence.js'
import { EXPORT_ROLE_NAME } from './export-role.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, SCHEMA_CONTRACT_VERSION, canonicalJson,
  deriveCopyColumns, extractContractFromSession, serializeArtifact,
  type Canonical, type ContractArtifact, type ContractQueryExecutor,
} from './schema-contract.js'
import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, acquireSourceFence, assertFenceProof, effectiveNext,
  fenceRelationArray, parseLockRows, pgBool, readFencedSequenceState,
  type AcquiredFence, type FenceExecutor, type FencedSequenceState,
} from './source-fence.js'

/**
 * Bumped when the manifest's shape changes. Part of the document.
 *
 * v2 replaced an operator-asserted source identity with a MEASURED one: the
 * cluster's `system_identifier`, both role names, the server-reported address
 * and whether the transport is a Unix socket, all read in one statement. v1
 * recorded an operator LABEL under `system_identifier`, which is a different
 * claim wearing the same name, so the two documents must not be comparable.
 */
export const MANIFEST_ARTIFACT_VERSION = 2

/** The evidence prefix this stage publishes under. */
export const MANIFEST_PREFIX = 'source-manifest'

/** The two artifacts a Stage-1 bundle carries, besides DIGEST. */
export const MANIFEST_FILE = 'manifest.json'
export const SOURCE_CONTRACT_FILE = 'source-contract.json'

/**
 * The export session's FIRST statement, and the only transaction it opens.
 *
 * READ ONLY is enforced by the server, so a later statement that tried to write
 * is refused by PostgreSQL rather than by a reader classifying statements
 * correctly. REPEATABLE READ is what makes ten catalogue queries and 21 content
 * scans one moment instead of thirty-one.
 */
export const EXPORT_BEGIN_SQL = 'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ'
export const EXPORT_ROLLBACK_SQL = 'ROLLBACK'

/**
 * WHO and WHERE this session actually is, read in ONE statement.
 *
 * One statement for the same reason `SESSION_GUARD_SQL` is one statement:
 * separately, these facts can be observed in different states, and a manifest
 * that proves its read-only-ness against one moment and its cluster identity
 * against another proves neither.
 *
 * THE CLUSTER'S OWN IDENTITY IS THE ANCHOR. `pg_control_system()` reports the
 * `system_identifier` written into pg_control at `initdb` - a 64-bit value no
 * two clusters share, which a host name, a port or a database name cannot
 * substitute for. All three of those can be repointed at a different cluster
 * without changing a single character of the command line; the system
 * identifier cannot. It is read as `::text` so the exact decimal survives - a
 * JSON number would round a 19-digit value silently.
 *
 * BOTH ROLE NAMES. `CURRENT_USER` is the effective role and `SESSION_USER` is
 * the authenticated one; they differ after `SET ROLE`, and a session that
 * authenticated as something else and then assumed the export role is not the
 * authority this manifest claims. Both are SQL special forms and are
 * deliberately NOT schema-qualified - qualifying them does not resolve.
 *
 * WHAT THE SERVER CAN AND CANNOT TELL US ABOUT THE TRANSPORT.
 * `inet_server_addr()` is NULL for a Unix-socket connection, which is how the
 * transport is determined. PostgreSQL does NOT report the socket DIRECTORY, so
 * the manifest never claims it did: the directory is recorded separately, as
 * the endpoint this process REQUESTED.
 */
export const EXPORT_IDENTITY_SQL = `
SELECT pg_catalog.pg_backend_pid()::pg_catalog.text,
       pg_catalog.current_setting('transaction_read_only'),
       pg_catalog.current_setting('transaction_isolation'),
       (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text,
       pg_catalog.current_setting('server_version_num'),
       pg_catalog.current_database(),
       pg_catalog.current_setting('port'),
       CURRENT_USER::pg_catalog.text,
       SESSION_USER::pg_catalog.text,
       COALESCE(pg_catalog.inet_server_addr()::pg_catalog.text, ''),
       (pg_catalog.inet_server_addr() IS NULL)::pg_catalog.text`

/** How many values that statement returns. Checked, so a drift is a refusal. */
export const EXPORT_IDENTITY_COLUMNS = 11

export const REQUIRED_READ_ONLY = 'on'
export const REQUIRED_ISOLATION = 'repeatable read'

// ---------------------------------------------------------------------------
// ERRORS — fixed phases, fixed reasons, reviewed names only
// ---------------------------------------------------------------------------

export type ManifestPhase =
  | 'fence'
  | 'fence-proof'
  | 'export-begin'
  | 'export-identity'
  | 'export-guard'
  | 'contract'
  | 'content'
  | 'sequences'
  | 'reprove'
  | 'operator-input'
  | 'publish'
  | 'rollback'

/**
 * WHY a Stage-1 refusal happened. A CLOSED union.
 *
 * Nothing here interpolates a driver message, a query, a row, a URL or a
 * credential component. The only variable part any public error carries is a
 * REVIEWED qualified name - one of the 21 tables or three sequences, which are
 * compile-time constants in this repository.
 */
export type ManifestReason =
  | 'the export session issued a statement before its transaction began'
  | 'the export session may not read mutable sequence state'
  | 'the export session did not report one row of identity facts'
  | 'the export session is not the backend it reported'
  | 'the export session is not read only'
  | 'the export session is not repeatable read'
  | 'the export session is not connected to the reviewed source database'
  | 'the export session is not connected to the reviewed source endpoint'
  | 'the export session is not on the expected source cluster'
  | 'the export session did not report a usable system identifier'
  | 'the export session is not authenticated as the reviewed export role'
  | 'the export session assumed a role it did not authenticate as'
  | 'the source fence could not be taken'
  | 'the source contract could not be extracted'
  | 'the fenced sequence state could not be read'
  | 'the source contract is not the reviewed contract version'
  | 'the source contract does not describe the reviewed copy set'
  | 'the source contract states no reviewed vector extension version'
  | 'the live columns do not match the contract columns'
  | 'the table has no primary key to order by'
  | 'a content query did not return the expected batch summary shape'
  | 'the supervisor backend changed during derivation'
  | 'the fence was not still held'
  | 'an operator input is not in the reviewed form'
  | 'the manifest is not complete'

export class ManifestRefused extends Error {
  constructor(
    readonly phase: ManifestPhase,
    readonly reason: ManifestReason,
    readonly qname: string | null = null,
  ) {
    super(`${reason} (phase ${phase}${qname === null ? '' : ` for ${qname}`})`)
    this.name = 'ManifestRefused'
  }
}

// ---------------------------------------------------------------------------
// SESSION SEAMS — handed in, never opened
// ---------------------------------------------------------------------------

/** The fence holder. Owns the fence transaction; nothing here ends it. */
export interface SupervisorSession extends FenceExecutor {
  readonly pid: string
}

/** A DIFFERENT backend, which does nothing but observe. */
export type ProverSession = FenceExecutor

/** The export role's session. One backend, one transaction, read only. */
export type ExportSession = ContractQueryExecutor

/**
 * The reviewed shapes of mutable sequence state, which the EXPORT role must
 * never read.
 *
 * `pg_sequences` and `pg_sequence_last_value()` take the very lock the fence
 * holds; `last_value` and `is_called` are the numbers the fence exists to
 * freeze. The contract extractor's own sequence query reads only
 * `pg_catalog.pg_sequence` - static definition, no position - so it passes
 * this guard, and that is exactly the distinction being enforced.
 */
const MUTABLE_SEQUENCE_READ =
  /\bpg_sequences\b|\bpg_sequence_last_value\b|\blast_value\b|\bis_called\b|\bsetval\b|\bnextval\b/i

/**
 * The statement with its COMMENTS removed, which is what the guard inspects.
 *
 * MEASURED, NOT ANTICIPATED. The first version tested the raw text and refused
 * the contract extractor's own COLUMNS query, because that query carries a
 * `--` comment explaining why it does NOT join `pg_catalog.pg_sequences`. The
 * ban is on what a statement DOES; matching the explanation instead would have
 * made the reviewed extraction unreachable and the guard worthless.
 *
 * String literals are honoured while scanning, so a `--` inside a quoted value
 * does not swallow the rest of the statement and hide a real read behind it.
 */
export function sqlWithoutComments(sql: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < sql.length) {
    const c = sql[i]
    if (inString) {
      out += c
      if (c === "'") inString = sql[i + 1] === "'" ? (out += sql[++i], true) : false
      i += 1
      continue
    }
    if (c === "'") { inString = true; out += c; i += 1; continue }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * Wrap an export session so the order and the content of its statements are
 * properties of the type rather than of the caller's discipline.
 *
 * Two things become impossible: issuing anything before the reviewed BEGIN, and
 * issuing anything that reads mutable sequence state. The wrapper also RECORDS
 * every statement, so a test can assert what the export role was asked for
 * rather than trusting that it was asked for the right things.
 */
export interface GuardedExportSession extends ExportSession {
  readonly issued: readonly string[]
  readonly begun: boolean
}

export function guardExportSession(inner: ExportSession): GuardedExportSession {
  const issued: string[] = []
  let begun = false
  const guarded: GuardedExportSession = {
    get pid() { return inner.pid },
    get issued() { return Object.freeze([...issued]) },
    get begun() { return begun },
    rows: async (sql: string): Promise<string[][]> => {
      if (!begun && sql.trim() !== EXPORT_BEGIN_SQL) {
        throw new ManifestRefused(
          'export-begin', 'the export session issued a statement before its transaction began')
      }
      if (MUTABLE_SEQUENCE_READ.test(sqlWithoutComments(sql))) {
        throw new ManifestRefused(
          'export-guard', 'the export session may not read mutable sequence state')
      }
      issued.push(sql)
      if (sql.trim() === EXPORT_BEGIN_SQL) begun = true
      return await inner.rows(sql)
    },
  }
  return guarded
}

// ---------------------------------------------------------------------------
// OPERATOR INPUT — stated, validated, never guessed
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/
const RUN_ID = /^[0-9a-f]{8}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
/**
 * A bounded operator label: printable ASCII, no control character, no pipe.
 *
 * A leading `/` is allowed because the reviewed source endpoint is frequently a
 * Unix SOCKET DIRECTORY, which is an absolute path. The pipe is excluded
 * because these labels are copied into a document whose digests use `|` as a
 * header separator, and a label that could impersonate that framing is refused
 * rather than escaped.
 */
const LABEL = /^[A-Za-z0-9/][A-Za-z0-9 ._:@/-]{0,119}$/
/**
 * A URL SCHEME in an operator label is refused outright.
 *
 * The label grammar admits `:`, `@` and `/` because real endpoints contain
 * them, which also means `postgresql://user:secret@host/db` fits it. Labels are
 * copied verbatim into the published manifest, so accepting one would put a
 * connection URL - and possibly a password - into evidence that is deliberately
 * immutable. Refused rather than redacted: a redacted URL is still a URL that
 * was typed on a command line.
 */
const URL_SCHEME = /:\/\//
const PORT = /^[1-9][0-9]{0,4}$/
const IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * A cluster system identifier: an unsigned 64-bit value, in exact decimal.
 *
 * The shape and the RANGE are both checked. Twenty digits is a legal length -
 * the maximum is 18446744073709551615 - so a length-only rule would accept
 * 76892290249197750421, which no cluster can report. Compared as a BigInt
 * because the value does not fit a double.
 */
const SYSTEM_IDENTIFIER_SHAPE = /^[1-9][0-9]{0,19}$/
const UINT64_LIMIT = 18446744073709551616n

export function isSystemIdentifier(v: string): boolean {
  return SYSTEM_IDENTIFIER_SHAPE.test(v) && BigInt(v) < UINT64_LIMIT
}

export interface OperatorInput {
  /** Eight lowercase hex. Names the run, the temporary directory and the bundle. */
  readonly runId: string
  readonly generatedAtUtc: string
  /** The HEAD of the repository whose code produced this manifest. */
  readonly implementationHead: string
  /** The HEAD the operator states as the reviewed provenance of the data. */
  readonly provenanceHead: string
  /** The ingestion submodule's recorded gitlink. */
  readonly ingestionGitlink: string
  /**
   * What the EXPECTED target is CALLED. A label, and recorded as one.
   *
   * Stage 1 never contacts the target, so there is nothing here that could be
   * verified. Storing "ai-capital-v3" under a field called `system_identifier`
   * would dress an operator's word up as a measurement; it is recorded as
   * `expected_target.label`, beside `verified: false`.
   */
  readonly expectedTargetLabel: string
  /**
   * The source cluster's system identifier, as the operator EXPECTS it.
   *
   * Required to equal the value measured from `pg_control_system()`. This is
   * what makes "am I talking to the right database" answerable: a host, port
   * or database name can all be repointed without changing the command line.
   */
  readonly expectedSystemIdentifier: string
  /** A friendly name for the source. A LABEL, recorded under `label`. */
  readonly sourceLabel: string
  /**
   * The endpoint this process ASKED for - the host or socket directory handed
   * to psql. Recorded as a request, never as something the server reported.
   */
  readonly requestedEndpoint: string
  readonly sourcePort: string
  readonly sourceDatabase: string
}

export function assertOperatorInput(i: OperatorInput): OperatorInput {
  const bad = (): never => {
    throw new ManifestRefused('operator-input', 'an operator input is not in the reviewed form')
  }
  if (!RUN_ID.test(i.runId)) bad()
  if (!ISO_UTC.test(i.generatedAtUtc)) bad()
  for (const h of [i.implementationHead, i.provenanceHead, i.ingestionGitlink]) {
    if (!HEX40.test(h)) bad()
  }
  for (const l of [i.expectedTargetLabel, i.sourceLabel, i.requestedEndpoint]) {
    if (!LABEL.test(l) || URL_SCHEME.test(l)) bad()
  }
  if (!isSystemIdentifier(i.expectedSystemIdentifier)) bad()
  if (!PORT.test(i.sourcePort)) bad()
  if (!IDENT.test(i.sourceDatabase)) bad()
  return i
}

// ---------------------------------------------------------------------------
// PROOF HELPERS
// ---------------------------------------------------------------------------

export interface FenceProofFacts {
  readonly provingPid: string
  readonly supervisorPid: string
  readonly relations: number
  readonly ungranted: number
}

/**
 * Take the fence proof on the PROVER and refuse unless it is complete.
 *
 * Runs the reviewed `assertFenceProof`, which already refuses a self-proof, a
 * missing lock and - just as importantly - a lock that is present but
 * UNGRANTED, because a queued writer means the source has been changing.
 */
export async function proveFence(
  prover: ProverSession, fence: AcquiredFence,
): Promise<FenceProofFacts> {
  const pidRes = await prover.send('SELECT pg_catalog.pg_backend_pid()')
  if (pidRes.error !== null) {
    throw new ManifestRefused('fence-proof', 'the fence was not still held')
  }
  const provingPid = pidRes.rows[0]?.[0] ?? ''
  const res = await prover.send(FENCE_PROOF_SQL.replace('$1', fenceRelationArray()))
  if (res.error !== null) {
    throw new ManifestRefused('fence-proof', 'the fence was not still held')
  }
  const rows = parseLockRows(res.rows)
  // The reviewed assertion. Its refusals name only reviewed relations, and are
  // re-raised as a bounded Stage-1 reason so no lock listing reaches a log.
  try {
    assertFenceProof(rows, {
      supervisorPid: fence.supervisorPid, provingPid, mechanism: fence.mechanism,
    })
  } catch {
    throw new ManifestRefused('fence-proof', 'the fence was not still held')
  }
  return Object.freeze({
    provingPid,
    supervisorPid: fence.supervisorPid,
    relations: rows.filter(r => r.kind === 'relation').length,
    ungranted: rows.filter(r => !r.granted).length,
  })
}

/** Everything the SESSION ITSELF reported. Nothing here is operator-supplied. */
export interface ExportIdentity {
  readonly pid: string
  /** pg_control_system().system_identifier, exact decimal. The cluster's name. */
  readonly systemIdentifier: string
  readonly serverVersionNum: string
  readonly database: string
  readonly port: string
  /** The effective role. */
  readonly currentUser: string
  /** The AUTHENTICATED role. Differs from the above after SET ROLE. */
  readonly sessionUser: string
  /** inet_server_addr(), or null - which is what a Unix socket reports. */
  readonly serverAddress: string | null
  readonly unixTransport: boolean
}

/** Prove the export session is the one backend, in the one state, on the one cluster. */
export async function proveExportSession(
  s: ExportSession, i: OperatorInput,
): Promise<ExportIdentity> {
  const rows = await s.rows(EXPORT_IDENTITY_SQL)
  if (rows.length !== 1 || rows[0].length !== EXPORT_IDENTITY_COLUMNS) {
    throw new ManifestRefused(
      'export-identity', 'the export session did not report one row of identity facts')
  }
  const [pid, readOnly, isolation, systemIdentifier, serverVersionNum, database, port,
         currentUser, sessionUser, address, unix] = rows[0]
  if (!/^\d+$/.test(pid) || pid !== s.pid) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not the backend it reported')
  }
  if (readOnly !== REQUIRED_READ_ONLY) {
    throw new ManifestRefused('export-identity', 'the export session is not read only')
  }
  if (isolation !== REQUIRED_ISOLATION) {
    throw new ManifestRefused('export-identity', 'the export session is not repeatable read')
  }
  if (!isSystemIdentifier(systemIdentifier)) {
    throw new ManifestRefused(
      'export-identity', 'the export session did not report a usable system identifier')
  }
  // THE ANCHOR. Checked before the database name, because a matching database
  // name on the wrong cluster is exactly the mistake this catches.
  if (systemIdentifier !== i.expectedSystemIdentifier) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not on the expected source cluster')
  }
  if (database !== i.sourceDatabase) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not connected to the reviewed source database')
  }
  if (port !== i.sourcePort) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not connected to the reviewed source endpoint')
  }
  if (currentUser !== EXPORT_ROLE_NAME) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not authenticated as the reviewed export role')
  }
  if (sessionUser !== currentUser) {
    throw new ManifestRefused(
      'export-identity', 'the export session assumed a role it did not authenticate as')
  }
  const unixTransport = pgBool(unix, 'inet_server_addr() IS NULL')
  return Object.freeze({
    pid, systemIdentifier, serverVersionNum, database, port, currentUser, sessionUser,
    serverAddress: address === '' ? null : address,
    unixTransport,
  })
}

// ---------------------------------------------------------------------------
// CONTENT
// ---------------------------------------------------------------------------

function literal(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

const nullable = (v: string): string | null => (v === '' ? null : v)

/** The live columns of one reviewed table, as the CATALOGUE resolved them. */
export function parseColumnSpecs(rows: readonly (readonly string[])[]): ColumnSpec[] {
  return rows.map(r => ({
    name: r[0],
    formatType: r[1],
    typname: r[2],
    typnamespace: r[3],
    typtype: r[4],
    typcategory: r[5],
    typmod: Number(r[6]),
    sendName: r[7],
    sendNamespace: r[8],
    typeExtension: nullable(r[9]),
    typeExtensionVersion: nullable(r[10]),
    sendExtension: nullable(r[11]),
  }))
}

/**
 * The type contract, taken from the SOURCE contract that was just extracted.
 *
 * NOT a constant. `VECTOR_384` deliberately ships with an empty version, which
 * `assertSupportedColumns` refuses, because a wire-format change between
 * pgvector versions is invisible to `format_type`. The version therefore has to
 * come from a catalogue reading of the live source - which is exactly what the
 * extracted contract is.
 */
export function typeContractFrom(contract: ContractArtifact): TypeContract {
  const platform = (contract.payload as { platform?: { extensions?: unknown } }).platform
  const exts = Array.isArray(platform?.extensions) ? platform.extensions : []
  const vector = (exts as Array<{ name?: unknown; version?: unknown }>)
    .find(e => e.name === VECTOR_384.extension)
  const version = typeof vector?.version === 'string' ? vector.version : ''
  if (version === '') {
    throw new ManifestRefused(
      'contract', 'the source contract states no reviewed vector extension version')
  }
  return Object.freeze({ vector: Object.freeze({ ...VECTOR_384, version }) })
}

export interface TableContent {
  readonly qname: string
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  readonly pkColumns: readonly string[]
  readonly rows: number
  readonly bytes: number
  readonly batches: readonly BatchSummary[]
  readonly digest: string
}

function parseBatches(rows: readonly (readonly string[])[], qname: string): BatchSummary[] {
  return rows.map(r => {
    if (r.length !== 4 || !/^\d+$/.test(r[0]) || !/^\d+$/.test(r[1]) || !/^\d+$/.test(r[2])) {
      throw new ManifestRefused(
        'content', 'a content query did not return the expected batch summary shape', qname)
    }
    return { batch: Number(r[0]), rows: Number(r[1]), bytes: Number(r[2]), digest: r[3] }
  })
}

/**
 * Hash ONE reviewed table, on the export session, inside the one snapshot.
 *
 * THE COLUMN LIST COMES FROM THE CONTRACT, AND THE CATALOGUE MUST AGREE. The
 * contract states which columns exist and in which order; the live catalogue
 * states each column's resolved type and send function, which the digest SQL
 * needs and the contract does not carry in that form. Requiring the two to
 * match exactly means neither is a second, unchecked authority: a column added,
 * dropped or reordered between the contract extraction and this read is a
 * refusal rather than a quietly different digest.
 *
 * A ZERO-ROW TABLE RETURNS NO BATCH ROWS AT ALL - `GROUP BY` produces no groups
 * - so `batches` is empty and `tableDigest` folds the defined empty value. The
 * digest says the table is empty. It says NOTHING about how it came to be
 * empty, and a table that was always empty digests identically to one that was
 * emptied: identical contents are identical, and claiming otherwise would be a
 * lie about what a content digest can do.
 */
export async function hashTable(
  s: ExportSession, contract: ContractArtifact, qname: string, typeContract: TypeContract,
  batchRows: number = DEFAULT_BATCH_ROWS,
): Promise<TableContent> {
  const [schema, table] = qname.split('.')
  const columns = deriveCopyColumns(contract.payload, qname)

  const liveRows = await s.rows(
    LIVE_COLUMNS_SQL.replace('$1', literal(schema)).replace('$2', literal(table)))
  const live = parseColumnSpecs(liveRows)
  if (live.length !== columns.length || live.some((c, i) => c.name !== columns[i])) {
    throw new ManifestRefused('content', 'the live columns do not match the contract columns', qname)
  }

  const pkRows = await s.rows(
    PK_COLUMNS_SQL.replace('$1', literal(schema)).replace('$2', literal(table)))
  const pkColumns = pkRows.map(r => r[0])
  if (pkColumns.length === 0) {
    throw new ManifestRefused('content', 'the table has no primary key to order by', qname)
  }

  const sql = batchDigestSql({
    schema, table, pkColumns, columns: live,
    schemaDigest: contract.digest, contract: typeContract, batchRows,
  })
  const batches = parseBatches(await s.rows(sql), qname)
  const digest = tableDigest({ schema, table, schemaDigest: contract.digest, batches })

  return Object.freeze({
    qname, schema, table,
    columns: Object.freeze(columns),
    pkColumns: Object.freeze(pkColumns),
    rows: batches.reduce((n, b) => n + b.rows, 0),
    bytes: batches.reduce((n, b) => n + b.bytes, 0),
    batches: Object.freeze(batches),
    digest,
  })
}

/**
 * Every reviewed table, EXACTLY ONCE, in the reviewed order.
 *
 * The loop is over `COPY_TABLES` itself rather than over anything the contract
 * or the catalogue offered, so "21, once each, in this order" is a property of
 * the reviewed constant. The result is checked against it again afterwards,
 * because a mutant that drops or repeats one inside the loop would otherwise
 * produce a shorter list that still looked ordered.
 */
export async function hashAllTables(
  s: ExportSession, contract: ContractArtifact, typeContract: TypeContract,
  batchRows: number = DEFAULT_BATCH_ROWS,
): Promise<TableContent[]> {
  const out: TableContent[] = []
  for (const qname of COPY_TABLES) {
    out.push(await hashTable(s, contract, qname, typeContract, batchRows))
  }
  if (out.length !== COPY_TABLES.length || out.some((t, i) => t.qname !== COPY_TABLES[i])) {
    throw new ManifestRefused(
      'content', 'the source contract does not describe the reviewed copy set')
  }
  return out
}

// ---------------------------------------------------------------------------
// THE DOCUMENT
// ---------------------------------------------------------------------------

export interface ManifestInput {
  readonly operator: OperatorInput
  readonly identity: ExportIdentity
  readonly contract: ContractArtifact
  readonly tables: readonly TableContent[]
  readonly sequences: Readonly<Record<string, FencedSequenceState>>
  readonly fence: AcquiredFence
  readonly proof: FenceProofFacts
  readonly batchRows: number
}

/**
 * The manifest document, canonical and versioned.
 *
 * `complete: true` is set HERE, at the end of a function that has already been
 * handed every part - there is no path that writes the marker and then fills
 * something in. The evidence publisher then refuses a manifest without it, so
 * the marker and the bundle's completeness are checked twice, from two sides.
 */
export function buildManifest(i: ManifestInput): Canonical {
  assertOperatorInput(i.operator)
  if (i.contract.pgcopy_schema_contract_version !== SCHEMA_CONTRACT_VERSION) {
    throw new ManifestRefused('contract', 'the source contract is not the reviewed contract version')
  }
  if (i.tables.length !== COPY_TABLES.length ||
      i.tables.some((t, n) => t.qname !== COPY_TABLES[n])) {
    throw new ManifestRefused(
      'content', 'the source contract does not describe the reviewed copy set')
  }
  const seqNames = Object.keys(i.sequences).sort()
  if (seqNames.length !== FENCE_SEQUENCES.length ||
      seqNames.some((q, n) => q !== [...FENCE_SEQUENCES].sort()[n])) {
    throw new ManifestRefused('sequences', 'the fence was not still held')
  }

  const root = rootDigest(i.tables.map(t => ({ schema: t.schema, table: t.table, digest: t.digest })))

  return {
    artifact_version: MANIFEST_ARTIFACT_VERSION,
    run_id: i.operator.runId,
    generated_at_utc: i.operator.generatedAtUtc,
    implementation_head: i.operator.implementationHead,
    provenance_head: i.operator.provenanceHead,
    ingestion_gitlink: i.operator.ingestionGitlink,
    source: {
      // MEASURED. Every value in this block but `label` and
      // `requested_endpoint` came out of the one identity statement, on the
      // one backend, inside the one snapshot. The system identifier in
      // particular is never an operator's word: it is what the cluster calls
      // itself, and the operator's expectation had to match it to get here.
      system_identifier: i.identity.systemIdentifier,
      server_version_num: i.identity.serverVersionNum,
      database: i.identity.database,
      port: i.identity.port,
      current_user: i.identity.currentUser,
      session_user: i.identity.sessionUser,
      backend_pid: i.identity.pid,
      transaction: EXPORT_BEGIN_SQL,
      // What the SERVER said about the transport. NULL address is what a Unix
      // socket reports; PostgreSQL does not report the socket directory, so
      // this document does not pretend it did.
      server_address: i.identity.serverAddress,
      unix_transport: i.identity.unixTransport,
      // OPERATOR-SUPPLIED, and named so. `label` is a friendly name and
      // `requested_endpoint` is the host argument this process handed to psql
      // - a request, not a server-reported fact.
      label: i.operator.sourceLabel,
      requested_endpoint: i.operator.requestedEndpoint,
    },
    expected_target: {
      // STATED, NEVER CONTACTED. Stage 1 opens no target connection at all, so
      // there is nothing here that could have been verified - and a label is
      // recorded as a label rather than under a name that would imply it was
      // measured. The contract digest IS a reviewed compile-time anchor.
      label: i.operator.expectedTargetLabel,
      contract_digest: REVIEWED_CONTRACT_DIGEST,
      operator_supplied: true,
      verified: false,
      contacted: false,
    },
    source_contract: {
      version: i.contract.pgcopy_schema_contract_version,
      digest: i.contract.digest,
      payload: i.contract.payload,
    },
    content: {
      protocol: PGCOPY_PROTOCOL,
      batch_rows: i.batchRows,
      table_count: i.tables.length,
      tables: i.tables.map(t => ({
        qname: t.qname,
        schema: t.schema,
        table: t.table,
        columns: [...t.columns],
        pk_columns: [...t.pkColumns],
        rows: t.rows,
        bytes: t.bytes,
        batch_count: t.batches.length,
        batches: t.batches.map(b => ({
          batch: b.batch, rows: b.rows, bytes: b.bytes, digest: b.digest,
        })),
        digest: t.digest,
      })),
      root_digest: root,
    },
    sequences: [...FENCE_SEQUENCES].map(q => {
      const s = i.sequences[q]
      return {
        qname: q,
        last_value: s.last_value,
        is_called: s.is_called,
        increment_by: s.increment_by,
        min_value: s.min_value,
        max_value: s.max_value,
        start_value: s.start_value,
        cache_size: s.cache_size,
        cycle: s.cycle,
        data_type: s.data_type,
        owned_by: s.owned_by,
        // Decimal strings: these are int8 positions, and JSON numbers are
        // doubles. A position past 2^53 would round silently.
        effective_next: effectiveNext(s, q).toString(),
      }
    }),
    fence: {
      mechanism: i.fence.mechanism,
      supervisor_pid: i.fence.supervisorPid,
      proving_pid: i.proof.provingPid,
      tables: [...i.fence.tables],
      sequences: [...i.fence.sequences],
      reviewed_relations_locked: i.proof.relations,
      ungranted_requests: i.proof.ungranted,
    },
    complete: true,
  }
}

// ---------------------------------------------------------------------------
// STAGE 1
// ---------------------------------------------------------------------------

export interface Stage1Input {
  readonly supervisor: SupervisorSession
  readonly prover: ProverSession
  readonly exportSession: ExportSession
  readonly operator: OperatorInput
  readonly evidenceRoot: string
  readonly batchRows?: number
  /** Injected only by tests, to exercise branches a real filesystem will not take. */
  readonly ops?: EvidenceOps
}

export interface Stage1Result {
  readonly published: PublishedEvidence
  readonly manifest: Canonical
  readonly rootDigest: string
  readonly contractDigest: string
  /** The cluster the manifest was measured from, exact decimal. */
  readonly systemIdentifier: string
  readonly fence: AcquiredFence
  /** Every phase completed, in order. The ORDER is the guarantee. */
  readonly timeline: readonly string[]
  /** Every statement the export role was asked for, in order. */
  readonly exportStatements: readonly string[]
}

/**
 * Stage 1, end to end, in the one order that makes it mean anything.
 *
 * THE FENCE IS RELEASED BY THE CALLER, NOT HERE. This function never commits,
 * rolls back or closes the supervisor's transaction: the caller owns it, and
 * the caller releases it only after this returns. What this function DOES
 * guarantee is that the fence was still held - proved from a different backend
 * - after the manifest was published AND after the source transaction was
 * rolled back. A mutant that released it earlier fails those proofs rather
 * than producing a manifest nobody can tell is wrong.
 *
 * NO TARGET IS CONSTRUCTED OR CONTACTED. There is no target parameter, no
 * target session type and no connection construction anywhere in this file.
 */
export async function runStage1(i: Stage1Input): Promise<Stage1Result> {
  const operator = assertOperatorInput(i.operator)
  const batchRows = i.batchRows ?? DEFAULT_BATCH_ROWS
  const timeline: string[] = []

  // 1-2. The whole fence, then an INDEPENDENT proof, before anything else.
  //
  // The reviewed fence and contract primitives raise errors that name the
  // failing STATEMENT and, for the fence, carry psql's stderr. Both are
  // appropriate inside their own modules and neither may cross Stage 1's
  // boundary, where the result is about to be reported and logged - so each is
  // re-raised as a bounded reason here.
  let fence: AcquiredFence
  try {
    fence = await acquireSourceFence(i.supervisor)
  } catch (e) {
    throw e instanceof ManifestRefused
      ? e : new ManifestRefused('fence', 'the source fence could not be taken')
  }
  timeline.push('fence-acquired')
  await proveFence(i.prover, fence)
  timeline.push('fence-proved')

  // 3. The export session's FIRST statement.
  const exp = guardExportSession(i.exportSession)
  await exp.rows(EXPORT_BEGIN_SQL)
  timeline.push('export-begun')

  // 4. One backend, read only, repeatable read, on the reviewed source.
  const identity = await proveExportSession(exp, operator)
  timeline.push('export-proved')

  // 5. The schema contract, from that same backend and that same snapshot.
  let contract: ContractArtifact
  try {
    contract = await extractContractFromSession(exp, identity.pid)
  } catch (e) {
    throw e instanceof ManifestRefused
      ? e : new ManifestRefused('contract', 'the source contract could not be extracted')
  }
  timeline.push('contract-extracted')

  // 6. The content, 21 tables, once each, in the reviewed order.
  const typeContract = typeContractFrom(contract)
  const tables = await hashAllTables(exp, contract, typeContract, batchRows)
  timeline.push('content-hashed')

  // 7. Mutable sequence state, from the SUPERVISOR only, after its own proof.
  let sequences: Record<string, FencedSequenceState>
  try {
    sequences = await readFencedSequenceState(i.supervisor, i.prover, fence)
  } catch (e) {
    throw e instanceof ManifestRefused
      ? e : new ManifestRefused('sequences', 'the fenced sequence state could not be read')
  }
  timeline.push('sequences-read')

  // 8. Re-prove: same supervisor backend, whole fence, nothing queued.
  const supervisorPid = await i.supervisor.send('SELECT pg_catalog.pg_backend_pid()')
  if (supervisorPid.error !== null || supervisorPid.rows[0]?.[0] !== fence.supervisorPid) {
    throw new ManifestRefused('reprove', 'the supervisor backend changed during derivation')
  }
  const proof = await proveFence(i.prover, fence)
  timeline.push('fence-reproved')

  // 9. Publish, WHILE THE FENCE IS HELD.
  const manifest = buildManifest({
    operator, identity, contract, tables, sequences, fence, proof, batchRows,
  })
  if ((manifest as { complete?: unknown }).complete !== true) {
    throw new ManifestRefused('publish', 'the manifest is not complete')
  }
  const artifacts: EvidenceArtifact[] = [{
    path: SOURCE_CONTRACT_FILE,
    bytes: Buffer.from(`${serializeArtifact(contract)}\n`, 'utf-8'),
  }]
  const published = publishEvidence({
    root: i.evidenceRoot,
    prefix: MANIFEST_PREFIX,
    stamp: evidenceStamp(new Date(operator.generatedAtUtc)),
    runId: operator.runId,
    artifacts,
    manifest: {
      path: MANIFEST_FILE,
      bytes: Buffer.from(`${canonicalJson(manifest)}\n`, 'utf-8'),
    },
  }, i.ops)
  timeline.push('published')
  await proveFence(i.prover, fence)
  timeline.push('fence-held-at-publication')

  // 10. End the source transaction. Nothing is committed: it read only.
  await exp.rows(EXPORT_ROLLBACK_SQL)
  timeline.push('source-rolled-back')
  await proveFence(i.prover, fence)
  timeline.push('fence-held-at-rollback')

  // 11. The caller releases the fence, now that both have completed.
  return Object.freeze({
    published,
    manifest,
    systemIdentifier: identity.systemIdentifier,
    rootDigest: ((manifest as { content: { root_digest: string } }).content).root_digest,
    contractDigest: contract.digest,
    fence,
    timeline: Object.freeze(timeline),
    exportStatements: exp.issued,
  })
}

/** Re-exported so a caller never has to name the digest file itself. */
export { DIGEST_FILE }
