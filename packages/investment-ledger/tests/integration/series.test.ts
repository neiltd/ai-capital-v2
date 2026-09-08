// F1: archive-series identity and supersession.
//
// THE DEFECT, observed live in ai_capital_test during independent verification:
// the 621-row master archive returned 0 of 621 rows from current_transactions,
// because a 6-row `fixture.csv` had been published afterwards and
// publishArchive — which chose "the most recent archive_csv batch" with no
// regard for which FILE it came from — made the fixture the master's successor.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { publishArchive } from '../../src/publish.js'
import {
  fixtureRoot, connectToTestDatabase, expectRejected, fixtureInspection, uniqueSeries, withRollback, testWorkspace } from './support.js'

let client: Client
const NESTED = { transaction: 'nested' } as const

beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

async function currentRowsOf(batchId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM investment_ledger.current_transactions t
       JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
      WHERE r.batch_id = $1`, [batchId])
  return rows[0].n
}

async function headOf(series: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM investment_ledger.current_import_batches WHERE series_key = $1', [series])
  expect(rows.length, `series ${series} must have exactly one head`).toBe(1)
  return rows[0]?.id ?? null
}

describe('F1 supersession is scoped to a series', () => {
  it('master v2 supersedes master v1 within the same series', async () => {
    await withRollback(client, async () => {
      const master = uniqueSeries('master')
      const v1 = await publishArchive(client, fixtureInspection(3), fixtureRoot(), 'master.csv', master, testWorkspace(), NESTED)
      const v2 = await publishArchive(client, fixtureInspection(4), fixtureRoot(), 'master.csv', master, testWorkspace(), NESTED)

      expect(v1.priorBatchId).toBeNull()
      expect(v2.priorBatchId).toBe(v1.batchId)
      expect(await headOf(master)).toBe(v2.batchId)

      // v1's rows leave the projection; v2's are the current truth.
      expect(await currentRowsOf(v1.batchId)).toBe(0)
      expect(await currentRowsOf(v2.batchId)).toBe(4)

      // The change is evidenced, not silent.
      const cases = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.reconciliation_cases
          WHERE case_type = 'changed_archive' AND case_key = $1`,
        [`changed-archive:${master}:${v1.batchId}:${v2.batchId}`])
      expect(cases.rows[0].n).toBe(1)
    })
  })

  it('an unrelated broker or fixture import can never hide the master series', async () => {
    await withRollback(client, async () => {
      const master = uniqueSeries('master-kept')
      const broker = uniqueSeries('broker-partial')
      const masterBatch = await publishArchive(
        client, fixtureInspection(5), fixtureRoot(), 'transactions_all.csv', master, testWorkspace(), NESTED)
      expect(await currentRowsOf(masterBatch.batchId)).toBe(5)

      // NON-VACUITY: the OLD selection rule — the most recent archive_csv batch,
      // whatever file it came from — resolves to the master batch right now. The
      // next import would therefore have become the master's successor and taken
      // all five rows out of the projection. That is the defect, reproduced.
      const oldRulePicks = await client.query<{ id: string }>(
        `SELECT id FROM investment_ledger.import_batches
          WHERE source_kind = 'archive_csv' ORDER BY published_at DESC, id DESC LIMIT 1`)
      expect(oldRulePicks.rows[0].id, 'the old global-latest rule would have picked the master batch')
        .toBe(masterBatch.batchId)

      const partial = await publishArchive(
        client, fixtureInspection(2), fixtureRoot(), 'innovestx-partial.csv', broker, testWorkspace(), NESTED)

      expect(partial.priorBatchId, 'a different series must not link back to the master').toBeNull()
      expect(await currentRowsOf(masterBatch.batchId), 'the master must still be current').toBe(5)
      expect(await currentRowsOf(partial.batchId)).toBe(2)
      expect(await headOf(master)).toBe(masterBatch.batchId)
      expect(await headOf(broker)).toBe(partial.batchId)
    })
  })

  it('the current projection holds the latest batch of every series independently', async () => {
    await withRollback(client, async () => {
      const a = uniqueSeries('multi-a')
      const b = uniqueSeries('multi-b')
      const a1 = await publishArchive(client, fixtureInspection(2), fixtureRoot(), 'a.csv', a, testWorkspace(), NESTED)
      const b1 = await publishArchive(client, fixtureInspection(3), fixtureRoot(), 'b.csv', b, testWorkspace(), NESTED)
      const a2 = await publishArchive(client, fixtureInspection(4), fixtureRoot(), 'a.csv', a, testWorkspace(), NESTED)
      const b2 = await publishArchive(client, fixtureInspection(5), fixtureRoot(), 'b.csv', b, testWorkspace(), NESTED)

      const heads = await client.query<{ id: string; series_key: string }>(
        'SELECT id, series_key FROM investment_ledger.current_import_batches WHERE series_key = ANY($1::text[]) ORDER BY series_key',
        [[a, b]])
      expect(heads.rows).toEqual([
        { id: a2.batchId, series_key: a },
        { id: b2.batchId, series_key: b },
      ])
      expect(await currentRowsOf(a1.batchId)).toBe(0)
      expect(await currentRowsOf(a2.batchId)).toBe(4)
      expect(await currentRowsOf(b1.batchId)).toBe(0)
      expect(await currentRowsOf(b2.batchId)).toBe(5)
    })
  })

  it('exact-rerun identity includes the series: same bytes, same series, zero inserted', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('rerun')
      const fixture = fixtureInspection(3)
      const first = await publishArchive(client, fixture, fixtureRoot(), 'r.csv', series, testWorkspace(), NESTED)
      const again = await publishArchive(client, fixture, fixtureRoot(), 'r.csv', series, testWorkspace(), NESTED)
      expect(first).toMatchObject({ insertedTransactions: 3, exactRerun: false })
      expect(again).toMatchObject({ insertedTransactions: 0, exactRerun: true, batchId: first.batchId })

      // The SAME bytes in a DIFFERENT series is a different fact, not a re-run,
      // and it must not be mistaken for one.
      const other = uniqueSeries('rerun-other')
      const elsewhere = await publishArchive(client, fixture, fixtureRoot(), 'r.csv', other, testWorkspace(), NESTED)
      expect(elsewhere.exactRerun).toBe(false)
      expect(elsewhere.batchId).not.toBe(first.batchId)
      expect(elsewhere.priorBatchId).toBeNull()
      expect(await currentRowsOf(first.batchId), 'the first series is untouched').toBe(3)
    })
  })
})

describe('F1 the database itself refuses cross-series and forked supersession', () => {
  it('rejects a changed_from_batch link across two series', async () => {
    await withRollback(client, async () => {
      const a = uniqueSeries('link-a')
      const b = uniqueSeries('link-b')
      const batchA = await publishArchive(client, fixtureInspection(1), fixtureRoot(), 'a.csv', a, testWorkspace(), NESTED)
      await expectRejected(client, () => client.query(
        `INSERT INTO investment_ledger.import_batches
           (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status, changed_from_batch)
         VALUES ($1,'archive_csv','b.csv',$2,'test',1,'published',$3)`,
        [b, 'b'.repeat(64), batchA.batchId]),
        /supersession is only defined within one series/)
    })
  })

  it('rejects a second successor for one predecessor, so a series cannot fork', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('fork')
      const root = await publishArchive(client, fixtureInspection(1), fixtureRoot(), 'f.csv', series, testWorkspace(), NESTED)
      await publishArchive(client, fixtureInspection(2), fixtureRoot(), 'f.csv', series, testWorkspace(), NESTED)
      await expectRejected(client, () => client.query(
        `INSERT INTO investment_ledger.import_batches
           (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status, changed_from_batch)
         VALUES ($1,'archive_csv','f.csv',$2,'test',1,'published',$3)`,
        [series, 'c'.repeat(64), root.batchId]),
        /import_batches_single_successor|duplicate key/)
    })
  })

  it('rejects a malformed series key at the database boundary too', async () => {
    await withRollback(client, async () => {
      await expectRejected(client, () => client.query(
        `INSERT INTO investment_ledger.import_batches
           (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status)
         VALUES ('Not A Series','archive_csv','x.csv',$1,'test',0,'published')`, ['d'.repeat(64)]),
        /import_batches_series_key_format/)
    })
  })
})
