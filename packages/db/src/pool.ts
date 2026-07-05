import pg from 'pg'

const { Pool } = pg
export type { Pool as PgPool } from 'pg'

let _pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (_pool) return _pool

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '@common/db: DATABASE_URL is not set. ' +
      'When unset, callers should use the SQLite fallback path instead of calling getPool().',
    )
  }

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
  return !!process.env.DATABASE_URL
}
