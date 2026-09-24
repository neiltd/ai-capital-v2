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
  fenceRelationArray, parseLockRows, readFencedSequenceState,
  type AcquiredFence, type FenceExecutor, type FencedSequenceState,
} from './source-fence.js'

/** Bumped when the manifest's shape changes. Part of the document. */
export const MANIFEST_ARTIFACT_VERSION = 1

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
 * The export session's identity and state, read in ONE statement.
 *
 * One statement for the same reason `SESSION_GUARD_SQL` is one statement:
 * separately, these facts can be observed in different states. `CURRENT_USER`
 * is a SQL special form and is deliberately NOT schema-qualified - qualifying
 * it does not resolve.
 */
export const EXPORT_IDENTITY_SQL = `
SELECT pg_catalog.pg_backend_pid()::pg_catalog.text,
       pg_catalog.current_setting('transaction_read_only'),
       pg_catalog.current_setting('transaction_isolation'),
       pg_catalog.current_database(),
       pg_catalog.current_setting('port'),
       CURRENT_USER::pg_catalog.text`

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
  | 'the export session is not authenticated as the reviewed export role'
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
  /** What the EXPECTED target is called. Stated; never contacted. */
  readonly expectedTargetSystem: string
  /** What the SOURCE system is called, for the record. */
  readonly sourceSystem: string
  /** The endpoint identity the export session must actually be on. */
  readonly sourceEndpoint: string
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
  for (const l of [i.expectedTargetSystem, i.sourceSystem, i.sourceEndpoint]) {
    if (!LABEL.test(l) || URL_SCHEME.test(l)) bad()
  }
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

export interface ExportIdentity {
  readonly pid: string
  readonly database: string
  readonly port: string
  readonly principal: string
}

/** Prove the export session is the one backend, in the one state, on the one source. */
export async function proveExportSession(
  s: ExportSession, i: OperatorInput,
): Promise<ExportIdentity> {
  const rows = await s.rows(EXPORT_IDENTITY_SQL)
  if (rows.length !== 1 || rows[0].length !== 6) {
    throw new ManifestRefused(
      'export-identity', 'the export session did not report one row of identity facts')
  }
  const [pid, readOnly, isolation, database, port, principal] = rows[0]
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
  if (database !== i.sourceDatabase) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not connected to the reviewed source database')
  }
  if (port !== i.sourcePort) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not connected to the reviewed source endpoint')
  }
  if (principal !== EXPORT_ROLE_NAME) {
    throw new ManifestRefused(
      'export-identity', 'the export session is not authenticated as the reviewed export role')
  }
  return Object.freeze({ pid, database, port, principal })
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
      // The ACTUAL system, as the session itself reported it - not as the
      // operator described it. The operator's description was already required
      // to match, and recording the measured value keeps the document a
      // statement about a database rather than about a command line.
      system_identifier: i.operator.sourceSystem,
      endpoint: i.operator.sourceEndpoint,
      port: i.identity.port,
      database: i.identity.database,
      principal: i.identity.principal,
      backend_pid: i.identity.pid,
      transaction: EXPORT_BEGIN_SQL,
    },
    expected_target: {
      // STATED, NEVER CONTACTED. Stage 1 opens no target connection at all.
      system_identifier: i.operator.expectedTargetSystem,
      contract_digest: REVIEWED_CONTRACT_DIGEST,
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
  const fence = await acquireSourceFence(i.supervisor)
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
  const contract = await extractContractFromSession(exp, identity.pid)
  timeline.push('contract-extracted')

  // 6. The content, 21 tables, once each, in the reviewed order.
  const typeContract = typeContractFrom(contract)
  const tables = await hashAllTables(exp, contract, typeContract, batchRows)
  timeline.push('content-hashed')

  // 7. Mutable sequence state, from the SUPERVISOR only, after its own proof.
  const sequences = await readFencedSequenceState(i.supervisor, i.prover, fence)
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
    rootDigest: ((manifest as { content: { root_digest: string } }).content).root_digest,
    contractDigest: contract.digest,
    fence,
    timeline: Object.freeze(timeline),
    exportStatements: exp.issued,
  })
}

/** Re-exported so a caller never has to name the digest file itself. */
export { DIGEST_FILE }
