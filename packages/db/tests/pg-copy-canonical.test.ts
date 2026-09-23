// The canonical digest, proved OFFLINE: shape, refusals and the pure folds.
//
// What this file cannot prove is what PostgreSQL actually does with the SQL it
// builds - whether `typsend` really names the function it claims, whether
// `numeric_send` preserves scale. Those are live properties and live in
// tests/pgcopy/canonical.int.test.ts. Splitting them is deliberate: an offline
// assertion about a string is worth having, and worth not mistaking for proof.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  BUILTIN_SEND_FUNCTIONS,
  CATALOG_SCHEMA,
  CanonicalRefused,
  DEFAULT_BATCH_ROWS,
  PGCOPY_PROTOCOL,
  assertSupportedColumns,
  batchDigestSql,
  qualifiedName,
  rootDigest,
  rowFrameSql,
  tableDigest,
  type BatchSummary,
  type ColumnSpec,
  type TypeContract,
} from '../src/pg-copy/canonical.js'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/canonical.ts', import.meta.url)), 'utf-8')

const VECTOR_SCHEMA = 'public'
const CONTRACT: TypeContract = {
  vector: { extension: 'vector', version: '0.8.1', dimension: 384, sendName: 'vector_send' },
}

/** A built-in column, resolved the way the catalogue would resolve it. */
const builtin = (name: string, typname: string, formatType = typname,
                 typcategory = 'S'): ColumnSpec => ({
  name, typname, formatType, typnamespace: CATALOG_SCHEMA, typtype: 'b', typcategory,
  typmod: -1, sendName: BUILTIN_SEND_FUNCTIONS[typname] ?? `${typname}send`,
  sendNamespace: CATALOG_SCHEMA, typeExtension: null, typeExtensionVersion: null,
  sendExtension: null,
})

const vectorCol = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name: 'v', typname: 'vector', formatType: 'vector(384)', typnamespace: VECTOR_SCHEMA,
  typtype: 'b', typcategory: 'U', typmod: 384, sendName: 'vector_send',
  sendNamespace: VECTOR_SCHEMA, typeExtension: 'vector', typeExtensionVersion: '0.8.1',
  sendExtension: 'vector', ...over,
})

const COLS: ColumnSpec[] = [
  builtin('id', 'text'),
  builtin('amount', 'numeric', 'numeric', 'N'),
  builtin('n', 'int4', 'integer', 'N'),
  builtin('big', 'int8', 'bigint', 'N'),
  builtin('flag', 'bool', 'boolean', 'B'),
  builtin('d', 'date', 'date', 'D'),
  builtin('ts', 'timestamptz', 'timestamp with time zone', 'D'),
  builtin('doc', 'jsonb', 'jsonb', 'U'),
  builtin('u', 'uuid', 'uuid', 'U'),
  vectorCol(),
]

const batches = (...specs: [number, number, number, string][]): BatchSummary[] =>
  specs.map(([batch, rows, bytes, digest]) => ({ batch, rows, bytes, digest }))

const SCHEMA_DIGEST = 'a'.repeat(64)
const base = { schema: 'fx', table: 'adversarial', pkColumns: ['id'], columns: COLS,
               schemaDigest: SCHEMA_DIGEST, contract: CONTRACT }

describe('type identity is resolved, not named', () => {
  it('sends every supported built-in through its own pg_catalog send function', () => {
    expect(Object.keys(BUILTIN_SEND_FUNCTIONS).sort()).toEqual([
      'bool', 'date', 'int4', 'int8', 'jsonb', 'numeric', 'text', 'timestamptz', 'uuid',
    ])
    expect(BUILTIN_SEND_FUNCTIONS.numeric).toBe('numeric_send')
  })

  it('refuses a built-in NAME that lives in another namespace', () => {
    expect(() => assertSupportedColumns(
      [builtin('id', 'text')].map(c => ({ ...c, typnamespace: 'public' })), CONTRACT))
      .toThrow(/namespace "public".*no extension type contract|non-catalogue type/)
  })

  it('refuses a pg_catalog type whose send function is shadowed elsewhere', () => {
    expect(() => assertSupportedColumns(
      [{ ...builtin('id', 'text'), sendNamespace: 'evil' }], CONTRACT))
      .toThrow(/resolves its send function to evil\.textsend/)
  })

  it('refuses a pg_catalog type whose send function has the wrong name', () => {
    expect(() => assertSupportedColumns(
      [{ ...builtin('id', 'text'), sendName: 'textout' }], CONTRACT))
      .toThrow(/not pg_catalog\.textsend/)
  })

  it('refuses a "pg_catalog" type that claims extension membership', () => {
    expect(() => assertSupportedColumns(
      [{ ...builtin('id', 'text'), typeExtension: 'evil' }], CONTRACT))
      .toThrow(/A built-in is not owned by an extension/)
  })

  it('refuses float4 and float8 by name, with the reason', () => {
    for (const t of ['float4', 'float8']) {
      expect(() => assertSupportedColumns([builtin('x', t)], CONTRACT))
        .toThrow(/-0\.0 = 0\.0 and NaN <> NaN/)
    }
  })

  it('refuses bytea as an unreviewed type, not as a framing hazard', () => {
    expect(() => assertSupportedColumns([builtin('x', 'bytea')], CONTRACT))
      .toThrow(/unreviewed type outside the current 21-table contract/)
  })

  it('refuses arrays, enum, domain, range and composite', () => {
    const c = builtin('x', 'text')
    const cases: [string, ColumnSpec][] = [
      ['array',      { ...c, typname: '_text', formatType: 'text[]', typcategory: 'A' }],
      ['enum',       { ...c, typname: 'mood', typtype: 'e', typcategory: 'E' }],
      ['domain',     { ...c, typname: 'pos', typtype: 'd', typcategory: 'N' }],
      ['range',      { ...c, typname: 'int4range', typtype: 'r', typcategory: 'R' }],
      ['multirange', { ...c, typname: 'int4multirange', typtype: 'm', typcategory: 'R' }],
      ['composite',  { ...c, typname: 'addr', typtype: 'c', typcategory: 'C' }],
    ]
    for (const [label, spec] of cases) {
      expect(() => assertSupportedColumns([spec], CONTRACT), label).toThrow(CanonicalRefused)
    }
  })

  it('refuses a domain over a supported base type AS A DOMAIN', () => {
    expect(() => assertSupportedColumns([{ ...builtin('x', 'text'), typtype: 'd' }], CONTRACT))
      .toThrow(/domain types are refused/)
  })

  it('refuses a table with no live columns', () => {
    expect(() => assertSupportedColumns([], CONTRACT)).toThrow(/no live columns/)
  })

  it('refuses a MISSING contract as a refusal, not a crash', () => {
    expect(() => assertSupportedColumns(COLS, undefined as unknown as TypeContract))
      .toThrow(/no type contract was supplied/)
    expect(() => assertSupportedColumns(COLS, null as unknown as TypeContract))
      .toThrow(/no type contract was supplied/)
  })

  it('refuses BEFORE any data SQL is produced', () => {
    const bad = [...COLS, builtin('f', 'float8')]
    expect(() => rowFrameSql(bad, CONTRACT)).toThrow(CanonicalRefused)
    expect(() => batchDigestSql({ ...base, columns: bad })).toThrow(CanonicalRefused)
  })
})

describe('the vector contract is supplied, never inferred', () => {
  it('accepts vector(384) from the reviewed extension at the reviewed version', () => {
    expect(() => assertSupportedColumns([vectorCol()], CONTRACT)).not.toThrow()
  })

  it('refuses an extension type when the caller supplied no contract', () => {
    expect(() => assertSupportedColumns([vectorCol()], { vector: null }))
      .toThrow(/supplied no extension type contract/)
  })

  it('refuses a contract that states no version', () => {
    expect(() => assertSupportedColumns([vectorCol()],
      { vector: { ...CONTRACT.vector!, version: '' } }))
      .toThrow(/states no "vector" version/)
  })

  it('refuses an installed version other than the reviewed one', () => {
    expect(() => assertSupportedColumns([vectorCol({ typeExtensionVersion: '0.7.0' })], CONTRACT))
      .toThrow(/installed at version "0\.7\.0", not the reviewed "0\.8\.1"/)
  })

  it('refuses a dimension other than the reviewed one', () => {
    expect(() => assertSupportedColumns(
      [vectorCol({ typmod: 1536, formatType: 'vector(1536)' })], CONTRACT))
      .toThrow(/dimension 1536, not the reviewed 384/)
  })

  it('refuses a type that is not a member of the extension', () => {
    expect(() => assertSupportedColumns([vectorCol({ typeExtension: null })], CONTRACT))
      .toThrow(/not a member of extension "vector"/)
  })

  it('refuses a send function that is not a member of the extension', () => {
    expect(() => assertSupportedColumns([vectorCol({ sendExtension: null })], CONTRACT))
      .toThrow(/send function is not a member of extension "vector"/)
  })

  it('refuses a send function in a different namespace from the type', () => {
    expect(() => assertSupportedColumns([vectorCol({ sendNamespace: 'evil' })], CONTRACT))
      .toThrow(/the type is in "public" but its send function is in "evil"/)
  })

  it('refuses a non-vector extension type outright', () => {
    expect(() => assertSupportedColumns(
      [vectorCol({ typname: 'hstore', formatType: 'hstore' })], CONTRACT))
      .toThrow(/the only reviewed extension type is vector/)
  })
})

describe('row framing', () => {
  const frame = rowFrameSql(COLS, CONTRACT)

  it('binds the live-column count and every ordinal', () => {
    expect(frame.startsWith(`${CATALOG_SCHEMA}.int4send(${COLS.length})`)).toBe(true)
    for (let i = 1; i <= COLS.length; i += 1) {
      expect(frame).toContain(`${CATALOG_SCHEMA}.int4send(${i})`)
    }
  })

  it('tags NULL separately from the length, so NULL and empty cannot collide', () => {
    expect(frame).toContain(`'\\x00'::${CATALOG_SCHEMA}.bytea`)
    expect(frame).toContain(`'\\x01'::${CATALOG_SCHEMA}.bytea`)
  })

  it('SCHEMA-QUALIFIES every send call and every catalog helper', () => {
    for (const c of COLS) {
      expect(frame).toContain(`"${c.sendNamespace}"."${c.sendName}"("${c.name}")`)
    }
    expect(frame).toContain(`${CATALOG_SCHEMA}.octet_length(`)
    // No bare call of any helper the search_path could redirect.
    expect(frame).not.toMatch(/(^|[^.\w"])int4send\s*\(/)
    expect(frame).not.toMatch(/(^|[^.\w"])octet_length\s*\(/)
    expect(frame).not.toMatch(/::bytea\b/)
  })

  it('renders no value as text and uses no delimiter framing', () => {
    expect(frame).not.toMatch(/concat_ws|concat\s*\(/)
    expect(frame).not.toMatch(/::pg_catalog\.text\b/)
    expect(frame).not.toMatch(/to_char|trim_scale/)
  })
})

describe('the batch query', () => {
  const sql = batchDigestSql({ ...base, batchRows: 4 })

  it('batches with a window function and never with OFFSET', () => {
    expect(sql).toContain(`${CATALOG_SCHEMA}.row_number() OVER w`)
    expect(sql).toContain('WINDOW w AS (ORDER BY "id")')
    expect(sql).not.toMatch(/\bOFFSET\b/i)
  })

  it('binds protocol, qualified name, schema digest, ordinal and both counts', () => {
    expect(sql).toContain(`${PGCOPY_PROTOCOL}|batch|fx.adversarial|${SCHEMA_DIGEST}|b=`)
    expect(sql).toContain(`|| b::${CATALOG_SCHEMA}.text`)
    expect(sql).toContain(`'|rows=' || ${CATALOG_SCHEMA}.count(*)`)
    expect(sql).toContain(`'|bytes=' || ${CATALOG_SCHEMA}.sum(`)
  })

  it('schema-qualifies sha256, encode, convert_to, string_agg and the casts', () => {
    for (const fn of ['sha256(', 'encode(', 'convert_to(', 'string_agg(', 'count(', 'sum(']) {
      expect(sql).toContain(`${CATALOG_SCHEMA}.${fn}`)
      expect(sql, `bare ${fn}`).not.toMatch(new RegExp(`(^|[^.\\w"])${fn.replace('(', '\\s*\\(')}`, 'm'))
    }
    expect(sql).toContain(`::${CATALOG_SCHEMA}.int4`)
    expect(sql).toContain(`::${CATALOG_SCHEMA}.int8`)
    expect(sql).not.toMatch(/::int\b|::bigint\b|::text\b/)
  })

  it('folds rows in an explicit order', () => {
    expect(sql).toContain(`'hex'), '' ORDER BY rn)`)
  })

  it('returns batch summaries only — no row frame reaches the client', () => {
    const select = sql.slice(sql.indexOf('SELECT b AS batch'), sql.indexOf('FROM numbered'))
    for (const alias of ['AS batch', 'AS rows', 'AS bytes', 'AS digest']) {
      expect(select).toContain(alias)
    }
    expect(select).not.toMatch(/(^|[^a-z_])f\s*(,|$)/m)
  })

  it('orders by the primary key in constraint order, not alphabetically', () => {
    expect(batchDigestSql({ ...base, pkColumns: ['zeta', 'alpha'] }))
      .toContain('WINDOW w AS (ORDER BY "zeta", "alpha")')
  })

  it('refuses a missing primary key, a bad batch size and a bad schema digest', () => {
    expect(() => batchDigestSql({ ...base, pkColumns: [] })).toThrow(/primary key/)
    for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => batchDigestSql({ ...base, batchRows: n })).toThrow(/positive safe integer/)
    }
    expect(() => batchDigestSql({ ...base, schemaDigest: 'A'.repeat(64) }))
      .toThrow(/64 lowercase hexadecimal/)
    expect(() => batchDigestSql({ ...base, schemaDigest: 'a'.repeat(63) }))
      .toThrow(/64 lowercase hexadecimal/)
  })

  it('defaults to the reviewed batch size', () => {
    expect(DEFAULT_BATCH_ROWS).toBe(10_000)
    expect(batchDigestSql(base)).toContain(`/ ${DEFAULT_BATCH_ROWS})::${CATALOG_SCHEMA}.int4 AS b`)
  })
})

describe('hashed header components are unambiguous', () => {
  it('refuses any identifier outside the reviewed lowercase grammar', () => {
    for (const bad of ['a|b', 'A', 'a b', 'a\nb', '1a', 'a-b', 'a'.repeat(64), '']) {
      expect(() => qualifiedName(bad, 't'), JSON.stringify(bad)).toThrow(/identifier grammar/)
      expect(() => qualifiedName('s', bad), JSON.stringify(bad)).toThrow(/identifier grammar/)
    }
    expect(qualifiedName('fx', 'adversarial')).toBe('fx.adversarial')
    expect(qualifiedName('_x9', 'a_b_9')).toBe('_x9.a_b_9')
  })

  it('refuses a digest that is not exactly 64 lowercase hex characters', () => {
    for (const bad of ['', 'x'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => tableDigest({ schema: 'fx', table: 't', schemaDigest: bad, batches: [] }))
        .toThrow(/64 lowercase hexadecimal/)
      expect(() => rootDigest([{ schema: 'fx', table: 't', digest: bad }]))
        .toThrow(/64 lowercase hexadecimal/)
    }
  })

  it('refuses batch counts that are not non-negative safe integers', () => {
    const d = 'd'.repeat(64)
    const bads: [string, BatchSummary][] = [
      ['negative rows', { batch: 0, rows: -1, bytes: 0, digest: d }],
      ['fractional bytes', { batch: 0, rows: 0, bytes: 1.5, digest: d }],
      ['unsafe rows', { batch: 0, rows: Number.MAX_SAFE_INTEGER + 2, bytes: 0, digest: d }],
      ['negative ordinal', { batch: -1, rows: 0, bytes: 0, digest: d }],
    ]
    for (const [label, b] of bads) {
      expect(() => tableDigest({ schema: 'fx', table: 't', schemaDigest: SCHEMA_DIGEST, batches: [b] }),
        label).toThrow(/non-negative safe integer|contiguous 0-based/)
    }
  })
})

describe('the table digest', () => {
  const tbase = { schema: 'fx', table: 'adversarial', schemaDigest: SCHEMA_DIGEST }
  const B = batches([0, 4, 100, 'd0'.repeat(32)], [1, 2, 50, 'd1'.repeat(32)])

  it('is deterministic', () => {
    expect(tableDigest({ ...tbase, batches: B })).toBe(tableDigest({ ...tbase, batches: B }))
  })

  it('changes when a batch digest, name, schema or schema digest changes', () => {
    const d0 = tableDigest({ ...tbase, batches: B })
    expect(tableDigest({ ...tbase,
      batches: batches([0, 4, 100, 'd0'.repeat(32)], [1, 2, 50, 'd2'.repeat(32)]) })).not.toBe(d0)
    expect(tableDigest({ ...tbase, table: 'other', batches: B })).not.toBe(d0)
    expect(tableDigest({ ...tbase, schema: 'other', batches: B })).not.toBe(d0)
    expect(tableDigest({ ...tbase, schemaDigest: 'b'.repeat(64), batches: B })).not.toBe(d0)
  })

  it('changes when a row count or byte count changes', () => {
    const d0 = tableDigest({ ...tbase, batches: B })
    expect(tableDigest({ ...tbase,
      batches: batches([0, 5, 100, 'd0'.repeat(32)], [1, 2, 50, 'd1'.repeat(32)]) })).not.toBe(d0)
    expect(tableDigest({ ...tbase,
      batches: batches([0, 4, 101, 'd0'.repeat(32)], [1, 2, 50, 'd1'.repeat(32)]) })).not.toBe(d0)
  })

  it('REFUSES reordered, duplicated or discontinuous ordinals', () => {
    const reordered = batches([1, 2, 50, 'd1'.repeat(32)], [0, 4, 100, 'd0'.repeat(32)])
    const duplicate = batches([0, 4, 100, 'd0'.repeat(32)], [0, 2, 50, 'd1'.repeat(32)])
    const gap = batches([0, 4, 100, 'd0'.repeat(32)], [2, 2, 50, 'd1'.repeat(32)])
    for (const [label, b] of [['reordered', reordered], ['duplicate', duplicate], ['gap', gap]] as const) {
      expect(() => tableDigest({ ...tbase, batches: b }), label).toThrow(/contiguous 0-based/)
    }
  })

  it('gives a zero-row table a defined, deterministic value', () => {
    const empty = tableDigest({ ...tbase, batches: [] })
    expect(empty).toMatch(/^[0-9a-f]{64}$/)
    expect(tableDigest({ ...tbase, batches: [] })).toBe(empty)
    expect(empty).not.toBe(tableDigest({ ...tbase, batches: B }))
    expect(empty).not.toBe(tableDigest({ ...tbase, table: 'other', batches: [] }))
  })

  // The ordinal cannot be shown to matter by data: every row frame contains the
  // primary key, so two batches of one table can never hold identical frame
  // sequences. It is defence in depth, so it is asserted structurally.
  it('the batch ordinal is part of the hashed text, structurally', () => {
    expect(SRC).toContain('${quoteLiteral(header)} || b::${C}.text')
  })
})

describe('the root digest', () => {
  const T = [
    { schema: 'fx', table: 'a', digest: '1'.repeat(64) },
    { schema: 'fx', table: 'b', digest: '2'.repeat(64) },
  ]

  it('is deterministic and order-sensitive', () => {
    expect(rootDigest(T)).toBe(rootDigest(T))
    expect(rootDigest([T[1], T[0]])).not.toBe(rootDigest(T))
  })

  it('binds the table count, so a dropped table cannot go unnoticed', () => {
    expect(rootDigest([T[0]])).not.toBe(rootDigest(T))
    expect(rootDigest([])).toMatch(/^[0-9a-f]{64}$/)
    expect(SRC).toContain('|root|n=${tables.length}|')
  })

  it('binds the qualified name, not the bare table name', () => {
    expect(rootDigest([{ schema: 'other', table: 'a', digest: '1'.repeat(64) }, T[1]]))
      .not.toBe(rootDigest(T))
  })

  it('REFUSES a repeated table identity', () => {
    expect(() => rootDigest([T[0], T[0]])).toThrow(/appears more than once/)
    expect(() => rootDigest([T[0], { ...T[0], digest: '3'.repeat(64) }]))
      .toThrow(/appears more than once/)
  })
})
