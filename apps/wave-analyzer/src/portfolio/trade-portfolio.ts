import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { TradePosition } from '../types.js'

export interface TradePortfolio {
  openTrade(t: Omit<TradePosition, 'id' | 'closedAt' | 'closePrice' | 'pnl' | 'status'>): TradePosition
  closeTrade(id: string, closePrice: number): TradePosition
  getOpenPositions(): TradePosition[]
  getClosedPositions(limit?: number): TradePosition[]
  close(): void
}

export function createTradePortfolio(dbPath: string): TradePortfolio {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id          TEXT PRIMARY KEY,
      ticker      TEXT NOT NULL,
      signal      TEXT NOT NULL,
      entry_price REAL NOT NULL,
      stop_loss   REAL NOT NULL,
      target      REAL NOT NULL,
      shares      REAL NOT NULL,
      opened_at   TEXT NOT NULL,
      closed_at   TEXT,
      close_price REAL,
      pnl         REAL,
      status      TEXT NOT NULL DEFAULT 'open'
    )
  `)

  function rowToPosition(row: any): TradePosition {
    return {
      id: row.id, ticker: row.ticker,
      signal: row.signal as 'buy' | 'sell',
      entryPrice: row.entry_price, stopLoss: row.stop_loss,
      target: row.target, shares: row.shares,
      openedAt: row.opened_at,
      closedAt: row.closed_at ?? null,
      closePrice: row.close_price ?? null,
      pnl: row.pnl ?? null,
      status: row.status as 'open' | 'closed' | 'stopped',
    }
  }

  return {
    openTrade(t) {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO trades (id, ticker, signal, entry_price, stop_loss, target, shares, opened_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, t.ticker, t.signal, t.entryPrice, t.stopLoss, t.target, t.shares, t.openedAt)
      return rowToPosition(db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
    },

    closeTrade(id, closePrice) {
      const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as any
      if (!row) throw new Error(`Trade ${id} not found`)
      const pnl = row.signal === 'buy'
        ? (closePrice - row.entry_price) * row.shares
        : (row.entry_price - closePrice) * row.shares
      db.prepare(`
        UPDATE trades SET closed_at = ?, close_price = ?, pnl = ?, status = 'closed' WHERE id = ?
      `).run(new Date().toISOString(), closePrice, pnl, id)
      return rowToPosition(db.prepare('SELECT * FROM trades WHERE id = ?').get(id))
    },

    getOpenPositions() {
      return (db.prepare("SELECT * FROM trades WHERE status = 'open'").all() as any[]).map(rowToPosition)
    },

    getClosedPositions(limit = 20) {
      return (db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit) as any[]).map(rowToPosition)
    },

    close() { db.close() },
  }
}
