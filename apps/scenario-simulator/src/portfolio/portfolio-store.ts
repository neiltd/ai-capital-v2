// PortfolioStore factory — picks SQLite or Postgres based on DATABASE_URL.
// Both backends ship the same async interface (see portfolio-store-types.ts).

import { usePostgres } from '@common/db'
import { createSqlitePortfolioStore } from './portfolio-store-sqlite.js'
import { createPgPortfolioStore }     from './portfolio-store-pg.js'

export type { PortfolioStore, Strategy, TradeEntry, UpsertPositionOptions } from './portfolio-store-types.js'

/**
 * Resolves a portfolio store backend.
 * - DATABASE_URL set  → Postgres (portfolio.* schema, see packages/db/migrations)
 * - Otherwise         → SQLite (legacy; the path is honoured for backward-compat)
 */
export function createPortfolioStore(sqliteFallbackPath: string) {
  if (usePostgres()) return createPgPortfolioStore()
  return createSqlitePortfolioStore(sqliteFallbackPath)
}
