// Shared integration-test support.
//
// THE PROBLEM THIS SOLVES. The round-1 suite wrote straight into
// ai_capital_test and never cleaned up, so 79 batches and 1413 transactions had
// accumulated. That is not merely untidy: the 621-row publication test silently
// stopped testing publication once its batch existed, because publishArchive
// took the exact-rerun branch and the test never asserted otherwise.
//
// THE MECHANISM. Every test that can runs inside a transaction that is ALWAYS
// rolled back, and publishArchive is called in 'nested' mode so it brackets its
// work with a SAVEPOINT instead of committing. Nothing is weakened to achieve
// this: the append-only triggers, the CHECK constraints and the deferred
// constraint triggers all fire exactly as they do in production, and the
// runtime role is granted no DELETE or TRUNCATE anywhere. Deferred triggers are
// fired inside the transaction with SET CONSTRAINTS ALL IMMEDIATE rather than by
// committing.
//
// The few tests that genuinely CANNOT roll back are the cross-connection races
// and the out-of-process CLI run: proving that a second writer is serialized
// behind the first requires the first to actually commit. Those are marked
// COMMITS and are deliberately tiny.

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { createClient, liveDatabaseNames } from '../../../db/src/pool.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivePath } from '../archive-env.js'
import { FIXTURE_ROWS } from '../fixtures/rows.js'
import type { ArchiveInspection, ArchiveRow } from '../../src/types.js'

// THE REAL ARCHIVE IS NOT A DEPENDENCY OF THIS SUITE.
//
// It is named only by INVESTMENT_ARCHIVE_CSV, resolved lazily, and reached from
// exactly one integration file — the explicitly named master-archive suite.
// Every other integration test publishes fabricated rows, so an ordinary run
// needs a database and nothing else. Round 1 hardcoded one operator's absolute
// path here, which put a private path into committed source AND made the whole
// suite unrunnable without a private financial record.
export function archiveCsv(): string { return archivePath() }
export function archiveRoot(): string { return dirname(archivePath()) }

/**
 * Document root for fabricated publications. `publishArchive` observes document
 * PATHS under this root (existsSync only — nothing is opened, parsed or
 * hashed), so pointing it at the committed fixtures keeps that branch live
 * without any private file being present.
 */
/**
 * The workspace and actor a fixture publication is attributed to.
 *
 * Seeded by the tenancy fixture; these tests are database-backed and are NOT
 * run in the source-only phase. Reading them from the environment keeps the
 * helper honest: there is no default workspace, and a suite that forgets to
 * seed one fails loudly rather than writing somewhere arbitrary.
 */
export function testWorkspace(): { workspaceId: string; actorPrincipalId: string } {
  const workspaceId = process.env.TEST_WORKSPACE_ID
  const actorPrincipalId = process.env.TEST_ACTOR_PRINCIPAL_ID
  if (!workspaceId || !actorPrincipalId) {
    throw new Error(
      'TEST_WORKSPACE_ID and TEST_ACTOR_PRINCIPAL_ID must be seeded before ' +
      'publishing fixtures; there is no default workspace.',
    )
  }
  return { workspaceId, actorPrincipalId }
}

export function fixtureRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'documents')
}

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required; integration tests never fall back to production')
  return url
}

/**
 * The only databases this suite may run against.
 *
 * An EXPLICIT ALLOWLIST, not a pattern. Round 4 briefly accepted any
 * `[a-z0-9_]+_test` name so the chain could be validated on a disposable
 * database with production-like ownership. That was too generous: these tests
 * COMMIT data and hand a database URL to an `--apply` subprocess, so a stray
 * `TEST_RUNTIME_DATABASE_URL` pointing at, say, `customer_test` would have been
 * written to. Two names is the whole set; adding a third is a deliberate edit
 * here, not a configuration knob.
 *
 * Live databases are refused FIRST and unconditionally, so a name cannot buy
 * its way in by being on the allowlist if LIVE_DATABASE_NAMES also declares it.
 */
const ALLOWED_TEST_DATABASES = ['ai_capital_test', 'ai_capital_ledger_round4_test'] as const

export function isDisposableTestDatabase(name: string): boolean {
  const lower = name.trim().toLowerCase()
  // Refused regardless of allowlist membership.
  if (liveDatabaseNames().includes(lower)) return false
  return (ALLOWED_TEST_DATABASES as readonly string[]).includes(lower)
}

/** Connect, and refuse to run a single statement unless this is a test database. */
export async function connectToTestDatabase(): Promise<Client> {
  const client = createClient(testDatabaseUrl())
  await client.connect()
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db')
  if (!isDisposableTestDatabase(rows[0].db)) {
    await client.end()
    throw new Error(
      `refusing to run integration tests against "${rows[0].db}": ` +
      'it is a protected database, or it is not one of the explicitly authorized ' +
      `disposable databases (${ALLOWED_TEST_DATABASES.join(', ')})`,
    )
  }
  return client
}

/**
 * A series nothing else has ever published into, so a test's result cannot be
 * satisfied — or contaminated — by residue from any earlier run.
 */
export function uniqueSeries(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'series'
  return `test-${slug}:${randomUUID()}`
}

/** 64 hex characters that no other run will produce. */
export function uniqueSha256(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64)
}

/** Run inside a transaction that is always rolled back. */
export async function withRollback<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    return await fn()
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
}

/**
 * Fire the DEFERRABLE INITIALLY DEFERRED correction triggers without committing.
 * This is what COMMIT would do, minus the durability the test does not want.
 */
export async function flushDeferredConstraints(client: Client): Promise<void> {
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
}

/**
 * Assert an operation is rejected, and leave the surrounding transaction
 * usable. A failed statement poisons a transaction, so each expected failure
 * gets its own savepoint.
 */
export async function expectRejected(
  client: Client, fn: () => Promise<unknown>, match: RegExp,
): Promise<Error> {
  const savepoint = `sp_${randomUUID().replace(/-/g, '')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let error: Error | null = null
  try { await fn() } catch (caught) { error = caught as Error }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  if (!error) throw new Error(`expected the operation to be rejected by /${match.source}/, but it succeeded`)
  if (!match.test(error.message)) {
    throw new Error(`expected rejection matching /${match.source}/, got: ${error.message}`)
  }
  return error
}

/**
 * A small, real-SHAPED inspection with a unique hash, built from FABRICATED
 * rows.
 *
 * This used to slice the operator's real archive, which forced every ordinary
 * integration test to depend on a private financial record for six well-formed
 * rows. The rows below are invented; only the broker names are real, because
 * the executable platform mapping keys on them.
 */
export function fixtureInspection(rowCount = 6, rows?: ArchiveRow[]): ArchiveInspection {
  if (!rows && rowCount > FIXTURE_ROWS.length) {
    throw new Error(
      `fixtureInspection(${rowCount}) exceeds the ${FIXTURE_ROWS.length} fabricated rows available; ` +
      'add a row to tests/fixtures/rows.ts rather than reaching for the real archive',
    )
  }
  const chosen = rows ?? FIXTURE_ROWS.slice(0, rowCount)
  return {
    sha256: uniqueSha256(),
    rows: chosen,
    logicalSourceFiles: new Set(chosen.map(row => row.source_file)).size,
    currencyRows: {}, cashFlowByCurrency: {}, missingAccounts: 0, missingNetAmounts: 0,
    exactDuplicateRows: 0, multiRowReferenceGroups: 0, negativePositionKeys: [],
    switchGroupKeys: [], incompleteSwitchGroups: [], findings: [],
  }
}

/** Counts of the tables a suite run must not permanently disturb. */
export const TRACKED_TABLES = [
  'investment_ledger.import_batches',
  'investment_ledger.raw_import_rows',
  'investment_ledger.transactions',
  'investment_ledger.transaction_amount_components',
  'investment_ledger.accounts',
  'investment_ledger.account_resolutions',
  'investment_ledger.instruments',
  'investment_ledger.logical_documents',
  'investment_ledger.document_file_variants',
  'investment_ledger.document_verification_events',
  'investment_ledger.transaction_groups',
  'investment_ledger.validation_findings',
  'investment_ledger.reconciliation_cases',
  'investment_ledger.reconciliation_case_events',
  'portfolio.positions',
  'portfolio.trade_log',
] as const

export async function tableCounts(client: Client): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of TRACKED_TABLES) {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
    counts[table] = rows[0].n
  }
  return counts
}
