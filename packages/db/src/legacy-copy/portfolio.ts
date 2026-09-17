// PORTFOLIO adapter: apps/scenario-simulator/data/portfolio.db
//   positions  -> portfolio.positions
//   trade_log  -> portfolio.trade_log   (source `date` -> target `trade_date`)
//
// An adapter owns NO transaction and NO pool. It is handed the one client the
// orchestrator opened, and it contains no BEGIN, COMMIT, ROLLBACK, SET ROLE,
// getPool, createPool or process exit - tests/legacy-copy-contract.test.ts
// asserts that statically for every adapter in this directory.

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import {
  assertSqliteSchema,
  openSourceSqlite,
  resolveUnderRoot,
} from '../legacy-copy.js'

/** The EXACT source column set. Drift in either direction fails closed. */
export const POSITIONS_COLUMNS = [
  'ticker', 'company', 'shares', 'avg_cost', 'current_price', 'current_value',
  'unrealized_pnl', 'updated_at', 'asset_class', 'currency', 'price_symbol', 'strategy',
] as const

export const TRADE_LOG_COLUMNS = [
  'id', 'date', 'ticker', 'action', 'shares', 'price', 'reason', 'current_price', 'pct_change',
] as const

interface PositionRow {
  ticker: string
  company: string
  shares: number
  avg_cost: number
  current_price: number
  current_value: number
  unrealized_pnl: number
  updated_at: string
  asset_class: string
  currency: string
  price_symbol: string
  strategy: string
}

interface TradeRow {
  id: number
  date: string
  ticker: string
  action: string
  shares: number
  price: number
  reason: string
  current_price: number
  pct_change: number
}

export async function copyPortfolio(client: CopyClient, ctx: CopyContext): Promise<TableResult[]> {
  const path = resolveUnderRoot(ctx.sourceRoot, 'apps/scenario-simulator/data/portfolio.db')
  const sqlite = await openSourceSqlite(path)
  try {
    assertSqliteSchema(sqlite, 'positions', [...POSITIONS_COLUMNS])
    assertSqliteSchema(sqlite, 'trade_log', [...TRADE_LOG_COLUMNS])

    // EXPLICIT COLUMNS AND AN EXPLICIT ORDER. `SELECT *` bound the read to
    // whatever order the source happened to declare; an ORDER BY on the primary
    // key makes the read reproducible, which is what lets two runs be compared.
    await client.query('TRUNCATE portfolio.positions')
    const positions = sqlite
      .prepare(
        `SELECT ${POSITIONS_COLUMNS.join(', ')} FROM positions ORDER BY ticker`,
      )
      .all() as PositionRow[]
    for (const p of positions) {
      await client.query(
        `INSERT INTO portfolio.positions
           (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl,
            updated_at, asset_class, currency, price_symbol, strategy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          p.ticker, p.company, p.shares, p.avg_cost,
          p.current_price, p.current_value, p.unrealized_pnl,
          p.updated_at, p.asset_class, p.currency, p.price_symbol, p.strategy,
        ],
      )
    }

    // RESTART IDENTITY resets portfolio.trade_log_id_seq. The target `id` is
    // generated, so source ids are deliberately not carried across; ordering by
    // the source id keeps the generated ids in source order.
    await client.query('TRUNCATE portfolio.trade_log RESTART IDENTITY')
    const trades = sqlite
      .prepare(`SELECT ${TRADE_LOG_COLUMNS.join(', ')} FROM trade_log ORDER BY id`)
      .all() as TradeRow[]
    for (const t of trades) {
      await client.query(
        `INSERT INTO portfolio.trade_log
           (trade_date, ticker, action, shares, price, reason, current_price, pct_change)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [t.date, t.ticker, t.action, t.shares, t.price, t.reason, t.current_price, t.pct_change],
      )
    }

    return [
      { table: 'portfolio.positions', rows: positions.length },
      { table: 'portfolio.trade_log', rows: trades.length },
    ]
  } finally {
    sqlite.close()
  }
}
