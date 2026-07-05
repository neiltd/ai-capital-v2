// SQLite-backed PortfolioStore. Methods wrap the synchronous better-sqlite3
// calls in `Promise.resolve(...)` so the async interface is preserved.

import Database from 'better-sqlite3'
import type { AssetClass, Currency } from '../types.js'
import type { PortfolioStore, Strategy } from './portfolio-store-types.js'

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some(r => r.name === column)
}

function inferDefaults(ticker: string): { assetClass: AssetClass; currency: Currency; priceSymbol: string } {
  // Backward-compatible defaults for any pre-migration rows. Existing rows are
  // assumed to be US equities priced in USD with priceSymbol == ticker.
  return { assetClass: 'us_equity', currency: 'USD', priceSymbol: ticker }
}

export function createSqlitePortfolioStore(dbPath: string): PortfolioStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      ticker         TEXT PRIMARY KEY,
      company        TEXT NOT NULL,
      shares         REAL NOT NULL,
      avg_cost       REAL NOT NULL,
      current_price  REAL NOT NULL DEFAULT 0,
      current_value  REAL NOT NULL DEFAULT 0,
      unrealized_pnl REAL NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL
    )
  `)

  // Safe migration: add multi-asset columns if missing.
  if (!hasColumn(db, 'positions', 'asset_class')) {
    db.exec(`ALTER TABLE positions ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'us_equity'`)
  }
  if (!hasColumn(db, 'positions', 'currency')) {
    db.exec(`ALTER TABLE positions ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'`)
  }
  if (!hasColumn(db, 'positions', 'price_symbol')) {
    db.exec(`ALTER TABLE positions ADD COLUMN price_symbol TEXT NOT NULL DEFAULT ''`)
    db.exec(`UPDATE positions SET price_symbol = ticker WHERE price_symbol = ''`)
  }
  if (!hasColumn(db, 'positions', 'strategy')) {
    db.exec(`ALTER TABLE positions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'tactical'`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL,
      ticker        TEXT NOT NULL,
      action        TEXT NOT NULL,
      shares        REAL NOT NULL,
      price         REAL NOT NULL,
      reason        TEXT NOT NULL DEFAULT '',
      current_price REAL NOT NULL DEFAULT 0,
      pct_change    REAL NOT NULL DEFAULT 0
    )
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO positions (
      ticker, company, shares, avg_cost,
      current_price, current_value, unrealized_pnl, updated_at,
      asset_class, currency, price_symbol, strategy
    )
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      company      = excluded.company,
      shares       = excluded.shares,
      avg_cost     = excluded.avg_cost,
      updated_at   = excluded.updated_at,
      asset_class  = excluded.asset_class,
      currency     = excluded.currency,
      price_symbol = excluded.price_symbol
      -- strategy intentionally NOT overwritten on upsert; use setStrategy()
  `)

  const setStrategyStmt = db.prepare(`UPDATE positions SET strategy = ? WHERE ticker = ?`)

  const priceByTickerStmt = db.prepare(`
    UPDATE positions SET
      current_price  = ?,
      current_value  = shares * ?,
      unrealized_pnl = (shares * ?) - (shares * avg_cost),
      updated_at     = ?
    WHERE ticker = ?
  `)

  const priceBySymbolStmt = db.prepare(`
    UPDATE positions SET
      current_price  = ?,
      current_value  = shares * ?,
      unrealized_pnl = (shares * ?) - (shares * avg_cost),
      updated_at     = ?
    WHERE price_symbol = ?
  `)

  const removeStmt = db.prepare('DELETE FROM positions WHERE ticker = ?')

  const logStmt = db.prepare(`
    INSERT INTO trade_log (date, ticker, action, shares, price, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const tradeCurrentPriceStmt = db.prepare(`
    UPDATE trade_log SET
      current_price = ?,
      pct_change    = ROUND(((? - price) / price) * 100, 2)
    WHERE ticker = ?
  `)

  return {
    async upsertPosition(ticker, company, shares, avgCost, options) {
      const defaults    = inferDefaults(ticker)
      const assetClass  = options?.assetClass  ?? defaults.assetClass
      const currency    = options?.currency    ?? defaults.currency
      const priceSymbol = options?.priceSymbol ?? defaults.priceSymbol
      const strategy    = options?.strategy    ?? 'tactical'
      upsertStmt.run(
        ticker, company, shares, avgCost,
        new Date().toISOString(),
        assetClass, currency, priceSymbol, strategy,
      )
    },

    async removePosition(ticker) {
      removeStmt.run(ticker)
    },

    async setStrategy(ticker, strategy) {
      setStrategyStmt.run(strategy, ticker.toUpperCase())
    },

    async updatePrices(prices) {
      const now = new Date().toISOString()
      const tickers = new Set(
        (db.prepare('SELECT ticker FROM positions').all() as Array<{ ticker: string }>).map(r => r.ticker),
      )
      for (const [key, price] of Object.entries(prices)) {
        if (tickers.has(key)) {
          priceByTickerStmt.run(price, price, price, now, key)
        } else {
          priceBySymbolStmt.run(price, price, price, now, key)
        }
      }
    },

    async getPositions() {
      type Row = {
        ticker: string; company: string; shares: number; avg_cost: number
        current_price: number; current_value: number; unrealized_pnl: number; updated_at: string
        asset_class: string; currency: string; price_symbol: string; strategy: string
      }
      return (db.prepare('SELECT * FROM positions ORDER BY ticker').all() as Row[]).map(r => ({
        ticker:        r.ticker,
        company:       r.company,
        shares:        r.shares,
        avgCost:       r.avg_cost,
        currentPrice:  r.current_price,
        currentValue:  r.current_value,
        unrealizedPnl: r.unrealized_pnl,
        updatedAt:     r.updated_at,
        assetClass:    (r.asset_class || 'us_equity') as AssetClass,
        currency:      (r.currency || 'USD') as Currency,
        priceSymbol:   r.price_symbol || r.ticker,
        strategy:      (r.strategy || 'tactical') as Strategy,
      }))
    },

    async logTrade(action, ticker, shares, price, reason) {
      const date = new Date().toISOString().slice(0, 10)
      logStmt.run(date, ticker.toUpperCase(), action, shares, price, reason)
    },

    async getTradeLog() {
      type Row = {
        id: number; date: string; ticker: string; action: string
        shares: number; price: number; reason: string
        current_price: number; pct_change: number
      }
      return (db.prepare('SELECT * FROM trade_log ORDER BY id DESC').all() as Row[]).map(r => ({
        id:           r.id,
        date:         r.date,
        ticker:       r.ticker,
        action:       r.action as 'buy' | 'sell',
        shares:       r.shares,
        price:        r.price,
        reason:       r.reason,
        currentPrice: r.current_price,
        pctChange:    r.pct_change,
      }))
    },

    async updateTradeCurrentPrices(prices) {
      for (const [ticker, price] of Object.entries(prices)) {
        tradeCurrentPriceStmt.run(price, price, ticker)
      }
    },

    async close() {
      db.close()
    },
  }
}
