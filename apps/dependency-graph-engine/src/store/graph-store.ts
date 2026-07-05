// GraphStore factory — picks SQLite or Postgres based on DATABASE_URL.

import { usePostgres } from '@common/db'
import { createSqliteGraphStore } from './graph-store-sqlite.js'
import { createPgGraphStore }     from './graph-store-pg.js'

export type { GraphStore } from './graph-store-types.js'

export function createGraphStore(sqliteFallbackPath: string) {
  if (usePostgres()) return createPgGraphStore()
  return createSqliteGraphStore(sqliteFallbackPath)
}
