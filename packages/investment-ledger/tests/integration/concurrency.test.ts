// Cross-connection races. These are the ONLY in-process tests that commit:
// proving a second writer is serialized behind the first requires the first to
// actually commit, which a rolled-back transaction cannot do. Each one is kept
// deliberately small, and each carries a non-vacuity control showing the race
// would otherwise be won by both writers.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { createClient } from '../../../db/src/pool.js'
import { publishArchive } from '../../src/publish.js'
import { fixtureInspection, fixtureRoot, connectToTestDatabase, testDatabaseUrl, uniqueSeries, uniqueSha256, testWorkspace } from './support.js'

let client: Client
beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

async function twoWriters<T>(fn: (a: Client, b: Client) => Promise<T>): Promise<T> {
  const url = testDatabaseUrl()
  const a = createClient(url); const b = createClient(url)
  await a.connect(); await b.connect()
  try { return await fn(a, b) } finally { await a.end(); await b.end() }
}

const settleWindow = () => new Promise(resolve => setTimeout(resolve, 400))

describe('F6 concurrent reconciliation transitions cannot both succeed', () => {
  it('two writers from the same prior state produce exactly one winner', async () => {
    await twoWriters(async (a, b) => {
      const caseRow = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases (case_key, case_type)
         VALUES ($1,'field_mismatch') RETURNING id`, [`race-${randomUUID()}`])
      const id = caseRow.rows[0].id
      await client.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'OPEN','test')`, [id])

      await a.query('BEGIN'); await b.query('BEGIN')
      await a.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'RESOLVE','writer-a')`, [id])

      let settled = false
      const second = b.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'FLAG_MISMATCH','writer-b')`, [id]).then(
          r => { settled = true; return r }, e => { settled = true; throw e })

      // NON-VACUITY: without the row lock, writer-b would read state 'open' and
      // succeed immediately. It must still be BLOCKED while a holds the case.
      await settleWindow()
      expect(settled, 'writer-b was not serialized behind writer-a').toBe(false)

      await a.query('COMMIT')
      const outcome = await second.then(() => 'ok', (e: Error) => e.message)
      expect(outcome, 'writer-b must not also transition from open').not.toBe('ok')
      expect(String(outcome)).toMatch(/closed reconciliation case requires REOPEN/)
      await b.query('ROLLBACK')

      const events = await client.query<{ event_type: string }>(
        'SELECT event_type FROM investment_ledger.reconciliation_case_events WHERE case_id = $1 ORDER BY id', [id])
      expect(events.rows.map(r => r.event_type)).toEqual(['OPEN', 'RESOLVE'])
    })
  }, 60_000)
})

describe('F5 concurrent account resolutions cannot both become active', () => {
  it('two writers resolving one placeholder produce exactly one active resolution', async () => {
    await twoWriters(async (a, b) => {
      const account = async (suffix: string, resolved: boolean) => {
        const key = `TEST:race-${suffix}:${randomUUID()}`
        const r = await client.query<{ id: string }>(
          `INSERT INTO investment_ledger.accounts
             (account_key, platform, external_account_id, display_name, resolution_status, unresolved_reason)
           VALUES ($1,'TestBroker',$2,$1,$3,$4) RETURNING id`,
          [key, resolved ? key : null, resolved ? 'resolved' : 'unresolved', resolved ? null : 'race test placeholder'])
        return r.rows[0].id
      }
      const placeholder = await account('placeholder', false)
      const targetA = await account('target-a', true)
      const targetB = await account('target-b', true)

      const resolve = (c: Client, target: string, actor: string) => c.query(
        `INSERT INTO investment_ledger.account_resolutions
           (placeholder_account_id, resolved_account_id, resolution_kind, actor, reason)
         VALUES ($1,$2,'resolve',$3,'concurrent race test')`, [placeholder, target, actor])

      await a.query('BEGIN'); await b.query('BEGIN')
      await resolve(a, targetA, 'writer-a')

      let settled = false
      const second = resolve(b, targetB, 'writer-b').then(
        r => { settled = true; return r }, e => { settled = true; throw e })

      // NON-VACUITY: the trigger's `SELECT ... FOR UPDATE` on the placeholder
      // account is the only thing stopping both writers from reading "no active
      // resolution" and both succeeding. If it were absent, writer-b would have
      // settled — successfully — well inside this window.
      await settleWindow()
      expect(settled, 'writer-b was not serialized behind writer-a').toBe(false)

      await a.query('COMMIT')
      const outcome = await second.then(() => 'ok', (e: Error) => e.message)
      expect(outcome, 'writer-b must not also create an active resolution').not.toBe('ok')
      expect(String(outcome)).toMatch(/already has an active resolution; supersede it explicitly/)
      await b.query('ROLLBACK')

      const active = await client.query<{ resolved_account_id: string }>(
        'SELECT resolved_account_id FROM investment_ledger.active_account_resolutions WHERE placeholder_account_id = $1',
        [placeholder])
      expect(active.rows.map(r => r.resolved_account_id)).toEqual([targetA])

      const effective = await client.query<{ effective_account_id: string }>(
        'SELECT effective_account_id FROM investment_ledger.effective_accounts WHERE account_id = $1', [placeholder])
      expect(effective.rows[0].effective_account_id).toBe(targetA)
    })
  }, 60_000)
})

describe('F8 a concurrent identical import resolves safely', () => {
  it('two simultaneous publications of the same bytes and series leave one batch', async () => {
    await twoWriters(async (a, b) => {
      const series = uniqueSeries('import-race')
      const small = { ...fixtureInspection(3), sha256: uniqueSha256(), findings: [] }
      const [ra, rb] = await Promise.all([
        publishArchive(a, small, fixtureRoot(), 'race.csv', series, testWorkspace()),
        publishArchive(b, small, fixtureRoot(), 'race.csv', series, testWorkspace()),
      ])
      const batches = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.import_batches
          WHERE series_key = $1 AND source_kind = 'archive_csv' AND source_sha256 = $2`, [series, small.sha256])
      expect(batches.rows[0].n, 'exactly one batch must survive the race').toBe(1)
      expect(ra.batchId).toBe(rb.batchId)
      expect([ra.exactRerun, rb.exactRerun].filter(Boolean), 'exactly one call is an idempotent re-run').toHaveLength(1)
      expect(ra.insertedTransactions + rb.insertedTransactions).toBe(3)

      const tx = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [ra.batchId])
      expect(tx.rows[0].n, 'no duplicated transactions').toBe(3)
    })
  }, 120_000)
})
