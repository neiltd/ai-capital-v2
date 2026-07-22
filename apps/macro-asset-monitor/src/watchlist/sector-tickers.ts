import type { AssetCategory } from '../types.js'

export interface WatchlistTickerConfig {
  ticker:   string
  label:    string
  category: AssetCategory
}

// The 11 SPDR Select Sector ETFs (full S&P 500 sector breakdown) plus SMH as
// the closest direct proxy for AI/semiconductor-specific exposure. Distinct
// from YAHOO_ASSETS in yahoo-fetcher.ts, which tracks broad indices/macro
// assets, not sector-level detail -- this list exists to answer "is money
// rotating between sectors" on demand, not to feed the daily pipeline.
export const SECTOR_WATCHLIST: WatchlistTickerConfig[] = [
  { ticker: 'SMH',  label: 'Semiconductors (AI proxy)', category: 'sector' },
  { ticker: 'XLK',  label: 'Technology',                category: 'sector' },
  { ticker: 'XLC',  label: 'Communication Services',    category: 'sector' },
  { ticker: 'XLY',  label: 'Consumer Discretionary',    category: 'sector' },
  { ticker: 'XLF',  label: 'Financials',                category: 'sector' },
  { ticker: 'XLI',  label: 'Industrials',               category: 'sector' },
  { ticker: 'XLE',  label: 'Energy',                    category: 'sector' },
  { ticker: 'XLB',  label: 'Materials',                 category: 'sector' },
  { ticker: 'XLV',  label: 'Healthcare',                category: 'sector' },
  { ticker: 'XLP',  label: 'Consumer Staples',          category: 'sector' },
  { ticker: 'XLU',  label: 'Utilities',                 category: 'sector' },
  { ticker: 'XLRE', label: 'Real Estate',               category: 'sector' },
]
