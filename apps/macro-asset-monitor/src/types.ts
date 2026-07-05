export type AssetCategory = 'rates' | 'dollar' | 'commodities' | 'volatility' | 'global-equity' | 'credit' | 'us-equity'
export type IndicatorCategory = 'inflation' | 'labour' | 'consumer' | 'credit'
export type Trend = 'rising' | 'falling' | 'stable'

export interface MarketAsset {
  ticker:       string
  label:        string
  category:     AssetCategory
  close:        number
  change1d:     number
  changePct1d:  number
  changePct5d:  number
  changePct30d: number
  trend:        Trend
}

export interface EconomicIndicator {
  seriesId:    string
  label:       string
  category:    IndicatorCategory
  value:       number
  releaseDate: string
  unit:        string
  trend:       Trend
  changeQoQ:   number | null   // % change from previous period
  changeYoY:   number | null   // % change from same period last year
}

export interface MacroJSON {
  exportedAt:           string
  asOf:                 string
  marketAssets:         MarketAsset[]
  economicIndicators:   EconomicIndicator[]
  liquidityIndicators:  LiquidityIndicator[]
}

export type LiquiditySignal = 'draining' | 'neutral' | 'injecting'

export interface LiquidityIndicator {
  seriesId:    string
  label:       string
  value:       number
  releaseDate: string
  unit:        string
  change4w:    number | null
  changeYoY:   number | null
  signal:      LiquiditySignal
}
