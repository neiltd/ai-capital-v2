// THE INDEPENDENT CONTENT ALGORITHM — written from the contract, not from the copier.
//
// WHY A SECOND IMPLEMENTATION AT ALL. Stage 2 already derives a manifest on the
// target and compares it with the source's. Both of those derivations run
// through ONE module. If that module normalises something - trims a numeric
// scale, renders a value as text, orders a batch by something other than the
// primary key - then the source digest and the target digest are wrong in
// exactly the same way, they agree, and the copy is declared correct. A
// self-consistent mistake is invisible to the thing that made it.
//
// So this file re-implements the canonical content algorithm from its WRITTEN
// contract, and imports nothing from `canonical.ts`, `source-manifest.ts` or
// `stage2.ts`. The two implementations must agree on every byte; where they do
// not, one of them is wrong and the verifier refuses rather than picking a
// winner.
//
// THE CONTRACT THIS FILE IMPLEMENTS, in full, so it can be checked by reading:
//
//   ROW FRAME, as one bytea value:
//     int4send(<number of live columns>)
//     then, per column, in the reviewed column order, 1-based ordinal N:
//       int4send(N)
//       NULL     -> 0x00
//       non-NULL -> 0x01 || int4send(octet_length(send(v))) || send(v)
//
//   BATCH: rows ordered by the primary key in constraint order, cut into
//   fixed-size batches, batch ordinal 0-based. The digest is
//     sha256(utf8( "pgcopy1|batch|<schema.table>|<schema digest>|b=<ordinal>"
//                  "|rows=<n>|bytes=<n>|" <sha256 hex of each row frame, in
//                  primary-key order, concatenated with no separator> ))
//
//   TABLE:
//     sha256(utf8( "pgcopy1|table|<schema.table>|<schema digest>|nb=<batches>"
//                  "|rows=<n>|bytes=<n>|" <"b:rows:bytes:digest" per batch,
//                  joined with "|"> ))
//
//   ROOT:
//     sha256(utf8( "pgcopy1|root|n=<tables>|" <"schema.table=digest" per table,
//                  joined with "|"> ))
//
// FOUR THINGS THIS FILE MUST NEVER DO, each of which would make it agree with a
// broken copier instead of disagreeing with it:
//
//   NO trim_scale, ANYWHERE. `numeric_send` encodes the stored display scale.
//   1.10 and 1.1 are equal under `=` and are DIFFERENT values; a verifier that
//   normalised them would confirm a copy that had silently changed them.
//
//   NO TEXT RENDERING. Every payload is the type's own binary send function,
//   resolved through the catalogue and called schema-qualified, so neither
//   `search_path` nor a locale can choose how a value is hashed.
//
//   NO UNORDERED OR SUM-BASED AGGREGATION. Row hashes are concatenated in
//   primary-key order. `sum()` over row hashes would be a digest of a multiset:
//   two rows could swap values and it would not notice.
//
//   NO SELECT *. The column list comes from the reviewed contract and the live
//   catalogue has to agree with it, name for name, in order.

import { createHash } from 'node:crypto'

import { COPY_TABLES, deriveCopyColumns, type Canonical, type ContractArtifact }
  from './schema-contract.js'

/** The wire protocol tag. The same value as the copier's, INDEPENDENTLY stated. */
export const VERIFY_PROTOCOL = 'pgcopy1'

/** The only namespace a built-in type or helper may resolve to. */
export const VERIFY_CATALOG = 'pg_catalog'

/** Rows per batch. Matches the copier's reviewed default. */
export const VERIFY_BATCH_ROWS = 10_000

/** A refusal from the independent content path. */
export class VerifyContentRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyContentRefused'
  }
}

/**
 * The reviewed built-in types and the EXACT send function each is hashed with.
 *
 * Written out here rather than imported, because importing it would mean a
 * single edit could change both implementations at once - and then the two
 * digests would still agree, which is precisely the failure this file exists to
 * detect. `numeric` maps to `numeric_send` and to nothing else: there is no
 * trim, no cast, no normalisation.
 */
export const VERIFY_SEND: Readonly<Record<string, string>> = Object.freeze({
  bool: 'boolsend',
  date: 'date_send',
  int4: 'int4send',
  int8: 'int8send',
  jsonb: 'jsonb_send',
  numeric: 'numeric_send',
  text: 'textsend',
  timestamptz: 'timestamptz_send',
  uuid: 'uuid_send',
})

/** The one reviewed extension type, and everything that must hold of it. */
export interface VerifyVector {
  readonly extension: string
  readonly version: string
  readonly dimension: number
  readonly sendName: string
}

export const VERIFY_VECTOR_EXTENSION = 'vector'
export const VERIFY_VECTOR_SEND = 'vector_send'
export const VERIFY_VECTOR_DIMENSION = 384

/** One live column as the catalogue RESOLVED it. Names prove nothing. */
export interface VerifyColumn {
  readonly name: string
  readonly typname: string
  readonly typNamespace: string
  readonly typtype: string
  readonly typcategory: string
  readonly typmod: number
  readonly sendName: string
  readonly sendNamespace: string
  readonly typeExtension: string | null
  readonly typeExtensionVersion: string | null
  readonly sendExtension: string | null
}

const IDENT = /^[a-z_][a-z0-9_]*$/
const HEX64 = /^[0-9a-f]{64}$/

function ident(kind: string, name: string): string {
  if (!IDENT.test(name) || name.length > 63) {
    throw new VerifyContentRefused(
      `${kind} is outside the reviewed identifier grammar; it is refused, never escaped.`)
  }
  return name
}

function quoted(name: string): string {
  return `"${ident('an identifier', name)}"`
}

function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

function digest64(kind: string, value: string): string {
  if (!HEX64.test(value)) {
    throw new VerifyContentRefused(`${kind} is not 64 lowercase hexadecimal characters.`)
  }
  return value
}

function sha256Utf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

/**
 * The vector contract, read out of the SOURCE contract that was just extracted.
 *
 * The version cannot be a constant: a wire-format change between pgvector
 * releases is invisible to `format_type`, so the only honest source for it is a
 * catalogue reading of the database actually being hashed.
 */
export function verifyVectorFrom(contract: ContractArtifact): VerifyVector {
  const platform = (contract.payload as { platform?: { extensions?: unknown } }).platform
  const list = Array.isArray(platform?.extensions) ? platform.extensions : []
  const found = (list as Array<{ name?: unknown; version?: unknown }>)
    .find(e => e.name === VERIFY_VECTOR_EXTENSION)
  const version = typeof found?.version === 'string' ? found.version : ''
  if (version === '') {
    throw new VerifyContentRefused(
      'the contract states no installed vector extension version, so no vector column can be ' +
      'hashed against a reviewed wire format.')
  }
  return Object.freeze({
    extension: VERIFY_VECTOR_EXTENSION,
    version,
    dimension: VERIFY_VECTOR_DIMENSION,
    sendName: VERIFY_VECTOR_SEND,
  })
}

/**
 * Refuse any column this algorithm is not willing to hash, BEFORE any row is read.
 *
 * Category checks run first, so a domain over `text` is refused AS a domain;
 * namespace checks run before name checks, so a `public.text` cannot pass on the
 * strength of the word "text".
 */
export function assertVerifiableColumns(
  columns: readonly VerifyColumn[], vector: VerifyVector,
): void {
  if (columns.length === 0) {
    throw new VerifyContentRefused('the table has no live columns; there is nothing to hash.')
  }
  for (const c of columns) {
    const where = `column "${c.name}"`
    if (c.typcategory === 'A') throw new VerifyContentRefused(`${where}: array types are refused.`)
    if (c.typtype === 'c') throw new VerifyContentRefused(`${where}: composite types are refused.`)
    if (c.typtype === 'd') throw new VerifyContentRefused(`${where}: domain types are refused.`)
    if (c.typtype === 'e') throw new VerifyContentRefused(`${where}: enum types are refused.`)
    if (c.typtype === 'r' || c.typtype === 'm') {
      throw new VerifyContentRefused(`${where}: range types are refused.`)
    }

    if (c.typNamespace === VERIFY_CATALOG) {
      if (c.typname === 'float4' || c.typname === 'float8') {
        throw new VerifyContentRefused(
          `${where}: float4 and float8 are refused - -0.0 = 0.0 and NaN <> NaN, so a bit-exact ` +
          'digest and a row comparison would disagree about equality.')
      }
      const expected = VERIFY_SEND[c.typname]
      if (expected === undefined) {
        throw new VerifyContentRefused(
          `${where}: "${c.typname}" is not in the reviewed built-in set.`)
      }
      if (c.sendNamespace !== VERIFY_CATALOG || c.sendName !== expected) {
        throw new VerifyContentRefused(
          `${where}: its send function resolves to ${c.sendNamespace}.${c.sendName}, not ` +
          `${VERIFY_CATALOG}.${expected}. A shadowed send function would let the database ` +
          'choose how its own values are hashed.')
      }
      if (c.typeExtension !== null) {
        throw new VerifyContentRefused(
          `${where}: a ${VERIFY_CATALOG} type is not owned by an extension.`)
      }
      continue
    }

    // Outside pg_catalog, exactly one reviewed extension type is accepted.
    if (c.typname !== VERIFY_VECTOR_EXTENSION) {
      throw new VerifyContentRefused(
        `${where}: "${c.typNamespace}.${c.typname}" is not the reviewed extension type.`)
    }
    if (c.typeExtension !== vector.extension || c.sendExtension !== vector.extension) {
      throw new VerifyContentRefused(
        `${where}: the type or its send function is not a member of extension ` +
        `"${vector.extension}".`)
    }
    if (c.sendName !== vector.sendName) {
      throw new VerifyContentRefused(
        `${where}: its send function is "${c.sendName}", not "${vector.sendName}".`)
    }
    if (c.sendNamespace !== c.typNamespace) {
      throw new VerifyContentRefused(
        `${where}: the type and its send function are in different namespaces.`)
    }
    if (c.typeExtensionVersion !== vector.version) {
      throw new VerifyContentRefused(
        `${where}: extension "${vector.extension}" is not at the reviewed installed version.`)
    }
    // pgvector stores the DIMENSION DIRECTLY in atttypmod - no VARHDRSZ term.
    if (c.typmod !== vector.dimension) {
      throw new VerifyContentRefused(
        `${where}: dimension ${c.typmod} is not the reviewed ${vector.dimension}.`)
    }
  }
}

/** The fully-qualified send call. ALWAYS schema-qualified; never bare. */
function send(c: VerifyColumn): string {
  return `${quoted(c.sendNamespace)}.${quoted(c.sendName)}`
}

/** `schema.table`, unquoted, as it appears inside every hashed header. */
export function verifyQname(schema: string, table: string): string {
  return `${ident('a schema name', schema)}.${ident('a table name', table)}`
}

/**
 * The row frame, as one `bytea` expression. See the contract at the top.
 *
 * LENGTH-FRAMED AND TAGGED. Without the length prefix a value containing the
 * bytes of the next value's start cannot be told from two different values;
 * without the NULL tag, a NULL and an empty string would frame identically.
 */
export function verifyRowFrameSql(
  columns: readonly VerifyColumn[], vector: VerifyVector,
): string {
  assertVerifiableColumns(columns, vector)
  const C = VERIFY_CATALOG
  const pieces: string[] = [`${C}.int4send(${columns.length})`]
  for (let n = 0; n < columns.length; n += 1) {
    const c = columns[n]
    const col = quoted(c.name)
    const fn = send(c)
    pieces.push(`${C}.int4send(${n + 1})`)
    pieces.push(
      `CASE WHEN ${col} IS NULL THEN '\\x00'::${C}.bytea ELSE '\\x01'::${C}.bytea ` +
      `|| ${C}.int4send(${C}.octet_length(${fn}(${col}))) || ${fn}(${col}) END`)
  }
  return pieces.join(' || ')
}

export interface VerifyBatchInput {
  readonly schema: string
  readonly table: string
  /** Primary-key columns in CONSTRAINT order. Alphabetical would be a bug. */
  readonly pkColumns: readonly string[]
  readonly columns: readonly VerifyColumn[]
  readonly schemaDigest: string
  readonly vector: VerifyVector
  readonly batchRows?: number
}

/**
 * The batch query. One scan; the server returns four scalars per batch.
 *
 * Row hashes are folded in an inner step and aggregated in an outer one, with
 * `string_agg(... ORDER BY rn)` - an ORDERED concatenation, never a sum and
 * never an unordered aggregate.
 */
export function verifyBatchSql(i: VerifyBatchInput): string {
  const batchRows = i.batchRows ?? VERIFY_BATCH_ROWS
  if (!Number.isSafeInteger(batchRows) || batchRows < 1) {
    throw new VerifyContentRefused('the batch size is not a positive safe integer.')
  }
  if (i.pkColumns.length === 0) {
    throw new VerifyContentRefused(
      'a deterministic digest needs a primary key to order by; there is none.')
  }
  const C = VERIFY_CATALOG
  const frame = verifyRowFrameSql(i.columns, i.vector)
  const qname = verifyQname(i.schema, i.table)
  const schemaDigest = digest64('the schema digest', i.schemaDigest)
  const order = i.pkColumns.map(p => quoted(p)).join(', ')
  const rel = `${quoted(i.schema)}.${quoted(i.table)}`
  const header = `${VERIFY_PROTOCOL}|batch|${qname}|${schemaDigest}|b=`
  return [
    'WITH framed AS (',
    `  SELECT ${C}.row_number() OVER (ORDER BY ${order}) AS rn, ${frame} AS f`,
    `    FROM ${rel}`,
    '), folded AS (',
    `  SELECT ((rn - 1) / ${batchRows})::${C}.int4 AS b, rn,`,
    `         ${C}.octet_length(f) AS len,`,
    `         ${C}.encode(${C}.sha256(f), 'hex') AS rh`,
    '    FROM framed',
    ')',
    'SELECT b,',
    `       ${C}.count(*)::${C}.int8,`,
    `       ${C}.sum(len)::${C}.int8,`,
    `       ${C}.encode(${C}.sha256(${C}.convert_to(`,
    `         ${literal(header)} || b::${C}.text`,
    `         || '|rows=' || ${C}.count(*)::${C}.text`,
    `         || '|bytes=' || ${C}.sum(len)::${C}.text`,
    `         || '|' || ${C}.string_agg(rh, '' ORDER BY rn), 'UTF8')), 'hex')`,
    '  FROM folded',
    ' GROUP BY b',
    ' ORDER BY b',
  ].join('\n')
}

/** One batch, exactly as the server reported it. */
export interface VerifyBatch {
  readonly batch: number
  readonly rows: number
  readonly bytes: number
  readonly digest: string
}

function count(kind: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new VerifyContentRefused(`${kind} is not a non-negative safe integer.`)
  }
  return n
}

export interface VerifyTableDigestInput {
  readonly schema: string
  readonly table: string
  readonly schemaDigest: string
  readonly batches: readonly VerifyBatch[]
}

/**
 * The table digest: the ordered batch records and the totals.
 *
 * ORDINALS MUST BE 0..n-1, contiguous, no repeat - refused, never sorted or
 * de-duplicated. A gap means a batch was lost and repairing it here would hide
 * exactly what the ordered fold exists to catch. A zero-row table is a DEFINED
 * value (`nb=0|rows=0|bytes=0|`), and says nothing about how it became empty.
 */
export function verifyTableDigest(i: VerifyTableDigestInput): string {
  const schemaDigest = digest64('the schema digest', i.schemaDigest)
  const qname = verifyQname(i.schema, i.table)
  i.batches.forEach((b, n) => {
    count(`batch ordinal at position ${n}`, b.batch)
    count(`the row count of batch ${b.batch}`, b.rows)
    count(`the byte count of batch ${b.batch}`, b.bytes)
    digest64(`the digest of batch ${b.batch}`, b.digest)
    if (b.batch !== n) {
      throw new VerifyContentRefused(
        `the batch summaries are not a contiguous 0-based sequence at position ${n}.`)
    }
  })
  const rows = i.batches.reduce((n, b) => n + b.rows, 0)
  const bytes = i.batches.reduce((n, b) => n + b.bytes, 0)
  const body = i.batches.map(b => `${b.batch}:${b.rows}:${b.bytes}:${b.digest}`).join('|')
  return sha256Utf8(
    `${VERIFY_PROTOCOL}|table|${qname}|${schemaDigest}` +
    `|nb=${i.batches.length}|rows=${rows}|bytes=${bytes}|${body}`)
}

export interface VerifyTableRecord {
  readonly schema: string
  readonly table: string
  readonly digest: string
}

/** The root digest: the explicit ordered table list and its count. */
export function verifyRootDigest(tables: readonly VerifyTableRecord[]): string {
  const seen = new Set<string>()
  const body = tables.map(t => {
    digest64(`the table digest for ${t.schema}.${t.table}`, t.digest)
    const q = verifyQname(t.schema, t.table)
    if (seen.has(q)) {
      throw new VerifyContentRefused(`table ${q} appears more than once in the root set.`)
    }
    seen.add(q)
    return `${q}=${t.digest}`
  }).join('|')
  return sha256Utf8(`${VERIFY_PROTOCOL}|root|n=${tables.length}|${body}`)
}

// ---------------------------------------------------------------------------
// THE CATALOGUE, read this module's own way
// ---------------------------------------------------------------------------

/**
 * Live columns with every identity RESOLVED. `typname = 'text'` is a name.
 *
 * `typsend` is the only authority on which function PostgreSQL will call, and
 * resolving it here is what lets the generated SQL name that function
 * explicitly instead of letting `search_path` decide.
 */
export const VERIFY_COLUMNS_SQL = `
SELECT att.attname,
       typ.typname,
       tns.nspname,
       typ.typtype::pg_catalog.text,
       typ.typcategory::pg_catalog.text,
       att.atttypmod,
       snd.proname,
       sns.nspname,
       tex.extname,
       tex.extversion,
       sex.extname
  FROM pg_catalog.pg_attribute att
  JOIN pg_catalog.pg_class     rel ON rel.oid = att.attrelid
  JOIN pg_catalog.pg_namespace rns ON rns.oid = rel.relnamespace
  JOIN pg_catalog.pg_type      typ ON typ.oid = att.atttypid
  JOIN pg_catalog.pg_namespace tns ON tns.oid = typ.typnamespace
  LEFT JOIN pg_catalog.pg_proc      snd ON snd.oid = typ.typsend
  LEFT JOIN pg_catalog.pg_namespace sns ON sns.oid = snd.pronamespace
  LEFT JOIN pg_catalog.pg_depend    tdp ON tdp.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
                                       AND tdp.objid = typ.oid AND tdp.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension tex ON tex.oid = tdp.refobjid
  LEFT JOIN pg_catalog.pg_depend    sdp ON sdp.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                                       AND sdp.objid = snd.oid AND sdp.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension sex ON sex.oid = sdp.refobjid
 WHERE rns.nspname = $1 AND rel.relname = $2
   AND att.attnum > 0 AND NOT att.attisdropped
 ORDER BY att.attnum`

/** Primary-key columns in CONSTRAINT order. Ordinality, not alphabetical. */
export const VERIFY_PK_SQL = `
SELECT att.attname
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class     rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace rns ON rns.oid = rel.relnamespace
  JOIN LATERAL pg_catalog.unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_catalog.pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
 WHERE rns.nspname = $1 AND rel.relname = $2 AND con.contype = 'p'
 ORDER BY k.ord`

/** Anything that can run a statement and hand back psql-shaped rows. */
export interface VerifySession {
  readonly pid: string
  rows(sql: string): Promise<string[][]>
}

const orNull = (v: string): string | null => (v === '' ? null : v)

export function parseVerifyColumns(rows: readonly (readonly string[])[]): VerifyColumn[] {
  return rows.map(r => {
    if (r.length !== 11) {
      throw new VerifyContentRefused('a column description did not have the expected shape.')
    }
    return {
      name: r[0],
      typname: r[1],
      typNamespace: r[2],
      typtype: r[3],
      typcategory: r[4],
      typmod: Number(r[5]),
      sendName: r[6],
      sendNamespace: r[7],
      typeExtension: orNull(r[8]),
      typeExtensionVersion: orNull(r[9]),
      sendExtension: orNull(r[10]),
    }
  })
}

/** One table's independently measured content. */
export interface VerifiedTable {
  readonly qname: string
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  readonly pkColumns: readonly string[]
  readonly rows: number
  readonly bytes: number
  readonly batches: readonly VerifyBatch[]
  readonly digest: string
}

function parseVerifyBatches(rows: readonly (readonly string[])[]): VerifyBatch[] {
  return rows.map(r => {
    if (r.length !== 4 || !/^\d+$/.test(r[0]) || !/^\d+$/.test(r[1]) || !/^\d+$/.test(r[2])) {
      throw new VerifyContentRefused('a batch summary did not have the expected shape.')
    }
    return { batch: Number(r[0]), rows: Number(r[1]), bytes: Number(r[2]), digest: r[3] }
  })
}

/**
 * Measure ONE reviewed table on one session, inside that session's snapshot.
 *
 * The column list comes from the CONTRACT and the live catalogue must agree
 * with it name for name in order, so neither is a second unchecked authority.
 * `schemaDigest` is the SOURCE contract's digest on both sides: the table
 * digest folds it, so a target hashed against its own contract could never
 * equal the source no matter how identical the rows.
 */
export async function verifyTable(
  s: VerifySession, contract: ContractArtifact, qname: string, vector: VerifyVector,
  batchRows: number = VERIFY_BATCH_ROWS,
): Promise<VerifiedTable> {
  const [schema, table] = qname.split('.')
  const expected = deriveCopyColumns(contract.payload as Canonical, qname)

  const bind = (sql: string): string =>
    sql.replace('$1', literal(schema)).replace('$2', literal(table))

  const live = parseVerifyColumns(await s.rows(bind(VERIFY_COLUMNS_SQL)))
  if (live.length !== expected.length || live.some((c, n) => c.name !== expected[n])) {
    throw new VerifyContentRefused(
      `${qname}: the live columns do not match the contract columns.`)
  }

  const pkColumns = (await s.rows(bind(VERIFY_PK_SQL))).map(r => r[0])
  if (pkColumns.length === 0) {
    throw new VerifyContentRefused(`${qname}: there is no primary key to order by.`)
  }

  const batches = parseVerifyBatches(await s.rows(verifyBatchSql({
    schema, table, pkColumns, columns: live,
    schemaDigest: contract.digest, vector, batchRows,
  })))
  const digest = verifyTableDigest({ schema, table, schemaDigest: contract.digest, batches })

  return Object.freeze({
    qname, schema, table,
    columns: Object.freeze([...expected]),
    pkColumns: Object.freeze(pkColumns),
    rows: batches.reduce((n, b) => n + b.rows, 0),
    bytes: batches.reduce((n, b) => n + b.bytes, 0),
    batches: Object.freeze(batches),
    digest,
  })
}

/** The whole measured content of one database: every table, then the root. */
export interface VerifiedContent {
  readonly tables: readonly VerifiedTable[]
  readonly rootDigest: string
}

/**
 * Every reviewed table, EXACTLY ONCE, in the EXPLICIT reviewed order.
 *
 * The loop is over `COPY_TABLES` itself, so "21, once each, in this order" is a
 * property of the reviewed constant rather than of a list assembled here; the
 * result is checked against it again afterwards, because a mutant that dropped
 * or repeated one inside the loop would otherwise produce a shorter list that
 * still looked ordered.
 */
export async function verifyAllTables(
  s: VerifySession, contract: ContractArtifact, vector: VerifyVector,
  batchRows: number = VERIFY_BATCH_ROWS,
): Promise<VerifiedContent> {
  const tables: VerifiedTable[] = []
  for (const qname of COPY_TABLES) {
    tables.push(await verifyTable(s, contract, qname, vector, batchRows))
  }
  if (tables.length !== COPY_TABLES.length ||
      tables.some((t, n) => t.qname !== COPY_TABLES[n])) {
    throw new VerifyContentRefused('the measured table set is not the reviewed copy set.')
  }
  return Object.freeze({
    tables: Object.freeze(tables),
    rootDigest: verifyRootDigest(
      tables.map(t => ({ schema: t.schema, table: t.table, digest: t.digest }))),
  })
}
