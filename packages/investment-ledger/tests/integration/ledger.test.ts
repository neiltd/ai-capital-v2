import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { runMigrations } from '../../../db/src/migrate.js'
import { publishArchive } from '../../src/publish.js'
import {
  fixtureRoot, connectToTestDatabase, expectRejected, fixtureInspection,
  uniqueSeries, withRollback, testWorkspace } from './support.js'
import { DUAL_CURRENCY_ROW, MISSING_ACCOUNT_ROW, MISSING_NET_ROW } from '../fixtures/rows.js'

let client: Client
const NESTED = { transaction: 'nested' } as const

beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

describe('PostgreSQL ledger foundation', () => {
  it('migrations are recorded once and expose the required schemas', async () => {
    const migration = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM db.schema_migrations
        WHERE filename IN ('011_investment_ledger.sql','012_investment_ledger_remediation.sql',
                           '013_investment_ledger_series_and_corrections.sql')`)
    expect(migration.rows[0].n).toBe(3)
    const schemas = await client.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('investment_ledger','cash_ledger') ORDER BY 1")
    expect(schemas.rows.map(row => row.nspname)).toEqual(['cash_ledger', 'investment_ledger'])
  })

  it('refuses to let the runtime writer run migrations at all', async () => {
    // Round 4: the suite now runs as a NON-OWNER writer with only
    // SELECT/INSERT/UPDATE, which is the shape production is meant to use. It
    // has no business creating schemas, and PostgreSQL agrees. Idempotence of
    // the runner is a property of the bootstrap principal and is exercised by
    // globalSetup, which applies the chain before any test runs.
    await expect(runMigrations()).rejects.toThrow(/permission denied|must be owner/)
  })

  it('records each migration exactly once', async () => {
    const { rows } = await client.query<{ filename: string; n: number }>(
      `SELECT filename, count(*)::int AS n FROM db.schema_migrations
        WHERE filename ~ '^01[1-9]_' GROUP BY filename ORDER BY filename`)
    expect(rows.map(r => r.filename)).toEqual([
      '011_investment_ledger.sql',
      '012_investment_ledger_remediation.sql',
      '013_investment_ledger_series_and_corrections.sql',
      '014_investment_ledger_enforcement.sql',
    ])
    for (const row of rows) expect(row.n, `${row.filename} recorded more than once`).toBe(1)
  })

  it('publishes atomically and exact reruns add no transactions', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('atomic')
      const fixture = fixtureInspection()
      const first = await publishArchive(client, fixture, fixtureRoot(), 'fixture.csv', series, testWorkspace(), NESTED)
      const second = await publishArchive(client, fixture, fixtureRoot(), 'fixture.csv', series, testWorkspace(), NESTED)
      expect(first).toMatchObject({ insertedTransactions: 6, exactRerun: false, seriesKey: series })
      expect(second).toMatchObject({ insertedTransactions: 0, exactRerun: true, batchId: first.batchId })
    })
  })

  it('invalid import leaves no partially published batch', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('invalid')
      const fixture = fixtureInspection(2)
      fixture.rows[1] = { ...fixture.rows[1], currency: 'INVALID' }
      await expectRejected(
        client,
        () => publishArchive(client, fixture, fixtureRoot(), 'invalid.csv', series, testWorkspace(), NESTED),
        /unsupported currency/,
      )
      const count = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.import_batches WHERE source_sha256 = $1', [fixture.sha256])
      expect(count.rows[0].n).toBe(0)
    })
  })

  it('rejects UPDATE and DELETE of economic evidence', async () => {
    await withRollback(client, async () => {
      const result = await publishArchive(
        client, fixtureInspection(1), fixtureRoot(), 'immutable.csv', uniqueSeries('immutable'), testWorkspace(), NESTED)
      // UPDATE is refused by the append-only trigger; DELETE is refused earlier
      // still, by the ACL, since migration 014 revoked it. See enforcement.test.ts.
      await expectRejected(client, () => client.query(
        'UPDATE investment_ledger.import_batches SET source_name = source_name WHERE id = $1', [result.batchId]),
        /append-only/)
      await expectRejected(client, () => client.query(
        'DELETE FROM investment_ledger.import_batches WHERE id = $1', [result.batchId]),
        /permission denied|append-only/)
    })
  })

  it('rejects illegal SQL reconciliation transitions', async () => {
    await withRollback(client, async () => {
      const created = await client.query<{ id: string }>(
        "INSERT INTO investment_ledger.reconciliation_cases (case_key, case_type) VALUES ($1,'field_mismatch') RETURNING id",
        [`case:${randomUUID()}`])
      await expectRejected(client, () => client.query(
        "INSERT INTO investment_ledger.reconciliation_case_events (case_id,event_type,actor) VALUES ($1,'MATCH','test')",
        [created.rows[0].id]), /first reconciliation event must be OPEN/)
    })
  })

  it('stores broker-converted amounts as informational, never economic', async () => {
    await withRollback(client, async () => {
      const published = await publishArchive(
        client, fixtureInspection(1, [DUAL_CURRENCY_ROW]), fixtureRoot(), 'dual-currency.csv',
        uniqueSeries('dual-currency'), testWorkspace(), NESTED)
      const amounts = await client.query<{ currency: string; representation_kind: string; counting_role: string }>(
        `SELECT a.currency, a.representation_kind, a.counting_role
           FROM investment_ledger.transaction_amount_components a
           JOIN investment_ledger.transactions t ON t.id = a.transaction_id
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [published.batchId])
      expect(amounts.rows.some(a => a.representation_kind === 'broker_converted' && a.counting_role === 'informational')).toBe(true)
      expect(amounts.rows.some(a => a.representation_kind === 'broker_converted' && a.counting_role === 'economic')).toBe(false)
      // Currency separation: the converted leg is THB, the economic leg is USD.
      expect(amounts.rows.some(a => a.currency === 'USD' && a.counting_role === 'economic')).toBe(true)
      expect(amounts.rows.every(a => a.representation_kind !== 'broker_converted' || a.currency === 'THB')).toBe(true)
    })
  })

  it('preserves duplicate transaction candidates and deduplicates logical documents', async () => {
    await withRollback(client, async () => {
      const original = fixtureInspection(1)
      const duplicate = { ...original, rows: [original.rows[0], { ...original.rows[0] }] }
      const result = await publishArchive(
        client, duplicate, fixtureRoot(), 'duplicate-candidates.csv', uniqueSeries('duplicates'), testWorkspace(), NESTED)
      const evidence = await client.query(
        `SELECT count(DISTINCT t.id)::int AS transactions,
                count(DISTINCT d.id)::int AS documents,
                count(DISTINCT t.business_fingerprint)::int AS fingerprints
           FROM investment_ledger.raw_import_rows r
           JOIN investment_ledger.transactions t ON t.import_row_id = r.id
           JOIN investment_ledger.transaction_document_links l ON l.transaction_id = t.id
           JOIN investment_ledger.logical_documents d ON d.id = l.logical_document_id
          WHERE r.batch_id = $1`, [result.batchId])
      expect(evidence.rows[0]).toEqual({ transactions: 2, documents: 1, fingerprints: 1 })
    })
  })

  it('publishes explicit account placeholders and leaves missing net components absent', async () => {
    await withRollback(client, async () => {
      const result = await publishArchive(
        client, fixtureInspection(2, [MISSING_ACCOUNT_ROW, MISSING_NET_ROW]), fixtureRoot(), 'missing-values.csv',
        uniqueSeries('placeholders'), testWorkspace(), NESTED)
      const rows = await client.query(
        `SELECT a.resolution_status, t.transaction_type,
                count(c.id) FILTER (WHERE c.component_type = 'net')::int AS net_components
           FROM investment_ledger.raw_import_rows r
           JOIN investment_ledger.transactions t ON t.import_row_id = r.id
           JOIN investment_ledger.accounts a ON a.id = t.account_id
           LEFT JOIN investment_ledger.transaction_amount_components c ON c.transaction_id = t.id
          WHERE r.batch_id = $1
          GROUP BY a.resolution_status, t.transaction_type
          ORDER BY t.transaction_type`, [result.batchId])
      expect(rows.rows).toContainEqual({ resolution_status: 'unresolved', transaction_type: 'FEE', net_components: 1 })
      expect(rows.rows).toContainEqual({ resolution_status: 'resolved', transaction_type: 'BUY', net_components: 0 })
    })
  })

  it('refuses to publish without a series, and refuses a malformed one', async () => {
    await withRollback(client, async () => {
      const fixture = fixtureInspection(1)
      await expect(publishArchive(client, fixture, fixtureRoot(), 'x.csv', '', testWorkspace(), NESTED))
        .rejects.toThrow(/series key is required and has no default/)
      await expect(publishArchive(client, fixture, fixtureRoot(), 'x.csv', 'Not A Series', testWorkspace(), NESTED))
        .rejects.toThrow(/invalid series key/)
      await expect(publishArchive(client, fixture, fixtureRoot(), 'x.csv', 'legacy:unclassified', testWorkspace(), NESTED))
        .rejects.toThrow(/not a publish target/)
    })
  })
})
