// F4: the full 621-row publication, made non-vacuous and repeatable.
//
// THE ONE INTEGRATION FILE THAT READS THE OPERATOR'S REAL ARCHIVE. Every other
// integration test publishes fabricated rows and needs no INVESTMENT_ARCHIVE_CSV;
// this one is about the real file's scale, so it cannot.
//
// THE DEFECT. The round-1 test called publishArchive and then asserted only
// that 621 transactions existed for the returned batch id. It never asserted
// that THIS call inserted them. Once the batch existed in ai_capital_test,
// every later run took the exact-rerun branch, returned the pre-existing batch
// id, and passed in 52ms without publishing anything. Independent verification
// caught it by comparing the batch's published_at with the run's clock.
//
// THE FIX. Every run publishes into a series nothing has ever used, asserts the
// insert count and the exactRerun flag explicitly, and rolls the whole thing
// back so the next run starts from the same place.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { inspectArchive } from '../../src/inspect.js'
import { publishArchive } from '../../src/publish.js'
import {
  archiveCsv, archiveRoot, connectToTestDatabase, tableCounts, uniqueSeries, withRollback, testWorkspace } from './support.js'

let client: Client
const NESTED = { transaction: 'nested' } as const

beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

describe('F4 the full 621-row archive publishes once and is then idempotent', () => {
  it('inserts exactly 621 on first publication and exactly 0 on an identical rerun', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('master-archive')
      const inspection = inspectArchive(archiveCsv())
      expect(inspection.rows).toHaveLength(621)

      const first = await publishArchive(client, inspection, archiveRoot(), 'transactions_all.csv', series, testWorkspace(), NESTED)

      // The assertions the old test was missing. These are what make the run
      // prove publication rather than merely observe residue.
      expect(first.exactRerun, 'the first publication must not be an exact rerun').toBe(false)
      expect(first.insertedTransactions, 'the first publication must insert all 621 rows').toBe(621)
      expect(first.priorBatchId, 'a fresh series has no predecessor').toBeNull()
      expect(first.seriesKey).toBe(series)

      const tx = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [first.batchId])
      expect(tx.rows[0].n).toBe(621)

      // All 621 are current: nothing in another series can take them out.
      const current = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.current_transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [first.batchId])
      expect(current.rows[0].n, 'every published row must be in the current projection').toBe(621)

      const groups = await client.query<{ n: number }>(
        `SELECT count(DISTINCT t.transaction_group_id)::int AS n
           FROM investment_ledger.transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
           JOIN investment_ledger.transaction_groups g ON g.id = t.transaction_group_id
          WHERE r.batch_id = $1 AND g.group_type = 'switch'`, [first.batchId])
      // DYNAMIC, not a pinned figure. The published group count must equal the
      // count this run's inspection derived from the file — which is the actual
      // claim ("publication preserves switch identity"), and which states no
      // private magnitude in committed source. A hardcoded number would also
      // silently become wrong the day the archive is legitimately revised.
      expect(inspection.switchGroupKeys.length,
        'the archive must contain switch groups for this to prove anything').toBeGreaterThan(0)
      expect(groups.rows[0].n, 'published switch groups must match the inspection')
        .toBe(inspection.switchGroupKeys.length)

      const negatives = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.validation_findings
          WHERE batch_id = $1 AND finding_code = 'NEGATIVE_DERIVED_POSITION'`, [first.batchId])
      // Same rule: compared against this run's derivation, never a pinned count.
      expect(inspection.negativePositionKeys.length,
        'the archive must derive short positions for this to prove anything').toBeGreaterThan(0)
      expect(negatives.rows[0].n, 'published findings must match the derived short positions')
        .toBe(inspection.negativePositionKeys.length)

      // F7: nothing THIS BATCH observed claims a verified document identity.
      //
      // Round-3 correction C: this used to count non-unverified states across
      // the WHOLE database. It passed only because no verification event is
      // ever committed to ai_capital_test; the first one to land would have
      // failed this assertion for reasons having nothing to do with the batch
      // under test. It is now scoped to the documents this batch created, and
      // the control below proves the scoped form still detects a change.
      const scopedUnverified = `
        SELECT count(*)::int AS n
          FROM investment_ledger.current_document_verification v
          JOIN investment_ledger.transaction_document_links l
            ON l.logical_document_id = v.logical_document_id
          JOIN investment_ledger.transactions t ON t.id = l.transaction_id
          JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
         WHERE r.batch_id = $1 AND v.verification_state <> 'unverified'`
      const verified = await client.query<{ n: number }>(scopedUnverified, [first.batchId])
      expect(verified.rows[0].n).toBe(0)

      // CONTROL: the scoped assertion must be able to FAIL. Record a verified
      // event against one of this batch's own file variants and confirm the
      // same query now sees it, then undo just that.
      const ownVariant = await client.query<{ id: string }>(
        `SELECT v.id
           FROM investment_ledger.document_file_variants v
           JOIN investment_ledger.transaction_document_links l
             ON l.logical_document_id = v.logical_document_id
           JOIN investment_ledger.transactions t ON t.id = l.transaction_id
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1 LIMIT 1`, [first.batchId])
      expect(ownVariant.rowCount, 'this batch must own at least one observed file variant').toBe(1)

      await client.query('SAVEPOINT verification_control')
      await client.query(
        `INSERT INTO investment_ledger.document_verification_events
           (variant_id, event_kind, content_sha256, actor, reason)
         VALUES ($1,'verified',$2,'round3-control','scoped-assertion sensitivity check')`,
        [ownVariant.rows[0].id, 'a'.repeat(64)])
      const afterMutation = await client.query<{ n: number }>(scopedUnverified, [first.batchId])
      expect(afterMutation.rows[0].n, 'the scoped assertion must detect a verification-state change in its own fixture').toBe(1)
      await client.query('ROLLBACK TO SAVEPOINT verification_control')
      expect((await client.query<{ n: number }>(scopedUnverified, [first.batchId])).rows[0].n).toBe(0)

      const again = await publishArchive(client, inspection, archiveRoot(), 'transactions_all.csv', series, testWorkspace(), NESTED)
      expect(again).toMatchObject({ exactRerun: true, insertedTransactions: 0, batchId: first.batchId })

      const batches = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.import_batches
          WHERE series_key = $1 AND source_kind = 'archive_csv' AND source_sha256 = $2`,
        [series, inspection.sha256])
      expect(batches.rows[0].n).toBe(1)
    }, )
  }, 600_000)

  it('CONTROL: the old assertion shape passes on a call that published nothing', async () => {
    // This is the round-1 test's exact weakness, isolated. The second call
    // inserts nothing, yet the assertion the old test made — "621 transactions
    // exist for the returned batch id" — is still satisfied by it. Only the
    // insertedTransactions / exactRerun assertions tell the two apart, which is
    // why the test above makes them.
    await withRollback(client, async () => {
      const series = uniqueSeries('control')
      const inspection = { ...inspectArchive(archiveCsv()) }
      const first = await publishArchive(client, inspection, archiveRoot(), 'transactions_all.csv', series, testWorkspace(), NESTED)
      const rerun = await publishArchive(client, inspection, archiveRoot(), 'transactions_all.csv', series, testWorkspace(), NESTED)

      const oldStyle = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [rerun.batchId])

      expect(rerun.insertedTransactions, 'the rerun published nothing').toBe(0)
      expect(oldStyle.rows[0].n, 'yet the old assertion is satisfied by it').toBe(621)
      expect(rerun.batchId).toBe(first.batchId)
      expect(rerun.exactRerun).toBe(true)
    })
  }, 600_000)
})

describe('F8 publication never touches the legacy portfolio tables', () => {
  it('leaves seeded sentinel rows in portfolio.positions and portfolio.trade_log byte-identical', async () => {
    await withRollback(client, async () => {
      // Sentinels make the check non-vacuous: both tables are empty in
      // ai_capital_test, so "unchanged" would otherwise be 0 == 0.
      await client.query(
        `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, updated_at)
         VALUES ('SENTINEL','Ledger isolation sentinel', 42, 3.5, now())`)
      await client.query(
        `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price)
         VALUES ('2026-08-31','SENTINEL','buy', 42, 3.5)`)

      const digest = async () => {
        const { rows } = await client.query<{ positions: string; trade_log: string; np: number; nt: number }>(
          `SELECT (SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p::text),'')) FROM portfolio.positions p) AS positions,
                  (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text),'')) FROM portfolio.trade_log t) AS trade_log,
                  (SELECT count(*)::int FROM portfolio.positions) AS np,
                  (SELECT count(*)::int FROM portfolio.trade_log) AS nt`)
        return rows[0]
      }

      const before = await digest()
      expect(before.np, 'the sentinel must actually be present').toBe(1)
      expect(before.nt).toBe(1)

      const inspection = inspectArchive(archiveCsv())
      const published = await publishArchive(
        client, inspection, archiveRoot(), 'transactions_all.csv', uniqueSeries('sentinel'), testWorkspace(), NESTED)
      expect(published.insertedTransactions).toBe(621)

      const after = await digest()
      expect(after, 'publishing 621 transactions must not touch the legacy portfolio tables').toEqual(before)
    })
  }, 600_000)
})


describe('F4 rollback isolation actually holds', () => {
  it('publishing all 621 rows leaves every tracked table count unchanged', async () => {
    // The mechanism the whole suite depends on, asserted rather than assumed.
    // Nothing is deleted and no privilege is granted to achieve this: the work
    // is done inside a transaction that is rolled back, and the append-only
    // triggers fire throughout.
    const before = await tableCounts(client)
    await withRollback(client, async () => {
      const published = await publishArchive(
        client, inspectArchive(archiveCsv()), archiveRoot(), 'transactions_all.csv',
        uniqueSeries('isolation-proof'), testWorkspace(), NESTED)
      expect(published.insertedTransactions, 'the work must really have happened').toBe(621)
      const during = await tableCounts(client)
      expect(during['investment_ledger.transactions']).toBe(before['investment_ledger.transactions'] + 621)
    })
    const after = await tableCounts(client)
    expect(after).toEqual(before)
  }, 600_000)
})
