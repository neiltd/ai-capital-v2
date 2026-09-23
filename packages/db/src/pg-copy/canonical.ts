// The canonical content digest — slice 1 of the PostgreSQL→PostgreSQL copy.
//
// WHAT THIS IS FOR. The copy asserts that two databases hold the same values,
// and the only honest way to say that is a digest neither side can influence
// independently. This module builds the SQL that produces it, plus the pure
// folds above it.
//
// FOUR RULES, AND EVERY DEFECT THIS MODULE EXISTS TO PREVENT IS ONE OF THEM
// BROKEN:
//
//   1. VALUES ARE NEVER RENDERED AS TEXT. Every payload is the type's own
//      binary `*_send()` output. A decimal rendering of a float, a locale-aware
//      rendering of a timestamp, or a `::text` cast of a numeric introduces a
//      representation the database never stored.
//
//   2. FRAMING IS EXPLICIT AND LENGTH-PREFIXED. No delimiter appears inside a
//      value. `concat_ws('|', a, b)` cannot distinguish ('a|b', NULL) from
//      ('a', 'b'), and a NULL that contributes nothing cannot be distinguished
//      from an empty string. Every value carries a tag; every non-NULL value
//      carries its own byte length before its bytes.
//
//   3. AGGREGATION IS ORDERED AND SELF-DESCRIBING. A digest folded without an
//      ORDER BY is a digest of a set. Each level also names itself - protocol,
//      table, schema digest, ordinal, counts - so a batch cannot be moved,
//      renamed or resized without changing the value.
//
//   4. IDENTITY IS RESOLVED, NOT NAMED. A type called `text` is not the type
//      `pg_catalog.text`, and a function called `textsend` reached through
//      `search_path` is not `pg_catalog.textsend`. Every type is accepted only
//      when its NAMESPACE and its resolved send function match the reviewed
//      contract, and every generated call is schema-qualified so resolution
//      cannot be redirected. Without this the digest is computed by whatever
//      the session's `search_path` happened to find - which is a value the
//      source can choose.
//
// NUMERIC SCALE IS PRESERVED. `numeric_send` encodes the stored display scale,
// so 1.10 and 1.1 - equal under `=` - digest DIFFERENTLY. Binary COPY preserves
// the stored scale exactly, so scale-preserving equality is the property the
// transport actually delivers.
//
// WHERE THE WORK HAPPENS. Per-row and per-batch hashing runs SERVER-SIDE, in a
// single sequential scan per table. Node receives one summary row per batch and
// never a row frame, which makes bounded memory structural rather than careful.

import { createHash } from 'node:crypto'

/** Bumped only when the framing or the fold changes. Part of every digest. */
export const PGCOPY_PROTOCOL = 'pgcopy1'

/** Rows per batch. 10_000 keeps a 165k-row table at 17 summaries. */
export const DEFAULT_BATCH_ROWS = 10_000

/** The only namespace a built-in type or helper may come from. */
export const CATALOG_SCHEMA = 'pg_catalog'

/** A refusal: the input is not something this contract is willing to hash. */
export class CanonicalRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalRefused'
  }
}

/**
 * One live column, as the CATALOGUE resolved it - not as a name suggests.
 *
 * `typnamespace` and `sendNamespace` are what make the type identity real:
 * anyone can create a type called `text` or a function called `textsend`, and
 * a name-only check would accept either.
 */
export interface ColumnSpec {
  readonly name: string
  readonly formatType: string
  readonly typname: string
  /** pg_namespace.nspname of the TYPE. */
  readonly typnamespace: string
  /** pg_type.typtype: b base, c composite, d domain, e enum, r/m range. */
  readonly typtype: string
  /** pg_type.typcategory: 'A' array, 'N' numeric, ... */
  readonly typcategory: string
  /** pg_attribute.atttypmod, raw. For `vector` this carries the dimension. */
  readonly typmod: number
  /** pg_proc.proname of pg_type.typsend. */
  readonly sendName: string
  /** pg_namespace.nspname of pg_type.typsend. */
  readonly sendNamespace: string
  /** pg_extension.extname owning the TYPE, or null for a built-in. */
  readonly typeExtension: string | null
  /** pg_extension.extversion of that extension, or null. */
  readonly typeExtensionVersion: string | null
  /** pg_extension.extname owning the SEND FUNCTION, or null for a built-in. */
  readonly sendExtension: string | null
}

/**
 * The reviewed BUILT-IN types and the exact `pg_catalog` send function each is
 * hashed through. Adding a row here is a contract change, not a convenience.
 */
export const BUILTIN_SEND_FUNCTIONS: Readonly<Record<string, string>> = Object.freeze({
  text: 'textsend',
  // NO trim_scale. Scale is part of the value.
  numeric: 'numeric_send',
  int4: 'int4send',
  int8: 'int8send',
  bool: 'boolsend',
  // date_send / timestamptz_send carry the ±infinity sentinels natively.
  date: 'date_send',
  timestamptz: 'timestamptz_send',
  // jsonb is already normalised in storage; jsonb_send emits a version byte
  // plus that stored form.
  jsonb: 'jsonb_send',
  uuid: 'uuid_send',
})

/** The one extension type in scope, and everything that must be true of it. */
export interface VectorContract {
  /** The extension's own name, as `pg_extension.extname` reports it. */
  readonly extension: string
  /** The exact installed version the caller reviewed. */
  readonly version: string
  /** The only dimension this contract accepts. */
  readonly dimension: number
  /** The send function's expected name. */
  readonly sendName: string
}

/** The reviewed vector contract for the 21-table copy. */
export const VECTOR_384: VectorContract = Object.freeze({
  extension: 'vector',
  version: '',            // caller must supply; '' means "unreviewed", refused
  dimension: 384,
  sendName: 'vector_send',
})

/** Everything a caller must state before a column can be accepted. */
export interface TypeContract {
  /** Supplied explicitly by the caller's reviewed contract; never inferred. */
  readonly vector: VectorContract | null
}

/**
 * Types refused with a reason of their own, because a bare "unsupported type"
 * for `float8` would read like an oversight rather than a decision.
 */
const REFUSED_WITH_REASON: Readonly<Record<string, string>> = Object.freeze({
  float4:
    'float4 and float8 are refused: -0.0 = 0.0 and NaN <> NaN under SQL comparison, ' +
    'so a bit-exact digest and a row-level comparison would disagree about equality.',
  float8:
    'float4 and float8 are refused: -0.0 = 0.0 and NaN <> NaN under SQL comparison, ' +
    'so a bit-exact digest and a row-level comparison would disagree about equality.',
  bytea:
    'bytea is an unreviewed type outside the current 21-table contract. It is refused ' +
    'until a slice that needs it reviews its canonicalisation.',
})

const CATEGORY_REFUSALS: ReadonlyArray<readonly [(c: ColumnSpec) => boolean, string]> = [
  [c => c.typcategory === 'A', 'array types are refused pending review'],
  [c => c.typtype === 'c', 'composite types are refused pending review'],
  [c => c.typtype === 'd', 'domain types are refused pending review'],
  [c => c.typtype === 'e', 'enum types are refused pending review'],
  [c => c.typtype === 'r' || c.typtype === 'm', 'range types are refused pending review'],
]

/**
 * pgvector stores the DIMENSION DIRECTLY in `atttypmod`.
 *
 * The first version of this check subtracted VARHDRSZ, on the reasonable-looking
 * assumption that a variable-length type encodes its typmod the way `varchar`
 * does. It does not, and a live cluster said so immediately: `vector(384)`
 * reports `atttypmod = 384`, and the check refused its own fixture at 380. The
 * assumption is recorded here because the arithmetic is invisible otherwise.
 */

/**
 * FAIL CLOSED, AND BEFORE ANY DATA IS READ.
 *
 * The caller must run this on the catalogue description and let it throw before
 * it builds - let alone issues - a statement that touches a row. Category
 * checks run first so a domain over an allowed base type is refused AS a
 * domain; namespace checks run before name checks so a `public.text` cannot
 * pass on the strength of the word "text".
 */
export function assertSupportedColumns(
  columns: readonly ColumnSpec[],
  contract: TypeContract,
): void {
  // A MISSING CONTRACT IS A REFUSAL, NOT A TypeError. The caller states which
  // extension types it reviewed; omitting that is exactly the case this
  // function exists to reject, and it must say so rather than crash on a
  // property read.
  if (contract === null || typeof contract !== 'object') {
    throw new CanonicalRefused(
      'no type contract was supplied. The caller must state which extension types it ' +
      'reviewed; there is no default.',
    )
  }
  if (columns.length === 0) {
    throw new CanonicalRefused('the table has no live columns; there is nothing to hash.')
  }
  for (const c of columns) {
    const where = `column "${c.name}" (${c.formatType})`
    for (const [matches, reason] of CATEGORY_REFUSALS) {
      if (matches(c)) throw new CanonicalRefused(`${where}: ${reason}.`)
    }

    if (c.typnamespace === CATALOG_SCHEMA) {
      const explicit = REFUSED_WITH_REASON[c.typname]
      if (explicit) throw new CanonicalRefused(`${where}: ${explicit}`)
      const expected = BUILTIN_SEND_FUNCTIONS[c.typname]
      if (!expected) {
        throw new CanonicalRefused(
          `${where} is not in the reviewed built-in set ` +
          `(${Object.keys(BUILTIN_SEND_FUNCTIONS).sort().join(', ')}). ` +
          'Adding a type is a contract change.',
        )
      }
      if (c.sendNamespace !== CATALOG_SCHEMA || c.sendName !== expected) {
        throw new CanonicalRefused(
          `${where} resolves its send function to ${c.sendNamespace}.${c.sendName}, not ` +
          `${CATALOG_SCHEMA}.${expected}. A shadowed send function would let the SOURCE ` +
          'choose how its own values are hashed.',
        )
      }
      if (c.typeExtension !== null) {
        throw new CanonicalRefused(
          `${where} claims namespace ${CATALOG_SCHEMA} but belongs to extension ` +
          `"${c.typeExtension}". A built-in is not owned by an extension.`,
        )
      }
      continue
    }

    // Everything outside pg_catalog must be the one reviewed extension type.
    const v = contract.vector
    if (!v) {
      throw new CanonicalRefused(
        `${where} lives in namespace "${c.typnamespace}", and the caller supplied no ` +
        'extension type contract. Extension types are refused unless explicitly reviewed.',
      )
    }
    if (c.typname !== 'vector') {
      throw new CanonicalRefused(
        `${where} is a non-catalogue type "${c.typnamespace}.${c.typname}"; the only ` +
        'reviewed extension type is vector.',
      )
    }
    if (c.typeExtension !== v.extension) {
      throw new CanonicalRefused(
        `${where} is not a member of extension "${v.extension}" ` +
        `(pg_depend says ${c.typeExtension === null ? 'no extension' : `"${c.typeExtension}"`}).`,
      )
    }
    if (c.sendExtension !== v.extension) {
      throw new CanonicalRefused(
        `${where}: its send function is not a member of extension "${v.extension}" ` +
        `(pg_depend says ${c.sendExtension === null ? 'no extension' : `"${c.sendExtension}"`}).`,
      )
    }
    if (c.sendName !== v.sendName) {
      throw new CanonicalRefused(
        `${where} resolves its send function to "${c.sendName}", not "${v.sendName}".`,
      )
    }
    if (c.sendNamespace !== c.typnamespace) {
      throw new CanonicalRefused(
        `${where}: the type is in "${c.typnamespace}" but its send function is in ` +
        `"${c.sendNamespace}". Both must come from the same installed extension.`,
      )
    }
    if (!v.version) {
      throw new CanonicalRefused(
        `${where}: the caller's contract states no "${v.extension}" version. The version ` +
        'must be supplied and reviewed, because a wire-format change between versions is ' +
        'invisible to format_type.',
      )
    }
    if (c.typeExtensionVersion !== v.version) {
      throw new CanonicalRefused(
        `${where}: extension "${v.extension}" is installed at version ` +
        `"${c.typeExtensionVersion ?? 'unknown'}", not the reviewed "${v.version}".`,
      )
    }
    if (c.typmod !== v.dimension) {
      throw new CanonicalRefused(
        `${where} has dimension ${c.typmod}, not the reviewed ${v.dimension}.`,
      )
    }
  }
}

/** The fully-qualified send call for one column, schema-qualified always. */
function sendCall(c: ColumnSpec): string {
  return `${quoteIdent(c.sendNamespace)}.${quoteIdent(c.sendName)}`
}

// ---------------------------------------------------------------------------
// HEADER SAFETY
// ---------------------------------------------------------------------------
//
// Hashed headers join components with `|`. Rather than escape, every component
// is constrained so it cannot contain the separator - and the constraints are
// tighter than that, because "no pipe" still admits a name with a newline in
// it. Identifiers must match the reviewed lowercase grammar; digests must be
// exactly 64 lowercase hex; counts must be non-negative safe integers.

const IDENT_GRAMMAR = /^[a-z_][a-z0-9_]*$/
const HEX64 = /^[0-9a-f]{64}$/
const MAX_IDENT = 63

function assertIdentifier(kind: string, name: string): void {
  if (!IDENT_GRAMMAR.test(name) || name.length > MAX_IDENT) {
    throw new CanonicalRefused(
      `${kind} ${JSON.stringify(name)} is outside the reviewed identifier grammar ` +
      `(/^[a-z_][a-z0-9_]*$/, at most ${MAX_IDENT} characters). It is refused rather than ` +
      'escaped, so a name can never impersonate the header framing.',
    )
  }
}

function assertHexDigest(kind: string, value: string): void {
  if (!HEX64.test(value)) {
    throw new CanonicalRefused(
      `${kind} ${JSON.stringify(value)} is not exactly 64 lowercase hexadecimal characters.`,
    )
  }
}

function assertCount(kind: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new CanonicalRefused(`${kind} ${String(n)} is not a non-negative safe integer.`)
  }
}

/** Double-quote an identifier for SQL. Refuses anything with an embedded quote. */
function quoteIdent(name: string): string {
  if (name.includes('"')) {
    throw new CanonicalRefused(`identifier ${JSON.stringify(name)} contains a double quote.`)
  }
  return `"${name}"`
}

/** Single-quote a literal for SQL. Doubles embedded quotes. */
function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * The row frame, as one `bytea` expression.
 *
 *   int4send(<live column count>)
 *   then, per column, in live-column order:
 *     int4send(<1-based ordinal>)
 *     NULL     -> '\x00'
 *     non-NULL -> '\x01' || int4send(octet_length(send(v))) || send(v)
 *
 * EVERY function here is schema-qualified. `int4send`, `octet_length` and the
 * `bytea` cast all resolve through `search_path` otherwise, and a source that
 * can set its own `search_path` could then choose how its values are framed.
 */
export function rowFrameSql(columns: readonly ColumnSpec[], contract: TypeContract): string {
  assertSupportedColumns(columns, contract)
  const parts = [`${CATALOG_SCHEMA}.int4send(${columns.length})`]
  columns.forEach((c, i) => {
    const send = sendCall(c)
    const col = quoteIdent(c.name)
    parts.push(`${CATALOG_SCHEMA}.int4send(${i + 1})`)
    parts.push(
      `CASE WHEN ${col} IS NULL THEN '\\x00'::${CATALOG_SCHEMA}.bytea ` +
      `ELSE '\\x01'::${CATALOG_SCHEMA}.bytea ` +
      `|| ${CATALOG_SCHEMA}.int4send(${CATALOG_SCHEMA}.octet_length(${send}(${col}))) ` +
      `|| ${send}(${col}) END`,
    )
  })
  return parts.join(' || ')
}

export interface BatchSqlInput {
  readonly schema: string
  readonly table: string
  /** Primary-key columns in CONSTRAINT order, not alphabetical. */
  readonly pkColumns: readonly string[]
  readonly columns: readonly ColumnSpec[]
  /** The schema-contract digest this content is being hashed against. */
  readonly schemaDigest: string
  readonly contract: TypeContract
  readonly batchRows?: number
}

/** `schema.table`, unquoted, as it appears inside every hashed header. */
export function qualifiedName(schema: string, table: string): string {
  assertIdentifier('schema name', schema)
  assertIdentifier('table name', table)
  return `${schema}.${table}`
}

/**
 * The batch query: one sequential scan, one summary row per batch.
 *
 * NO OFFSET. Batch membership comes from a window function in the same pass, so
 * the table is read once, in PK order, and the Nth batch costs the same as the
 * first. The SELECT list is four scalars; row frames never leave the server.
 */
export function batchDigestSql(input: BatchSqlInput): string {
  const batchRows = input.batchRows ?? DEFAULT_BATCH_ROWS
  if (!Number.isSafeInteger(batchRows) || batchRows < 1) {
    throw new CanonicalRefused(`batchRows must be a positive safe integer, got ${String(batchRows)}.`)
  }
  if (input.pkColumns.length === 0) {
    throw new CanonicalRefused('a deterministic digest needs a primary key to order by.')
  }
  for (const p of input.pkColumns) assertIdentifier('primary-key column', p)
  assertHexDigest('schema digest', input.schemaDigest)
  const frame = rowFrameSql(input.columns, input.contract)
  const qname = qualifiedName(input.schema, input.table)
  const order = input.pkColumns.map(quoteIdent).join(', ')
  const rel = `${quoteIdent(input.schema)}.${quoteIdent(input.table)}`
  const C = CATALOG_SCHEMA
  const header = `${PGCOPY_PROTOCOL}|batch|${qname}|${input.schemaDigest}|b=`
  return [
    'WITH numbered AS (',
    `  SELECT ((${C}.row_number() OVER w - 1) / ${batchRows})::${C}.int4 AS b,`,
    `         ${C}.row_number() OVER w AS rn,`,
    `         ${frame} AS f`,
    `  FROM ${rel}`,
    `  WINDOW w AS (ORDER BY ${order})`,
    ')',
    'SELECT b AS batch,',
    `       ${C}.count(*)::${C}.int8 AS rows,`,
    `       ${C}.sum(${C}.octet_length(f))::${C}.int8 AS bytes,`,
    `       ${C}.encode(${C}.sha256(${C}.convert_to(`,
    `         ${quoteLiteral(header)} || b::${C}.text`,
    `         || '|rows=' || ${C}.count(*)::${C}.text`,
    `         || '|bytes=' || ${C}.sum(${C}.octet_length(f))::${C}.text`,
    `         || '|' || ${C}.string_agg(${C}.encode(${C}.sha256(f), 'hex'), '' ORDER BY rn),`,
    `         'UTF8')), 'hex') AS digest`,
    'FROM numbered',
    'GROUP BY b',
    'ORDER BY b',
  ].join('\n')
}

/** One batch summary, exactly as the server reported it. */
export interface BatchSummary {
  readonly batch: number
  readonly rows: number
  readonly bytes: number
  readonly digest: string
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

export interface TableDigestInput {
  readonly schema: string
  readonly table: string
  readonly schemaDigest: string
  readonly batches: readonly BatchSummary[]
}

/**
 * The table digest: the ordered batch records plus the totals.
 *
 * ORDINALS MUST BE 0..n-1 WITH NO GAP AND NO REPEAT, and this refuses rather
 * than sorting or de-duplicating. A caller holding a discontinuous set has lost
 * a batch; repairing it silently would hide exactly the defect the ordered fold
 * exists to catch.
 *
 * A ZERO-ROW TABLE IS A DEFINED VALUE: `nb=0`, `rows=0`, `bytes=0`, empty list.
 * It says the table is empty, and nothing about how it came to be empty.
 */
export function tableDigest(input: TableDigestInput): string {
  assertHexDigest('schema digest', input.schemaDigest)
  const qname = qualifiedName(input.schema, input.table)
  input.batches.forEach((b, i) => {
    assertCount(`batch ordinal at position ${i}`, b.batch)
    assertCount(`batch ${b.batch} row count`, b.rows)
    assertCount(`batch ${b.batch} byte count`, b.bytes)
    assertHexDigest(`batch ${b.batch} digest`, b.digest)
    if (b.batch !== i) {
      throw new CanonicalRefused(
        `batch summaries are not a contiguous 0-based sequence: position ${i} carries ` +
        `batch ${b.batch}. A gap means a lost batch and a repeat means a duplicated one.`,
      )
    }
  })
  const rows = input.batches.reduce((n, b) => n + b.rows, 0)
  const bytes = input.batches.reduce((n, b) => n + b.bytes, 0)
  const body = input.batches.map(b => `${b.batch}:${b.rows}:${b.bytes}:${b.digest}`).join('|')
  return sha256Hex(
    `${PGCOPY_PROTOCOL}|table|${qname}|${input.schemaDigest}` +
    `|nb=${input.batches.length}|rows=${rows}|bytes=${bytes}|${body}`,
  )
}

export interface TableDigestRecord {
  readonly schema: string
  readonly table: string
  readonly digest: string
}

/**
 * The root digest: the explicit ordered table list and its count.
 *
 * A REPEATED TABLE IS REFUSED. Two entries for one table would make the root a
 * statement about a multiset, and the copy has exactly one digest per table.
 */
export function rootDigest(tables: readonly TableDigestRecord[]): string {
  const seen = new Set<string>()
  const body = tables.map(t => {
    assertHexDigest(`table digest for ${t.schema}.${t.table}`, t.digest)
    const q = qualifiedName(t.schema, t.table)
    if (seen.has(q)) throw new CanonicalRefused(`table ${q} appears more than once in the root set.`)
    seen.add(q)
    return `${q}=${t.digest}`
  }).join('|')
  return sha256Hex(`${PGCOPY_PROTOCOL}|root|n=${tables.length}|${body}`)
}

/**
 * The live columns of one table, with every identity RESOLVED through the
 * catalogue: the type's namespace, the send function's name and namespace, and
 * the extension each belongs to.
 *
 * WHY THE JOINS. `typname = 'text'` is a name, not an identity; `pg_type` may
 * hold a `public.text` as easily as `pg_catalog.text`. `typsend` is the only
 * authority on which function PostgreSQL will actually call, and resolving it
 * here means the generated SQL can name that function explicitly instead of
 * letting `search_path` decide.
 *
 * WHY DROPPED COLUMNS DO NOT BREAK ANYTHING. A dropped column leaves an
 * `attisdropped` row occupying an attnum with no name and no usable type. The
 * frame is built over LIVE columns by their position in this list, and the copy
 * transports an explicit live-column list, so the physical attnum gap is
 * invisible to both.
 */
export const LIVE_COLUMNS_SQL = `
SELECT a.attname                                       AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type,
       t.typname                                       AS typname,
       tn.nspname                                      AS typnamespace,
       t.typtype::pg_catalog.text                      AS typtype,
       t.typcategory::pg_catalog.text                  AS typcategory,
       a.atttypmod                                     AS typmod,
       p.proname                                       AS send_name,
       pn.nspname                                      AS send_namespace,
       te.extname                                      AS type_extension,
       te.extversion                                   AS type_extension_version,
       se.extname                                      AS send_extension
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class     c  ON c.oid  = a.attrelid
  JOIN pg_catalog.pg_namespace n  ON n.oid  = c.relnamespace
  JOIN pg_catalog.pg_type      t  ON t.oid  = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_proc      p  ON p.oid  = t.typsend
  LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  LEFT JOIN pg_catalog.pg_depend    dt ON dt.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
                                      AND dt.objid = t.oid AND dt.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension te ON te.oid = dt.refobjid
  LEFT JOIN pg_catalog.pg_depend    ds ON ds.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                                      AND ds.objid = p.oid AND ds.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension se ON se.oid = ds.refobjid
 WHERE n.nspname = $1 AND c.relname = $2
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum`

/** The primary-key columns, in CONSTRAINT order. Alphabetical would be wrong. */
export const PK_COLUMNS_SQL = `
SELECT a.attname AS name
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class     c ON c.oid = k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL pg_catalog.unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum
 WHERE n.nspname = $1 AND c.relname = $2 AND k.contype = 'p'
 ORDER BY u.ord`
