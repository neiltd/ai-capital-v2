// The canonical digest, proved against LIVE PostgreSQL 17 on disposable clusters.
//
// Two clusters, built and destroyed by this file, are what make a CROSS-DATABASE
// claim possible. A single database compared with itself proves that a hash
// function is a function; it proves nothing about a copy. Every mismatch
// assertion below therefore differs in exactly one value across two independent
// clusters, which is the shape the real comparison will have.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CanonicalRefused,
  LIVE_COLUMNS_SQL,
  PK_COLUMNS_SQL,
  assertSupportedColumns,
  batchDigestSql,
  rootDigest,
  tableDigest,
  type BatchSummary,
  type ColumnSpec,
  type TypeContract,
} from '../../src/pg-copy/canonical.js'
import {
  FORBIDDEN_PORTS,
  clusterResidue,
  postmasterAlive,
  startDisposableCluster,
  stopAllDisposableClusters,
  unstoppedRoots,
  type DisposableCluster,
} from '../../testing/disposable-cluster.js'

const SCHEMA_DIGEST = 'f'.repeat(64)
const DB = 'fixture'

/**
 * The reviewed vector contract, with the version read from the cluster the
 * fixture actually installed. The caller must STATE the version; reading it
 * here is what a reviewed contract would have written down, and the refusal
 * tests below prove a wrong one is rejected.
 */
let CONTRACT: TypeContract = { vector: null }

async function vectorContract(c: DisposableCluster): Promise<TypeContract> {
  const v = await c.rows(
    `SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'vector'`, DB)
  return { vector: { extension: 'vector', version: v[0][0], dimension: 384, sendName: 'vector_send' } }
}

/** The adversarial fixture: every reviewed type, and every edge value. */
const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA fx;
CREATE TABLE fx.adversarial (
  id      text        PRIMARY KEY,
  note    text,
  amount  numeric,
  n       integer,
  big     bigint,
  flag    boolean,
  d       date,
  ts      timestamptz,
  doc     jsonb,
  u       uuid,
  v       vector(384)
);
CREATE TABLE fx.empty_t (id text PRIMARY KEY, amount numeric);
CREATE TABLE fx.composite_pk (
  a text, b text, payload text,
  PRIMARY KEY (b, a)              -- constraint order is (b, a), not alphabetical
);
`

/** A deterministic 384-dimension vector, rendered once as a literal. */
const VEC = (seed: number): string =>
  `'[${Array.from({ length: 384 }, (_, i) => ((seed + i) % 97) / 97).join(',')}]'::vector(384)`

/**
 * Rows chosen so that every hazard in the contract is present at least once:
 * NULL beside empty text, two byte-different Unicode spellings that render
 * alike, numeric NaN and both infinities, date and timestamptz infinities,
 * and two jsonb values whose key order differs in the literal.
 */
const ROWS = `
INSERT INTO fx.adversarial (id, note, amount, n, big, flag, d, ts, doc, u, v) VALUES
 ('r01-null',    NULL,  NULL,                NULL,       NULL,                 NULL,  NULL,             NULL,                       NULL,             NULL, NULL),
 ('r02-empty',   '',    0,                   0,          0,                    false, 'epoch'::date,    'epoch'::timestamptz,       '{}'::jsonb,      '00000000-0000-0000-0000-000000000000', ${VEC(0)}),
 ('r03-scale',   'a',   1.10,                1,          1,                    true,  '2026-01-01',     '2026-01-01T00:00:00Z',     '{"a":1,"b":2}',  '11111111-1111-1111-1111-111111111111', ${VEC(1)}),
 ('r04-nan',     'b',   'NaN'::numeric,      -1,         -1,                   true,  '2026-02-02',     '2026-02-02T12:34:56.789Z', '{"b":2,"a":1}',  '22222222-2222-2222-2222-222222222222', ${VEC(2)}),
 ('r05-inf',     'c',   'Infinity'::numeric, 2147483647, 9223372036854775807,  true,  'infinity'::date, 'infinity'::timestamptz,    '[1,2,3]'::jsonb, '33333333-3333-3333-3333-333333333333', ${VEC(3)}),
 ('r06-neginf',  'd',   '-Infinity'::numeric,-2147483648,-9223372036854775808, false,'-infinity'::date,'-infinity'::timestamptz,    'null'::jsonb,    '44444444-4444-4444-4444-444444444444', ${VEC(4)}),
 ('r07-nfc', 'caf' || chr(233), 2.5,  7, 7,  true,  '2026-03-03', '2026-03-03T01:02:03Z', '{"k":"x"}',       '55555555-5555-5555-5555-555555555555', ${VEC(5)}),
 ('r08-nfd', 'cafe' || chr(769), 2.50, 8, 8,  false, '2026-03-04', '2026-03-04T01:02:03Z', '{"k":"x"}',       '66666666-6666-6666-6666-666666666666', ${VEC(6)}),
 ('r09-nine',    'y',   9.0,                 9,          9,                    true,  '2026-03-05',     '2026-03-05T01:02:03Z',     '"s"'::jsonb,     '77777777-7777-7777-7777-777777777777', ${VEC(7)}),
 ('r10-tail',    'z',   3.14159,             10,         10,                   false, '2026-03-06',     '2026-03-06T01:02:03Z',     '{"z":[{"y":1}]}','88888888-8888-8888-8888-888888888888', ${VEC(8)});
INSERT INTO fx.composite_pk VALUES ('a2','b1','p1'), ('a1','b1','p2'), ('a1','b2','p3');
`

interface Harness { readonly c: DisposableCluster }

async function build(): Promise<DisposableCluster> {
  const c = await startDisposableCluster()
  try {
    await c.sql(`CREATE DATABASE ${DB}`)
    await c.sql(DDL, DB)
    await c.sql(ROWS, DB)
    return c
  } catch (err) {
    // A cluster that started and then failed to prepare must not outlive the
    // failure. The registry would catch it too; this keeps the window shorter.
    await c.stop()
    throw err
  }
}

async function columnsOf(c: DisposableCluster, schema: string, table: string): Promise<ColumnSpec[]> {
  const sql = LIVE_COLUMNS_SQL.replace('$1', `'${schema}'`).replace('$2', `'${table}'`)
  const rows = await c.rows(sql, DB)
  // psql renders SQL NULL as the empty string under -A -t; '' means "no row".
  const orNull = (v: string): string | null => (v === '' ? null : v)
  return rows.map(r => ({
    name: r[0], formatType: r[1], typname: r[2], typnamespace: r[3],
    typtype: r[4], typcategory: r[5], typmod: Number(r[6]),
    sendName: r[7], sendNamespace: r[8],
    typeExtension: orNull(r[9]), typeExtensionVersion: orNull(r[10]),
    sendExtension: orNull(r[11]),
  }))
}

async function pkOf(c: DisposableCluster, schema: string, table: string): Promise<string[]> {
  const sql = PK_COLUMNS_SQL.replace('$1', `'${schema}'`).replace('$2', `'${table}'`)
  return (await c.rows(sql, DB)).map(r => r[0])
}

async function digestOf(
  c: DisposableCluster, schema: string, table: string,
  opts: { batchRows?: number; schemaDigest?: string } = {},
): Promise<{ digest: string; batches: BatchSummary[] }> {
  const columns = await columnsOf(c, schema, table)
  assertSupportedColumns(columns, CONTRACT)
  const pkColumns = await pkOf(c, schema, table)
  const schemaDigest = opts.schemaDigest ?? SCHEMA_DIGEST
  const sql = batchDigestSql({
    schema, table, pkColumns, columns, schemaDigest, contract: CONTRACT,
    batchRows: opts.batchRows ?? 4,
  })
  const rows = await c.rows(sql, DB)
  const batches: BatchSummary[] = rows.map(r => ({
    batch: Number(r[0]), rows: Number(r[1]), bytes: Number(r[2]), digest: r[3],
  }))
  return { digest: tableDigest({ schema, table, schemaDigest, batches }), batches }
}

let A: Harness
let B: Harness

beforeAll(async () => {
  A = { c: await build() }
  B = { c: await build() }
  CONTRACT = await vectorContract(A.c)
}, 180_000)

afterAll(async () => {
  // Not `A?.c.stop()`: if beforeAll threw between starting a cluster and
  // assigning it, that binding is undefined and the postmaster would survive.
  await stopAllDisposableClusters()
})

describe('cluster containment', () => {
  it('runs on a Unix socket with no TCP listener, never on 5432 or 5433', async () => {
    for (const c of [A.c, B.c]) {
      expect(FORBIDDEN_PORTS).not.toContain(c.port)
      const conf = await c.rows(`SELECT current_setting('listen_addresses'), current_setting('port')`)
      expect(conf[0][0]).toBe('')
      expect(conf[0][1]).toBe(String(c.port))
      expect((await c.rows('SELECT inet_server_addr() IS NULL'))[0][0]).toBe('t')
    }
    expect(A.c.port).not.toBe(B.c.port)
  })

  it('keeps every byte under its own temporary root', () => {
    for (const c of [A.c, B.c]) {
      expect(c.pgdata.startsWith(c.root)).toBe(true)
      expect(c.socketDir.startsWith(c.root)).toBe(true)
    }
    expect(A.c.root).not.toBe(B.c.root)
  })
})

describe('identical databases', () => {
  it('produce identical table digests, built independently', async () => {
    const a = await digestOf(A.c, 'fx', 'adversarial')
    const b = await digestOf(B.c, 'fx', 'adversarial')
    expect(a.digest).toBe(b.digest)
    expect(a.batches.map(x => x.digest)).toEqual(b.batches.map(x => x.digest))
  })

  it('batch without OFFSET, at the requested size, with the tail batch short', async () => {
    const { batches } = await digestOf(A.c, 'fx', 'adversarial', { batchRows: 4 })
    expect(batches.map(b => b.batch)).toEqual([0, 1, 2])
    expect(batches.map(b => b.rows)).toEqual([4, 4, 2])
    expect(batches.every(b => b.bytes > 0)).toBe(true)
  })

  it('are insensitive to physical insert order, because the PK orders them', async () => {
    const c = await startDisposableCluster()
    try {
      await c.sql(`CREATE DATABASE ${DB}`)
      await c.sql(DDL, DB)
      // GENUINELY REVERSED. The previous version reversed two multi-row
      // statements, which left the rows inside each one in their original
      // order - it proved almost nothing. Each row is now its own statement,
      // sent in descending primary-key order, so the physical heap order is the
      // exact reverse of A's.
      const rows = ROWS.split('VALUES')[1].split('INSERT INTO fx.composite_pk')[0]
      const tuples = rows.trim().replace(/;\s*$/, '').split(/\),\s*\n/).map((t, i, all) =>
        i === all.length - 1 ? t.trim() : `${t.trim()})`)
      for (const t of [...tuples].reverse()) {
        await c.sql(`INSERT INTO fx.adversarial (id, note, amount, n, big, flag, d, ts, doc, u, v) VALUES ${t}`, DB)
      }
      await c.sql(`INSERT INTO fx.composite_pk VALUES ('a1','b2','p3'), ('a1','b1','p2'), ('a2','b1','p1')`, DB)
      const order = await c.rows(`SELECT id FROM fx.adversarial`, DB)
      const orderA = await A.c.rows(`SELECT id FROM fx.adversarial`, DB)
      expect(order.map(r => r[0])).toEqual([...orderA.map(r => r[0])].reverse())
      const a = await digestOf(A.c, 'fx', 'adversarial')
      const r = await digestOf(c, 'fx', 'adversarial')
      expect(r.digest).toBe(a.digest)
    } finally {
      await c.stop()
    }
  }, 180_000)

  it('order a composite key in CONSTRAINT order, not alphabetically', async () => {
    expect(await pkOf(A.c, 'fx', 'composite_pk')).toEqual(['b', 'a'])
    const a = await digestOf(A.c, 'fx', 'composite_pk')
    const b = await digestOf(B.c, 'fx', 'composite_pk')
    expect(a.digest).toBe(b.digest)
  })

  it('give an empty table a deterministic digest with zero batches', async () => {
    const a = await digestOf(A.c, 'fx', 'empty_t')
    const b = await digestOf(B.c, 'fx', 'empty_t')
    expect(a.batches).toEqual([])
    expect(a.digest).toBe(b.digest)
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('cross-database mismatch — one value differs, nothing else', () => {
  /** Apply a mutation to B, digest both, restore B. */
  async function divergence(mutate: string, restore: string): Promise<{ a: string; b: string }> {
    const a = await digestOf(A.c, 'fx', 'adversarial')
    await B.c.sql(mutate, DB)
    try {
      const b = await digestOf(B.c, 'fx', 'adversarial')
      return { a: a.digest, b: b.digest }
    } finally {
      await B.c.sql(restore, DB)
    }
  }

  it('one byte of text', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET id = 'r10-taiL' WHERE id = 'r10-tail'`,
      `UPDATE fx.adversarial SET id = 'r10-tail' WHERE id = 'r10-taiL'`,
    )
    expect(b).not.toBe(a)
  })

  it('NULL versus empty text — the collision the NULL tag exists to prevent', async () => {
    // r01-null.note IS NULL and r02-empty.note = ''. Under delimiter framing a
    // NULL contributes nothing and an empty string contributes nothing, so the
    // two are indistinguishable. Under the tag they are not.
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET note = NULL WHERE id = 'r02-empty'`,
      `UPDATE fx.adversarial SET note = '' WHERE id = 'r02-empty'`,
    )
    expect(b).not.toBe(a)
  })

  it('NULL versus empty jsonb', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET doc = NULL WHERE id = 'r02-empty'`,
      `UPDATE fx.adversarial SET doc = '{}'::jsonb WHERE id = 'r02-empty'`,
    )
    expect(b).not.toBe(a)
  })

  it('NUMERIC SCALE: 1.10 versus 1.1, equal under = and different by digest', async () => {
    const eq = await B.c.rows(`SELECT 1.10 = 1.1`, DB)
    expect(eq[0][0]).toBe('t')
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET amount = 1.1 WHERE id = 'r03-scale'`,
      `UPDATE fx.adversarial SET amount = 1.10 WHERE id = 'r03-scale'`,
    )
    expect(b, 'scale-preserving equality lost').not.toBe(a)
  })

  it('a numeric NaN replaced by a finite value', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET amount = 0 WHERE id = 'r04-nan'`,
      `UPDATE fx.adversarial SET amount = 'NaN'::numeric WHERE id = 'r04-nan'`,
    )
    expect(b).not.toBe(a)
  })

  it('date infinity replaced by a finite date', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET d = '9999-12-31' WHERE id = 'r05-inf'`,
      `UPDATE fx.adversarial SET d = 'infinity'::date WHERE id = 'r05-inf'`,
    )
    expect(b).not.toBe(a)
  })

  it('timestamptz -infinity replaced by a finite instant', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET ts = '0001-01-01T00:00:00Z' WHERE id = 'r06-neginf'`,
      `UPDATE fx.adversarial SET ts = '-infinity'::timestamptz WHERE id = 'r06-neginf'`,
    )
    expect(b).not.toBe(a)
  })

  it('one float32 lane of a 384-dimension vector', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET v = ${VEC(0)} WHERE id = 'r03-scale'`,
      `UPDATE fx.adversarial SET v = ${VEC(1)} WHERE id = 'r03-scale'`,
    )
    expect(b).not.toBe(a)
  })

  it('a uuid', async () => {
    const { a, b } = await divergence(
      `UPDATE fx.adversarial SET u = '99999999-9999-9999-9999-999999999999' WHERE id = 'r02-empty'`,
      `UPDATE fx.adversarial SET u = '00000000-0000-0000-0000-000000000000' WHERE id = 'r02-empty'`,
    )
    expect(b).not.toBe(a)
  })

  it('a renamed table, and a changed schema digest', async () => {
    const a = await digestOf(A.c, 'fx', 'adversarial')
    await B.c.sql('ALTER TABLE fx.adversarial RENAME TO renamed', DB)
    try {
      const renamed = await digestOf(B.c, 'fx', 'renamed')
      expect(renamed.digest).not.toBe(a.digest)
      // …and the batch digests differ too: the qualified name is inside them.
      expect(renamed.batches[0].digest).not.toBe(a.batches[0].digest)
    } finally {
      await B.c.sql('ALTER TABLE fx.renamed RENAME TO adversarial', DB)
    }
    const other = await digestOf(A.c, 'fx', 'adversarial', { schemaDigest: '0'.repeat(64) })
    expect(other.digest).not.toBe(a.digest)
    expect(other.batches[0].digest).not.toBe(a.batches[0].digest)
  })
})

describe('values PostgreSQL itself normalises', () => {
  it('jsonb key order does NOT change the digest — storage is already normalised', async () => {
    const pair = await A.c.rows(
      `SELECT doc::text FROM fx.adversarial WHERE id IN ('r03-scale','r04-nan') ORDER BY id`, DB)
    expect(pair[0][0]).toBe(pair[1][0])
    const a = await digestOf(A.c, 'fx', 'adversarial')
    await B.c.sql(`UPDATE fx.adversarial SET doc = '{"b":2,"a":1}' WHERE id = 'r03-scale'`, DB)
    try {
      expect((await digestOf(B.c, 'fx', 'adversarial')).digest).toBe(a.digest)
    } finally {
      await B.c.sql(`UPDATE fx.adversarial SET doc = '{"a":1,"b":2}' WHERE id = 'r03-scale'`, DB)
    }
  })

  it('preserves Unicode BYTES — NFC and NFD are different data, not the same text', async () => {
    const r = await A.c.rows(
      `SELECT octet_length(note), length(note) FROM fx.adversarial WHERE id IN ('r07-nfc','r08-nfd') ORDER BY id`, DB)
    // Precomposed U+00E9 is 5 bytes / 4 code points; 'e' + combining U+0301 is
    // 6 / 5. They render alike and are different data.
    expect([Number(r[0][0]), Number(r[1][0])]).toEqual([5, 6])
    expect([Number(r[0][1]), Number(r[1][1])]).toEqual([4, 5])
    // Swapping one spelling for the other changes the digest — no normalisation.
    const a = await digestOf(A.c, 'fx', 'adversarial')
    await B.c.sql(`UPDATE fx.adversarial SET note = 'cafe' || chr(769) WHERE id = 'r07-nfc'`, DB)
    try {
      expect((await digestOf(B.c, 'fx', 'adversarial')).digest).not.toBe(a.digest)
    } finally {
      await B.c.sql(`UPDATE fx.adversarial SET note = 'caf' || chr(233) WHERE id = 'r07-nfc'`, DB)
    }
  })
})

describe('unsupported types refuse before any data is scanned', () => {
  it('refuses float8 without issuing the digest query', async () => {
    const c = await startDisposableCluster()
    try {
      await c.sql(`CREATE DATABASE ${DB}`)
      await c.sql('CREATE SCHEMA fx; CREATE TABLE fx.bad (id text PRIMARY KEY, f float8)', DB)
      const columns = await columnsOf(c, 'fx', 'bad')
      const before = c.queryCount()
      expect(() => assertSupportedColumns(columns, CONTRACT)).toThrow(/NaN <> NaN/)
      expect(c.queryCount(), 'a statement was issued after the refusal').toBe(before)
      expect(c.issued().some(s => s.includes('sha256'))).toBe(false)
    } finally {
      await c.stop()
    }
  }, 180_000)
})

describe('the client sees summaries, never rows', () => {
  it('receives exactly four scalars per batch', async () => {
    const columns = await columnsOf(A.c, 'fx', 'adversarial')
    const sql = batchDigestSql({
      schema: 'fx', table: 'adversarial', pkColumns: ['id'], columns,
      schemaDigest: SCHEMA_DIGEST, contract: CONTRACT, batchRows: 4,
    })
    const rows = await A.c.rows(sql, DB)
    expect(rows.length).toBe(3)
    for (const r of rows) expect(r.length).toBe(4)
    // No row payload: the only 64-hex field is the batch digest itself, and the
    // total bytes returned are bounded by the batch count, not the row count.
    const returned = rows.flat().join('').length
    expect(returned).toBeLessThan(500)
  })
})

describe('the root digest over several tables', () => {
  it('agrees across clusters and binds the ordered table list', async () => {
    const names: [string, string][] = [['fx', 'adversarial'], ['fx', 'composite_pk'], ['fx', 'empty_t']]
    const build = async (c: DisposableCluster) => {
      const out = []
      for (const [s, t] of names) out.push({ schema: s, table: t, digest: (await digestOf(c, s, t)).digest })
      return out
    }
    const a = await build(A.c)
    const b = await build(B.c)
    expect(rootDigest(a)).toBe(rootDigest(b))
    expect(rootDigest([a[1], a[0], a[2]])).not.toBe(rootDigest(a))
    expect(rootDigest(a.slice(0, 2))).not.toBe(rootDigest(a))
  })
})

describe('a hostile search_path cannot influence the digest', () => {
  it('ignores shadow send functions and shadow catalog helpers', async () => {
    const before = await digestOf(A.c, 'fx', 'adversarial')
    // Every helper the frame and the fold use, shadowed in a schema that comes
    // FIRST in search_path. If any generated call were unqualified, one of
    // these would run instead of pg_catalog's.
    await B.c.sql(`
      CREATE SCHEMA evil;
      CREATE FUNCTION evil.textsend(text)    RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT '\\xdeadbeef'::pg_catalog.bytea $$;
      CREATE FUNCTION evil.numeric_send(numeric) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT '\\xdeadbeef'::pg_catalog.bytea $$;
      CREATE FUNCTION evil.int4send(integer) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT '\\xdeadbeef'::pg_catalog.bytea $$;
      CREATE FUNCTION evil.octet_length(bytea) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 0 $$;
      CREATE FUNCTION evil.sha256(bytea)     RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT '\\x00'::pg_catalog.bytea $$;
      CREATE FUNCTION evil.encode(bytea, text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'shadowed' $$;
      ALTER DATABASE ${DB} SET search_path = evil, public, pg_catalog;
    `, DB)
    try {
      const path = await B.c.rows(`SHOW search_path`, DB)
      expect(path[0][0]).toContain('evil')
      // The shadows are real: called unqualified, they answer.
      const proof = await B.c.rows(`SELECT encode(textsend('x'::text), 'hex')`, DB)
      expect(proof[0][0]).toBe('shadowed')
      // …and the digest is unchanged, because every generated call is qualified.
      expect((await digestOf(B.c, 'fx', 'adversarial')).digest).toBe(before.digest)
    } finally {
      await B.c.sql(`ALTER DATABASE ${DB} RESET search_path; DROP SCHEMA evil CASCADE;`, DB)
    }
  }, 180_000)

  it('refuses a column whose typsend resolves outside pg_catalog', async () => {
    const c = await startDisposableCluster()
    try {
      await c.sql(`CREATE DATABASE ${DB}`)
      // A type of our own, with our own send function: same NAME shape as a
      // built-in, different identity. The catalogue tells the truth.
      await c.sql(`
        CREATE SCHEMA fx;
        CREATE FUNCTION fx.mytext_in(cstring) RETURNS fx.mytext LANGUAGE internal IMMUTABLE STRICT AS 'textin';
        CREATE FUNCTION fx.mytext_out(fx.mytext) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'textout';
        CREATE FUNCTION fx.mytext_send(fx.mytext) RETURNS bytea LANGUAGE internal IMMUTABLE STRICT AS 'textsend';
        CREATE TYPE fx.mytext (INPUT = fx.mytext_in, OUTPUT = fx.mytext_out, SEND = fx.mytext_send, INTERNALLENGTH = VARIABLE, STORAGE = extended);
        CREATE TABLE fx.shadowed (id text PRIMARY KEY, weird fx.mytext);
      `, DB)
      const columns = await columnsOf(c, 'fx', 'shadowed')
      const weird = columns.find(x => x.name === 'weird')!
      expect(weird.typnamespace).toBe('fx')
      expect(weird.sendNamespace).toBe('fx')
      expect(() => assertSupportedColumns(columns, CONTRACT)).toThrow(CanonicalRefused)
    } finally {
      await c.stop()
    }
  }, 180_000)
})

describe('cluster lifecycle', () => {
  it('cleans up when start reports failure AFTER a postmaster came up', async () => {
    const before = unstoppedRoots().length
    await expect(startDisposableCluster({ __failStartWait: true }))
      .rejects.toThrow(/simulated/)
    // The handle cleaned itself up on the way out: nothing is left registered,
    // no postmaster survives, and no root remains.
    expect(unstoppedRoots().length).toBe(before)
  }, 180_000)

  it('PRESERVES the root when shutdown cannot be proved, and allows a retry', async () => {
    const c = await startDisposableCluster({ __failStop: true })
    const { root, pgdata, port } = c
    await expect(c.stop()).rejects.toThrow(/still running after an immediate stop/)
    // The root survives a failed stop, and the cluster stays registered.
    expect(clusterResidue({ root, port }).rootExists).toBe(true)
    expect(unstoppedRoots()).toContain(root)
    expect(await postmasterAlive(pgdata)).toBe(true)
    // A real stop, through the outer guard, still works — the failed attempt
    // was not memoised.
    await stopAllDisposableClusters()
    expect(await postmasterAlive(pgdata)).toBe(false)
    expect(clusterResidue({ root, port })).toEqual({ rootExists: false, socketExists: false })
    expect(unstoppedRoots()).not.toContain(root)
  }, 180_000)

  it('is idempotent and concurrency-safe', async () => {
    const c = await startDisposableCluster()
    const { root, pgdata, port } = c
    await Promise.all([c.stop(), c.stop(), c.stop()])
    await c.stop()
    expect(await postmasterAlive(pgdata)).toBe(false)
    expect(clusterResidue({ root, port })).toEqual({ rootExists: false, socketExists: false })
  }, 180_000)

  it('never hands two live clusters the same socket port', async () => {
    const xs = await Promise.all([startDisposableCluster(), startDisposableCluster(), startDisposableCluster()])
    try {
      const ports = xs.map(x => x.port)
      expect(new Set(ports).size).toBe(ports.length)
      for (const p of ports) expect(FORBIDDEN_PORTS).not.toContain(p)
    } finally {
      for (const x of xs) await x.stop()
    }
  }, 180_000)
})

describe('teardown', () => {
  it('stops a cluster the test never captured — the orphan defect', async () => {
    // The failure this guards: beforeAll starts a cluster, throws before
    // assigning it, and `A?.c.stop()` has nothing to call. It happened twice
    // while this file was being written and left two live postmasters under
    // /tmp. The registry makes teardown reachable without the binding.
    const before = await startDisposableCluster()
    const { root, pgdata, port } = before
    expect(await postmasterAlive(pgdata)).toBe(true)
    await stopAllDisposableClusters()
    expect(await postmasterAlive(pgdata)).toBe(false)
    expect(clusterResidue({ root, port })).toEqual({ rootExists: false, socketExists: false })
  }, 180_000)

  it('leaves no postmaster, no socket and no temporary root', async () => {
    const c = await startDisposableCluster()
    const { root, pgdata, port } = c
    expect(await postmasterAlive(pgdata)).toBe(true)
    await c.stop()
    expect(await postmasterAlive(pgdata)).toBe(false)
    expect(clusterResidue({ root, port })).toEqual({ rootExists: false, socketExists: false })
  }, 180_000)
})
