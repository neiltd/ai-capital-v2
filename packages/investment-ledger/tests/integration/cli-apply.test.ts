// F8: the changed-archive path, driven through the REAL command boundary and
// all the way into the database.
//
// Round 1 proved only that a changed archive REACHED the apply path, stopping at
// the DATABASE_URL guard; the linked batch and the reconciliation case were
// proven separately at library level and the two halves were never joined. This
// runs bin/import-archive.ts as a process against ai_capital_test and asserts
// what actually landed.
//
// COMMITS. A separate process cannot participate in this suite's rollback, so
// this file is one of the few that leave rows behind. It publishes ONE row per
// batch and two batches per run, into a series nothing else uses.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { COLUMNS } from '../../src/types.js'
import { PUBLISHABLE_BUY_ROWS } from '../fixtures/rows.js'
import { connectToTestDatabase, isDisposableTestDatabase, testDatabaseUrl, uniqueSeries } from './support.js'

const PKG = resolve(__dirname, '..', '..')
const CLI = join(PKG, 'bin', 'import-archive.ts')
const TSX = join(PKG, 'node_modules', '.bin', 'tsx')

let client: Client
beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A structurally valid one-row archive built from FABRICATED rows. */
function writeArchive(dir: string, name: string, rowIndex: number): { path: string; sha256: string } {
  const row = PUBLISHABLE_BUY_ROWS[rowIndex]
  const body = [COLUMNS.join(','), COLUMNS.map(column => csvField(row[column])).join(',')].join('\n') + '\n'
  const path = join(dir, name)
  writeFileSync(path, body)
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

function runCli(args: string[], withDatabase: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DATABASE_URL
  delete env.TEST_DATABASE_URL
  if (withDatabase) {
    // The ONLY database this suite may mutate. Proven by name below before use.
    env.DATABASE_URL = testDatabaseUrl()
    env.TEST_DATABASE_URL = testDatabaseUrl()
  }
  const r = spawnSync(TSX, [CLI, ...args], { encoding: 'utf-8', timeout: 180_000, env })
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` }
}

describe('F8 the CLI publishes a changed archive into the database', () => {
  it('creates a linked successor batch and an open reconciliation case', async () => {
    // Safety: prove the target before handing a URL to a subprocess.
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db')
    expect(isDisposableTestDatabase(rows[0].db), `refusing to hand a subprocess "${rows[0].db}"`).toBe(true)

    const series = uniqueSeries('cli-changed')
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-apply-'))
    try {
      const v1 = writeArchive(dir, 'v1.csv', 0)
      const v2 = writeArchive(dir, 'v2.csv', 1)
      expect(v1.sha256).not.toBe(v2.sha256)

      const first = runCli(['--csv', v1.path, '--apply', '--expect-sha256', v1.sha256, '--series', series], true)
      expect(first.code, first.err).toBe(0)
      const firstResult = JSON.parse(first.out.slice(first.out.lastIndexOf('{'), first.out.lastIndexOf('}') + 1))
      expect(firstResult).toMatchObject({ insertedTransactions: 1, exactRerun: false, priorBatchId: null, seriesKey: series })

      const second = runCli(['--csv', v2.path, '--apply', '--expect-sha256', v2.sha256, '--series', series], true)
      expect(second.code, second.err).toBe(0)
      const secondResult = JSON.parse(second.out.slice(second.out.lastIndexOf('{'), second.out.lastIndexOf('}') + 1))
      expect(secondResult).toMatchObject({
        insertedTransactions: 1, exactRerun: false, priorBatchId: firstResult.batchId, seriesKey: series,
      })

      // What actually landed, read back independently of the CLI's own report.
      const batches = await client.query<{ id: string; changed_from_batch: string | null; source_name: string }>(
        `SELECT id, changed_from_batch, source_name FROM investment_ledger.import_batches
          WHERE series_key = $1 ORDER BY published_at, id`, [series])
      expect(batches.rows).toHaveLength(2)
      expect(batches.rows[1].changed_from_batch).toBe(batches.rows[0].id)
      expect(batches.rows.map(b => b.source_name)).toEqual(['v1.csv', 'v2.csv'])

      const reconciliation = await client.query<{ case_type: string; event_type: string; evidence: Record<string, string> }>(
        `SELECT c.case_type, e.event_type, e.evidence
           FROM investment_ledger.reconciliation_cases c
           JOIN investment_ledger.reconciliation_case_events e ON e.case_id = c.id
          WHERE c.case_key = $1`,
        [`changed-archive:${series}:${firstResult.batchId}:${secondResult.batchId}`])
      expect(reconciliation.rows).toHaveLength(1)
      expect(reconciliation.rows[0].case_type).toBe('changed_archive')
      expect(reconciliation.rows[0].event_type).toBe('OPEN')
      expect(reconciliation.rows[0].evidence).toMatchObject({ seriesKey: series })

      // The projection followed: v2 is the head, v1's row has left.
      const head = await client.query<{ id: string }>(
        'SELECT id FROM investment_ledger.current_import_batches WHERE series_key = $1', [series])
      expect(head.rows.map(r => r.id)).toEqual([secondResult.batchId])
      const current = await client.query<{ batch_id: string; n: number }>(
        `SELECT r.batch_id, count(*)::int AS n
           FROM investment_ledger.current_transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = ANY($1::uuid[]) GROUP BY r.batch_id`,
        [[firstResult.batchId, secondResult.batchId]])
      expect(current.rows).toEqual([{ batch_id: secondResult.batchId, n: 1 }])

      // An exact rerun through the CLI adds nothing.
      const rerun = runCli(['--csv', v2.path, '--apply', '--expect-sha256', v2.sha256, '--series', series], true)
      expect(rerun.code, rerun.err).toBe(0)
      const rerunResult = JSON.parse(rerun.out.slice(rerun.out.lastIndexOf('{'), rerun.out.lastIndexOf('}') + 1))
      expect(rerunResult).toMatchObject({ insertedTransactions: 0, exactRerun: true, batchId: secondResult.batchId })
      const after = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.import_batches WHERE series_key = $1', [series])
      expect(after.rows[0].n).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 300_000)

  it('refuses to apply without a series even when a database is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-apply-'))
    try {
      const v = writeArchive(dir, 'noseries.csv', 2)
      const r = runCli(['--csv', v.path, '--apply', '--expect-sha256', v.sha256], true)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/--apply requires --series/)
      const orphan = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.import_batches WHERE source_sha256 = $1', [v.sha256])
      expect(orphan.rows[0].n, 'a refused apply must write nothing').toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)
})
