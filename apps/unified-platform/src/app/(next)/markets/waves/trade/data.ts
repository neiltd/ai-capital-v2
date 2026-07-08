// Loader for /markets/waves/trade. Reads wave-analyzer/data/trades.db
// directly (better-sqlite3, already a dependency — matches the src/lib/
// thesis-db.ts pattern), per docs/frontend-migration-plan-2026-07-07.md §6.
//
// trades.db has zero rows today — cli-trade.ts has never been run to open a
// paper trade, and there is no sizing-policy config anywhere in the CLI
// (--shares is still a manual flag, gap #21b). The design mockup's "trade
// budget / risk-per-trade %" banner and per-position sizing math have no
// real source to read from, so this loader does not fabricate them — ships
// as an honest "no trades yet" state, ready to populate the moment
// cli-trade.ts actually gets used.

import Database from 'better-sqlite3'
import path from 'path'

export interface TradeRow {
  id: string
  ticker: string
  signal: string
  entryPrice: number
  stopLoss: number
  target: number
  shares: number
  openedAt: string
  closedAt: string | null
  closePrice: number | null
  pnl: number | null
  status: 'open' | 'closed' | 'stopped'
}

interface TradeRaw {
  id: string
  ticker: string
  signal: string
  entry_price: number
  stop_loss: number
  target: number
  shares: number
  opened_at: string
  closed_at: string | null
  close_price: number | null
  pnl: number | null
  status: string
}

export interface TradeViewModel {
  open: TradeRow[]
  closed: TradeRow[]
}

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
}

export function loadTrade(): TradeViewModel | null {
  const dbPath = path.join(dataRoot(), 'wave-analyzer/data/trades.db')
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const rows = db
      .prepare('SELECT id, ticker, signal, entry_price, stop_loss, target, shares, opened_at, closed_at, close_price, pnl, status FROM trades ORDER BY opened_at DESC')
      .all() as TradeRaw[]

    const toRow = (r: TradeRaw): TradeRow => ({
      id: r.id,
      ticker: r.ticker,
      signal: r.signal,
      entryPrice: r.entry_price,
      stopLoss: r.stop_loss,
      target: r.target,
      shares: r.shares,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closePrice: r.close_price,
      pnl: r.pnl,
      status: r.status as TradeRow['status'],
    })

    return {
      open: rows.filter((r) => r.status === 'open').map(toRow),
      closed: rows.filter((r) => r.status !== 'open').map(toRow),
    }
  } finally {
    db.close()
  }
}
