export type AssetCategory = 'rates' | 'dollar' | 'commodities' | 'volatility' | 'global-equity' | 'credit' | 'us-equity' | 'sector'
export type IndicatorCategory = 'inflation' | 'labour' | 'consumer' | 'credit' | 'fx'
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
  region:      'US' | 'TH'   // which economy this indicator describes (default US)
  value:       number
  releaseDate: string
  unit:        string
  trend:       Trend
  changeQoQ:   number | null   // % change from previous period
  changeYoY:   number | null   // % change from same period last year
}

export type CarryUnwindStatus = 'calm' | 'watch' | 'tripwire'

export interface CarryUnwindSignal {
  status:       CarryUnwindStatus
  usdJpy:       number | null   // USD/JPY close
  usdJpyMove1d: number | null   // absolute yen move on the day
  vix:          number | null   // VIX level
  nikkeiPct1d:  number | null   // Nikkei daily % change (risk-off confirmation)
  reasons:      string[]
}

export interface MacroJSON {
  exportedAt:           string
  asOf:                 string
  marketAssets:         MarketAsset[]
  economicIndicators:   EconomicIndicator[]
  liquidityIndicators:  LiquidityIndicator[]
  carryUnwindWatch:     CarryUnwindSignal   // yen carry-trade unwind trip-wire
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
