import pg from 'pg'

const { Pool } = pg
export type { Pool as PgPool } from 'pg'

let _pool: pg.Pool | null = null


// ── Live-database guard ───────────────────────────────────────────────────
//
// WHY THIS EXISTS. On 2026-08-25 a full `pnpm -r test` run with DATABASE_URL
// exported wrote test fixtures into the REAL portfolio: a fabricated NVDA
// position (100 sh @ $68.50) landed in portfolio.positions, plus rows in
// capital.fetch_log and capital.pending_manual_input. Tonight's briefing would
// have reported a $9,200 holding that does not exist, on a real-money book.
//
// The root cause is environment precedence: `usePostgres()` is just
// `!!process.env.DATABASE_URL`, and six store factories branch on it — so a
// test handing `createPortfolioStore('/tmp/fixture.db')` an explicit fixture
// path silently got Postgres instead, because the developer's shell happened to
// have the variable set. CLAUDE.md actively encourages exporting it.
//
// The first line of defence is the shared vitest setup (testing/vitest-db-isolation.ts)
// which clears DATABASE_URL so every store takes its file path. THIS is the
// backstop for when that is bypassed — a test that sets the variable itself, a
// package whose config forgot the setup file, a future runner. It fails loudly
// rather than silently mutating the book.
//
// Tests that legitimately need Postgres set TEST_DATABASE_URL and point it at a
// throwaway database (ai_capital_test).

/** Databases that must never be touched from a test process. */
function liveDatabaseNames(): string[] {
  const configured = process.env.LIVE_DATABASE_NAMES
  return (configured ? configured.split(',') : ['ai_capital'])
    .map(n => n.trim().toLowerCase())
    .filter(Boolean)
}

function databaseNameOf(connectionString: string): string | null {
  try {
    // pathname is '/ai_capital'
    return new URL(connectionString).pathname.replace(/^\//, '').toLowerCase() || null
  } catch {
    return null
  }
}

/** True when running inside vitest. Vitest sets this itself; we never do. */
export function inTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.VITEST === '1'
}

/**
 * Refuse to hand a test process a connection to a live database.
 * Exported so tests can assert the guard itself works.
 */
export function assertNotLiveDatabase(connectionString: string): void {
  if (!inTestRuntime()) return
  const db = databaseNameOf(connectionString)
  if (db && liveDatabaseNames().includes(db)) {
    throw new Error(
      `@common/db: refusing to connect a TEST process to the live database "${db}". ` +
      'This guard exists because a test run once wrote fixture rows into the real ' +
      'portfolio. Point TEST_DATABASE_URL at a throwaway database (e.g. ai_capital_test), ' +
      'or let the shared vitest setup clear DATABASE_URL so the SQLite path is used.',
    )
  }
}

export function getPool(): pg.Pool {
  if (_pool) return _pool

  // In a test process, an explicitly-configured test database wins over
  // whatever the developer's shell happens to export.
  const url = (inTestRuntime() && process.env.TEST_DATABASE_URL) || process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '@common/db: DATABASE_URL is not set. ' +
      'When unset, callers should use the SQLite fallback path instead of calling getPool().',
    )
  }

  assertNotLiveDatabase(url)

  _pool = new Pool({
    connectionString:        url,
    // Single connection for CLI use; for server processes a higher max is fine.
    max:                     Number(process.env.PG_POOL_MAX ?? '5'),
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
  })

  _pool.on('error', err => {
    console.error('[@common/db] unexpected pool error:', err.message)
  })

  return _pool
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

/** True if DATABASE_URL is set — callers use this to pick Postgres vs SQLite. */
export function usePostgres(): boolean {
  // Mirrors getPool's precedence so a store's backend choice can never disagree
  // with what getPool would actually connect to.
  if (inTestRuntime()) return !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  return !!process.env.DATABASE_URL
}
