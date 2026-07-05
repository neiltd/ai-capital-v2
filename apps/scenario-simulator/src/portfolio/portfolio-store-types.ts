// Shared types for portfolio store backends (SQLite + Postgres).
// Interface is async so callers don't need to know which backend is live.

import type { Position, AssetClass, Currency } from '../types.js'

export interface TradeEntry {
  id:           number
  date:         string
  ticker:       string
  action:       'buy' | 'sell'
  shares:       number
  price:        number
  reason:       string
  currentPrice: number
  pctChange:    number
}

export type Strategy = 'tactical' | 'dca' | 'tax_locked'

export interface UpsertPositionOptions {
  assetClass?:  AssetClass
  currency?:    Currency
  priceSymbol?: string
  strategy?:    Strategy
}

export interface PortfolioStore {
  upsertPosition(
    ticker:  string,
    company: string,
    shares:  number,
    avgCost: number,
    options?: UpsertPositionOptions,
  ): Promise<void>
  removePosition(ticker: string): Promise<void>
  setStrategy(ticker: string, strategy: Strategy): Promise<void>
  updatePrices(prices: Record<string, number>): Promise<void>
  getPositions(): Promise<Position[]>
  logTrade(action: 'buy' | 'sell', ticker: string, shares: number, price: number, reason: string): Promise<void>
  getTradeLog(): Promise<TradeEntry[]>
  updateTradeCurrentPrices(prices: Record<string, number>): Promise<void>
  close(): Promise<void>
}
