// ThesisStore factory — picks SQLite or Postgres based on DATABASE_URL.

import { usePostgres } from '@common/db'
import { createSqliteThesisStore } from './thesis-store-sqlite.js'
import { createPgThesisStore }     from './thesis-store-pg.js'

export type { ThesisStore } from './thesis-store-types.js'

export function createThesisStore(sqliteFallbackPath: string) {
  if (usePostgres()) return createPgThesisStore()
  return createSqliteThesisStore(sqliteFallbackPath)
}
