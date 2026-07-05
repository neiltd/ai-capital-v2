import type { ISO3, Attribution, Ticker } from './shared.types'

export type AssetClass =
  | 'stock'        // individual equity
  | 'etf'          // exchange-traded fund
  | 'index'        // market index (S&P 500, SET, etc.)
  | 'commodity'    // physical commodity
  | 'currency'     // forex pair
  | 'bond'         // government or corporate bond
  | 'sector'       // sector as an asset concept (for exposure mapping)

export type ExchangeId =
  | 'NYSE' | 'NASDAQ' | 'AMEX'       // US
  | 'SET'                              // Thailand
  | 'LSE'                              // UK
  | 'TSE'                              // Japan
  | 'HKEX'                             // Hong Kong
  | 'SSE' | 'SZSE'                     // China
  | 'XETRA'                            // Germany
  | 'EURONEXT'                         // Europe
  | 'other'

// GICS (Global Industry Classification Standard) sectors
export type GICSSector =
  | 'Energy'
  | 'Materials'
  | 'Industrials'
  | 'Consumer Discretionary'
  | 'Consumer Staples'
  | 'Health Care'
  | 'Financials'
  | 'Information Technology'
  | 'Communication Services'
  | 'Utilities'
  | 'Real Estate'

export type CommodityCategory =
  | 'energy'       // oil, gas, coal
  | 'precious-metals'  // gold, silver, platinum
  | 'base-metals'  // copper, aluminum, nickel, zinc
  | 'agriculture'  // wheat, corn, soy, rice, coffee, sugar
  | 'critical-minerals' // lithium, cobalt, rare earths, uranium

export interface Asset {
  id: string              // e.g. "STOCK-NVDA-NASDAQ", "COMMODITY-OIL-BRENT", "INDEX-SPX"
  ticker?: Ticker         // "NVDA", "XOM", "GLD"
  name: string            // "NVIDIA Corporation", "Brent Crude Oil"
  assetClass: AssetClass
  exchange?: ExchangeId
  currency: string        // ISO 4217: "USD", "THB", "EUR"

  // Classification
  gicsSector?: GICSSector
  gicsIndustryGroup?: string
  gicsIndustry?: string
  commodityCategory?: CommodityCategory

  // Geography
  countryOfIncorporation?: ISO3
  countryOfPrimaryOperations?: ISO3
  primaryRevenueRegions?: ISO3[]   // where most revenue comes from

  // Size
  marketCapUsdBn?: number
  averageDailyVolumeUsdM?: number

  description: string
  geopoliticalSummary?: string   // 1-2 sentences on geopolitical exposure

  attribution: Attribution
}

export interface StockExchange {
  id: ExchangeId
  name: string
  country: ISO3
  currency: string
  regulatoryBody: string   // "SEC", "SET", "FCA", etc.
  filingStandard: 'SEC-10K' | 'SET-56-1' | 'IFRS-annual' | 'other'
  websiteUrl: string
  primarySectors: GICSSector[]
  notes?: string
}
