// Postgres-backed PortfolioStore. Talks to portfolio.positions + portfolio.trade_log.
// Schema lives in packages/db/migrations/001_portfolio.sql.

import { getPool } from '@common/db'
import type { AssetClass, Currency } from '../types.js'
import type { PortfolioStore, Strategy } from './portfolio-store-types.js'

function num(v: unknown): number {
  // pg returns NUMERIC as string by default to preserve precision.
  // For our domain (financial figures with ~2 decimal places) a JS number is fine.
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  return Number(v)
}

export function createPgPortfolioStore(): PortfolioStore {
  const pool = getPool()

  return {
    async upsertPosition(ticker, company, shares, avgCost, options) {
      const assetClass  = options?.assetClass  ?? 'us_equity'
      const currency    = options?.currency    ?? 'USD'
      const priceSymbol = options?.priceSymbol ?? ticker
      const strategy    = options?.strategy    ?? 'tactical'

      await pool.query(
        `INSERT INTO portfolio.positions
           (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl,
            updated_at, asset_class, currency, price_symbol, strategy)
         VALUES ($1,$2,$3,$4, 0,0,0, now(), $5,$6,$7,$8)
         ON CONFLICT (ticker) DO UPDATE SET
           company      = EXCLUDED.company,
           shares       = EXCLUDED.shares,
           avg_cost     = EXCLUDED.avg_cost,
           updated_at   = EXCLUDED.updated_at,
           asset_class  = EXCLUDED.asset_class,
           currency     = EXCLUDED.currency,
           price_symbol = EXCLUDED.price_symbol`,
        [ticker, company, shares, avgCost, assetClass, currency, priceSymbol, strategy],
      )
    },

    async removePosition(ticker) {
      await pool.query('DELETE FROM portfolio.positions WHERE ticker = $1', [ticker])
    },

    async setStrategy(ticker, strategy) {
      await pool.query(
        'UPDATE portfolio.positions SET strategy = $1 WHERE ticker = $2',
        [strategy, ticker.toUpperCase()],
      )
    },

    async updatePrices(prices) {
      // Same dispatch as SQLite: try ticker key first, fall back to price_symbol.
      const { rows } = await pool.query<{ ticker: string }>(
        'SELECT ticker FROM portfolio.positions',
      )
      const tickers = new Set(rows.map(r => r.ticker))

      for (const [key, price] of Object.entries(prices)) {
        if (tickers.has(key)) {
          await pool.query(
            `UPDATE portfolio.positions
                SET current_price  = $1,
                    current_value  = shares * $1,
                    unrealized_pnl = (shares * $1) - (shares * avg_cost),
                    updated_at     = now()
              WHERE ticker = $2`,
            [price, key],
          )
        } else {
          await pool.query(
            `UPDATE portfolio.positions
                SET current_price  = $1,
                    current_value  = shares * $1,
                    unrealized_pnl = (shares * $1) - (shares * avg_cost),
                    updated_at     = now()
              WHERE price_symbol = $2`,
            [price, key],
          )
        }
      }
    },

    async getPositions() {
      const { rows } = await pool.query<{
        ticker: string; company: string; shares: string; avg_cost: string
        current_price: string; current_value: string; unrealized_pnl: string; updated_at: Date
        asset_class: string; currency: string; price_symbol: string; strategy: string
      }>(
        'SELECT ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, ' +
        '       updated_at, asset_class, currency, price_symbol, strategy ' +
        '  FROM portfolio.positions ORDER BY ticker',
      )
      return rows.map(r => ({
        ticker:        r.ticker,
        company:       r.company,
        shares:        num(r.shares),
        avgCost:       num(r.avg_cost),
        currentPrice:  num(r.current_price),
        currentValue:  num(r.current_value),
        unrealizedPnl: num(r.unrealized_pnl),
        updatedAt:     r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        assetClass:    r.asset_class as AssetClass,
        currency:      r.currency    as Currency,
        priceSymbol:   r.price_symbol || r.ticker,
        strategy:      r.strategy    as Strategy,
      }))
    },

    async logTrade(action, ticker, shares, price, reason) {
      await pool.query(
        `INSERT INTO portfolio.trade_log (trade_date, ticker, action, shares, price, reason)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)`,
        [ticker.toUpperCase(), action, shares, price, reason],
      )
    },

    async getTradeLog() {
      const { rows } = await pool.query<{
        id: number; trade_date: Date; ticker: string; action: string
        shares: string; price: string; reason: string
        current_price: string; pct_change: string
      }>(
        'SELECT id, trade_date, ticker, action, shares, price, reason, current_price, pct_change ' +
        '  FROM portfolio.trade_log ORDER BY id DESC',
      )
      return rows.map(r => ({
        id:           r.id,
        date:         r.trade_date instanceof Date
                        ? r.trade_date.toISOString().slice(0, 10)
                        : String(r.trade_date),
        ticker:       r.ticker,
        action:       r.action as 'buy' | 'sell',
        shares:       num(r.shares),
        price:        num(r.price),
        reason:       r.reason,
        currentPrice: num(r.current_price),
        pctChange:    num(r.pct_change),
      }))
    },

    async updateTradeCurrentPrices(prices) {
      for (const [ticker, price] of Object.entries(prices)) {
        await pool.query(
          `UPDATE portfolio.trade_log
              SET current_price = $1,
                  pct_change    = ROUND(((($1)::numeric - price) / price) * 100, 2)
            WHERE ticker = $2`,
          [price, ticker],
        )
      }
    },

    async close() {
      // The shared pool is closed centrally by the CLI's main() (via closePool).
      // Per-store close is a no-op so the pool survives across multiple stores.
    },
  }
}
