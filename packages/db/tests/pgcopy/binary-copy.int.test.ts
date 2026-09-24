// The binary-copy primitive against TWO live PostgreSQL 17 clusters: one source,
// one target. A single cluster would let a "copy" that never left the server
// pass, so source and target are separate postmasters throughout.
//
// portfolio.positions is the fixture because it carries text, numeric and
// timestamptz in one table - the three shapes where a text round trip would
// quietly change a value.

import { inspect } from 'node:util'
import { Readable, Transform, Writable } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  LIVE_COLUMNS_SQL, PK_COLUMNS_SQL, assertSupportedColumns, batchDigestSql,
  type ColumnSpec, type TypeContract,
} from '../../src/pg-copy/canonical.js'
import { BinaryCopyFailed, copyTableBinary } from '../../src/pg-copy/binary-copy.js'
import {
  extractContractFromSession, tableCopySpec, type ContractArtifact,
} from '../../src/pg-copy/schema-contract.js'
import { EXTRACTION_BEGIN_SQL } from '../../bin/pg-copy-contract.js'
import { openPsqlSession, closeAllPsqlSessions } from '../../testing/psql-session.js'
import { createClient } from '../../src/pool.js'
import {
  startDisposableCluster, stopAllDisposableClusters, type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import { buildV19Database } from '../../testing/v19-database.js'

const DB = 'copy_v19'
const T = 'portfolio.positions'
/** Enough rows that the stream is chunked rather than delivered in one buffer. */
const ROWS = 4000

let SRC: DisposableCluster
let TGT: DisposableCluster
let COLUMNS: readonly string[]
/** The contract EXTRACTED from the source, which the copy is bound to. */
let ARTIFACT: ContractArtifact
let CONTRACT: TypeContract = { vector: null }
/** A unique value carried by the row the target's CHECK will reject. */
const ROW_CANARY = `cnry_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
/** A unique value carried by an injected SOURCE error's own message. */
const SOURCE_CANARY = `srcy_${Math.random().toString(36).slice(2)}`

type Client = ReturnType<typeof createClient>

const urlFor = (c: DisposableCluster): string =>
  `postgresql://${c.user}@/${DB}?host=${encodeURIComponent(c.socketDir)}&port=${c.port}`

/** Errors a client emitted after its COPY was destroyed, per client. */
const CLIENT_ERRORS = new WeakMap<object, Error[]>()

/**
 * Open a client WITH an error listener.
 *
 * Destroying an in-flight COPY terminates its connection, so the client emits
 * `error` afterwards. Without a listener that is an unhandled exception - which
 * is exactly what a caller would hit in production, so the tests record it and
 * assert it rather than letting the runner report it as noise.
 */
async function open(c: DisposableCluster): Promise<Client> {
  const client = createClient(urlFor(c))
  const errors: Error[] = []
  CLIENT_ERRORS.set(client, errors)
  client.on('error', (e: Error) => { errors.push(e) })
  await client.connect()
  return client
}

const errorsOf = (client: Client): Error[] => CLIENT_ERRORS.get(client) ?? []

/**
 * Close a client that may already be finished.
 *
 * After a destroyed COPY the connection is gone, so `end()` itself rejects with
 * "Connection terminated". That is the expected outcome, not a failure - but it
 * has to be caught, or it becomes an unhandled rejection in the runner and,
 * equally, in any production caller that forgets.
 */
const CLOSED = new WeakSet<object>()
async function closeQuietly(client: Client): Promise<Error | null> {
  if (CLOSED.has(client)) return null
  CLOSED.add(client)
  try { await client.end(); return null } catch (e) { return e as Error }
}

/** Wait briefly for an asynchronous connection teardown to be observable. */
const settle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 150)) }

/**
 * A client whose COPY was destroyed is FINISHED, and proving that has to be
 * bounded: a query on a dead connection may never settle at all, so an
 * unbounded `rejects.toThrow()` would hang the suite rather than fail it.
 */
async function expectUnusable(client: Client): Promise<void> {
  const outcome = await Promise.race([
    client.query('SELECT 1').then(() => 'succeeded' as const, () => 'rejected' as const),
    new Promise<'never-settled'>(r => setTimeout(() => r('never-settled'), 2000)),
  ])
  expect(outcome, 'the session survived a destroyed COPY').not.toBe('succeeded')
}

/**
 * The seed.
 *
 * Every column of portfolio.positions is NOT NULL, so a NULL/empty-string
 * distinction is not expressible on this table - that is a property of the
 * reviewed schema, not an omission here. The empty string is therefore used on
 * the two text columns that are NOT enum-constrained (`company`, `price_symbol`)
 * against non-empty values elsewhere. `asset_class`, `currency` and `strategy`
 * carry CHECK constraints, so they take values from their own reviewed sets.
 * The numerics deliberately include 1.10 and 1.1 - equal under `=`, different on
 * the wire - alongside negatives and a value four orders of magnitude smaller;
 * the timestamps carry microseconds a second-resolution round trip would lose.
 */
const SEED = `
INSERT INTO portfolio.positions
  (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl,
   updated_at, asset_class, currency, price_symbol, strategy)
SELECT
  CASE WHEN g = 1 THEN '${ROW_CANARY}' ELSE 'T' || g::text END,
  CASE WHEN g % 7 = 0 THEN '' ELSE 'Company ' || g::text END,
  CASE WHEN g % 3 = 0 THEN -1.10 ELSE 1.1 END::numeric,
  (g::numeric / 1000),
  CASE WHEN g % 5 = 0 THEN 0.000001 ELSE 1234.567890 END::numeric,
  (-1 * g)::numeric,
  0::numeric,
  TIMESTAMPTZ '2026-01-02 03:04:05.000001+00' + (g || ' microseconds')::interval,
  (ARRAY['us_equity','th_equity','th_fund','gold','cash'])[1 + (g % 5)],
  (ARRAY['USD','THB'])[1 + (g % 2)],
  CASE WHEN g % 11 = 0 THEN '' ELSE 'SYM' || g::text END,
  (ARRAY['tactical','dca','tax_locked'])[1 + (g % 3)]
FROM pg_catalog.generate_series(1, ${ROWS}) AS g`

beforeAll(async () => {
  SRC = await startDisposableCluster()
  TGT = await startDisposableCluster()
  await buildV19Database(SRC, DB)
  await buildV19Database(TGT, DB)
  await SRC.sql(SEED, DB)
  CONTRACT = {
    vector: {
      extension: 'vector',
      version: (await SRC.rows(
        `SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'vector'`, DB))[0][0],
      dimension: 384, sendName: 'vector_send',
    },
  }
  // THE contract, extracted from the source in one read-only snapshot. The copy
  // is bound to this artifact; there is no second column authority in this file.
  const ext = await openPsqlSession(SRC, DB)
  try {
    await ext.must(EXTRACTION_BEGIN_SQL)
    ARTIFACT = await extractContractFromSession(ext, ext.pid)
    await ext.must('ROLLBACK')
  } finally { await ext.close() }
  COLUMNS = tableCopySpec(ARTIFACT, T).columns
  expect(COLUMNS.length).toBe(12)
}, 900_000)

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
})

async function columnsOf(c: DisposableCluster): Promise<ColumnSpec[]> {
  const rows = await c.rows(
    LIVE_COLUMNS_SQL.replace('$1', `'portfolio'`).replace('$2', `'positions'`), DB)
  const orNull = (v: string): string | null => (v === '' ? null : v)
  return rows.map(r => ({
    name: r[0], formatType: r[1], typname: r[2], typnamespace: r[3],
    typtype: r[4], typcategory: r[5], typmod: Number(r[6]),
    sendName: r[7], sendNamespace: r[8],
    typeExtension: orNull(r[9]), typeExtensionVersion: orNull(r[10]),
    sendExtension: orNull(r[11]),
  }))
}

/** The Slice-1 canonical digest of portfolio.positions, on one client. */
async function digestOn(client: Client, cluster: DisposableCluster): Promise<string[]> {
  const columns = await columnsOf(cluster)
  assertSupportedColumns(columns, CONTRACT)
  const pkColumns = (await cluster.rows(
    PK_COLUMNS_SQL.replace('$1', `'portfolio'`).replace('$2', `'positions'`), DB)).map(r => r[0])
  const sql = batchDigestSql({
    schema: 'portfolio', table: 'positions', pkColumns, columns,
    schemaDigest: 'a'.repeat(64), contract: CONTRACT, batchRows: 1000,
  })
  const r = await client.query(sql)
  return r.rows.map((row: Record<string, unknown>) => String(row.digest))
}

/** Raw numeric_send bytes, ordered - the representation a text copy would lose. */
async function numericSend(client: Client): Promise<string[]> {
  const r = await client.query(
    `SELECT pg_catalog.encode(pg_catalog.numeric_send(shares), 'hex') AS s,
            pg_catalog.encode(pg_catalog.numeric_send(current_price), 'hex') AS p
       FROM portfolio.positions ORDER BY ticker`)
  return r.rows.map((row: Record<string, unknown>) => `${String(row.s)}|${String(row.p)}`)
}

describe('one table, source to target, in binary', () => {
  it('copies portfolio.positions byte-for-byte into a second cluster', async () => {
    const source = await open(SRC)
    const target = await open(TGT)
    try {
      await source.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
      await target.query('BEGIN')
      const srcPid = (await source.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p
      const tgtPid = (await target.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p

      const result = await copyTableBinary(source, target, { artifact: ARTIFACT, qname: T })
      expect(result.qname).toBe(T)
      expect(result.bytes).toBeGreaterThan(0)
      expect(result.sourceSql).toContain('FORMAT BINARY')

      // The SAME backends throughout - the primitive opened nothing.
      expect((await source.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p).toBe(srcPid)
      expect((await target.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p).toBe(tgtPid)

      // Inside the still-open target transaction: same digest, same raw numerics.
      const srcDigest = await digestOn(source, SRC)
      const tgtDigest = await digestOn(target, TGT)
      expect(tgtDigest.length).toBeGreaterThan(1)   // multiple batches
      expect(tgtDigest).toEqual(srcDigest)
      expect(await numericSend(target)).toEqual(await numericSend(source))

      // Only now, and only in the harness.
      await target.query('COMMIT')
      await source.query('ROLLBACK')

      const tgtCount = (await TGT.rows(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM ${T}`, DB))[0][0]
      const srcCount = (await SRC.rows(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM ${T}`, DB))[0][0]
      expect(tgtCount).toBe(String(ROWS))
      expect(srcCount).toBe(String(ROWS))
      // Scale survived: 1.10 and 1.1 are still distinguishable on the target.
      const scales = (await TGT.rows(
        `SELECT DISTINCT pg_catalog.scale(shares)::pg_catalog.text FROM ${T} ORDER BY 1`, DB))
        .map(r => r[0])
      expect(scales).toEqual(['1', '2'])
    } finally {
      await closeQuietly(target)
      await closeQuietly(source)
      await TGT.sql(`TRUNCATE ${T}`, DB)
    }
  }, 900_000)
})

describe('failure and cancellation leave nothing behind', () => {
  const emptyTarget = async (): Promise<string> =>
    (await TGT.rows(`SELECT pg_catalog.count(*)::pg_catalog.text FROM ${T}`, DB))[0][0]

  /** COMMIT after an aborted transaction returns a ROLLBACK tag, not an error. */
  async function commitCannotSucceed(target: Client): Promise<void> {
    let tag: string | null = null
    let threw = false
    try {
      tag = (await target.query('COMMIT')).command
    } catch { threw = true }
    expect(threw || tag === 'ROLLBACK', `COMMIT reported "${String(tag)}"`).toBe(true)
    expect(tag).not.toBe('COMMIT')
  }

  it('rejects, and cannot commit, when the SOURCE stream fails after some bytes', async () => {
    const source = await open(SRC)
    const target = await open(TGT)
    try {
      await source.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
      await target.query('BEGIN')
      let seen = 0
      const failing = {
        query: (q: unknown) => {
          const real = (source as unknown as { query: (q: unknown) => Readable }).query(q)
          // The REAL copy stream belongs to this proxy, so the proxy owns its
          // late errors: pg pushes "Connection terminated" into it once the
          // connection dies, and a stream with no listener throws.
          real.on('error', () => { /* the failure is asserted on the pipeline */ })
          const breaker = new Transform({
            transform(chunk: Buffer, _e, cb) {
              seen += chunk.length
              if (seen > 4096) { cb(new Error(`injected source failure ${SOURCE_CANARY}`)); return }
              cb(null, chunk)
            },
          })
          real.pipe(breaker)
          return breaker
        },
      }
      let thrown: unknown = null
      try {
        await copyTableBinary(failing as never, target, { artifact: ARTIFACT, qname: T })
      } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(BinaryCopyFailed)
      expect((thrown as BinaryCopyFailed).phase).toBe('stream-failed')
      // The canary was in the ORIGINAL error's own message and is still gone.
      expect(surfacesOf(thrown)).not.toContain(SOURCE_CANARY)
      expect(seen).toBeGreaterThan(0)
      await settle()
      // The source connection is finished - destroying an in-flight COPY ends it.
      await expectUnusable(source)
      await commitCannotSucceed(target)
      expect(await emptyTarget()).toBe('0')
      // Both close without hanging; the source reports its termination.
      expect(await closeQuietly(target)).toBeNull()
      const closed = await closeQuietly(source)
      expect(closed === null || /terminat/i.test(closed.message)).toBe(true)
      expect(errorsOf(source).length).toBeGreaterThanOrEqual(0)
    } finally {
      await closeQuietly(target)
      await closeQuietly(source)
    }
  }, 900_000)

  /** Every surface an error can leak through once someone logs it. */
  const surfacesOf = (e: unknown): string => {
    const err = e as Error & Record<string, unknown>
    let json = ''
    try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
    return [
      String(err.message), String(err.stack ?? ''),
      Object.getOwnPropertyNames(err).join(','),
      json, inspect(err, { depth: 6 }),
    ].join('\n')
  }

  it('rejects, cannot commit, and says NOTHING about the rejected row', async () => {
    // The target refuses exactly the row carrying the canary.
    await TGT.sql(
      `ALTER TABLE ${T} ADD CONSTRAINT copy_probe_ck CHECK (ticker <> '${ROW_CANARY}')`, DB)
    const source = await open(SRC)
    const target = await open(TGT)
    try {
      // NON-VACUITY: PostgreSQL's own error for this failure DOES carry the row.
      let raw = ''
      try {
        await target.query(
          `INSERT INTO ${T} (ticker, company, shares, avg_cost, current_price, current_value,
             unrealized_pnl, updated_at, asset_class, currency, price_symbol, strategy)
           VALUES ('${ROW_CANARY}', 'x', 1, 1, 1, 1, 1, now(), 'cash', 'USD', '', 'dca')`)
      } catch (e) { raw = surfacesOf(e) }
      expect(raw, 'the raw driver error does not carry the row').toContain(ROW_CANARY)
      await target.query('ROLLBACK')

      await source.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
      await target.query('BEGIN')
      let thrown: unknown = null
      try {
        await copyTableBinary(source, target, { artifact: ARTIFACT, qname: T })
      } catch (e) { thrown = e }

      expect(thrown).toBeInstanceOf(BinaryCopyFailed)
      const failed = thrown as BinaryCopyFailed
      expect(failed.qname).toBe(T)
      expect(failed.phase).toBe('stream-failed')
      const seen = surfacesOf(thrown)
      // The canary the raw error DID contain is gone from every surface.
      expect(seen).not.toContain(ROW_CANARY)
      // Precise: the SQL text, the driver's own fields, the constraint, the row
      // and the connection strings. A bare word like "copy" would match this
      // class's own explanatory sentence and prove nothing.
      for (const leak of ['copy_probe_ck', 'violates check constraint', 'Failing row',
                          `COPY ${T}`, 'TO STDOUT', 'FROM STDIN', 'FORMAT BINARY',
                          'postgresql://', 'password',
                          urlFor(SRC), urlFor(TGT),
                          '"detail"', '"severity"', '"where"', '"routine"', '"code"']) {
        expect(seen, `leaked ${leak}`).not.toContain(leak)
      }
      await settle()
      await commitCannotSucceed(target)
      expect(await emptyTarget()).toBe('0')
    } finally {
      await closeQuietly(target)
      await closeQuietly(source)
      await TGT.sql(`ALTER TABLE ${T} DROP CONSTRAINT copy_probe_ck`, DB)
    }
  }, 900_000)

  it('rejects, and cannot commit, when the caller ABORTS after some bytes', async () => {
    const source = await open(SRC)
    const target = await open(TGT)
    const ac = new AbortController()
    try {
      await source.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ')
      await target.query('BEGIN')
      let seen = 0
      const watched = {
        query: (q: unknown) => {
          const real = (source as unknown as { query: (q: unknown) => Readable }).query(q)
          real.on('error', () => { /* the failure is asserted on the pipeline */ })
          const counter = new Transform({
            transform(chunk: Buffer, _e, cb) {
              seen += chunk.length
              if (seen > 4096 && !ac.signal.aborted) ac.abort()
              cb(null, chunk)
            },
          })
          real.pipe(counter)
          return counter
        },
      }
      let thrown: unknown = null
      try {
        await copyTableBinary(
          watched as never, target, { artifact: ARTIFACT, qname: T, signal: ac.signal })
      } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(BinaryCopyFailed)
      expect((thrown as BinaryCopyFailed).phase).toBe('cancelled')
      expect((thrown as BinaryCopyFailed).qname).toBe(T)
      expect(surfacesOf(thrown)).not.toContain('AbortError')
      expect(seen).toBeGreaterThan(0)
      await settle()
      await expectUnusable(source)
      await commitCannotSucceed(target)
      expect(await emptyTarget()).toBe('0')
      expect(await closeQuietly(target)).toBeNull()
      const closed = await closeQuietly(source)
      expect(closed === null || /terminat/i.test(closed.message)).toBe(true)
    } finally {
      await closeQuietly(target)
      await closeQuietly(source)
    }
  }, 900_000)

  it('leaves no COPY running on either cluster, and both clients close cleanly', async () => {
    for (const [label, c] of [['source', SRC], ['target', TGT]] as const) {
      const busy = await c.rows(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_stat_activity
          WHERE query ILIKE 'COPY %' AND pid <> pg_catalog.pg_backend_pid()`, DB)
      expect(busy[0][0], `${label} still has a COPY running`).toBe('0')
    }
    // A fresh pair still connects and closes - nothing is wedged.
    const s = await open(SRC)
    const t = await open(TGT)
    expect(await closeQuietly(s)).toBeNull()
    expect(await closeQuietly(t)).toBeNull()
    expect(await emptyTarget()).toBe('0')
  }, 300_000)

  it('refuses an unreviewed table without touching either session', async () => {
    const source = await open(SRC)
    const target = await open(TGT)
    try {
      await expect(copyTableBinary(source, target, { artifact: ARTIFACT, qname: 'desk.probe' }))
        .rejects.toThrow(/not in the reviewed copy set/)
    } finally { await closeQuietly(target); await closeQuietly(source) }
  }, 300_000)
})

/** Referenced so the unused-import check stays honest about Writable. */
void Writable
