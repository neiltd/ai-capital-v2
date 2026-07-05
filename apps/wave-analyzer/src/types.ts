export type WaveSource = 'macro' | 'watchlist' | 'screener'

export interface Candle {
  date: string   // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Pivot {
  date: string
  price: number
  type: 'high' | 'low'
}

export interface WavePivot {
  date: string
  price: number
  label: string  // "1" | "2" | "3" | "4" | "5" | "A" | "B" | "C"
}

export interface FibCheck {
  description: string
  actual: number
  expectedRange: string
  pass: boolean
}

export interface WaveAsset {
  ticker: string
  label: string
  source: WaveSource
  candles: Candle[]
  pivots: Pivot[]
  wavePivots: WavePivot[]
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number          // 0–100
  fibChecks: FibCheck[]
}

export interface WavesJSON {
  exportedAt: string
  asOf: string
  assets: WaveAsset[]
}

export type TradeSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface TradeAction {
  ticker:        string
  label:         string
  currentWave:   string | null
  waveDirection: 'up' | 'down' | null
  confidence:    number
  signal:        TradeSignal
  entryZone:     { low: number; high: number } | null
  stopLoss:      number | null
  target:        number | null
  riskReward:    number | null
  narrative:     string
  narrativeKey:  string
  generatedAt:   string
}

export interface WaveActionsJSON {
  exportedAt: string
  asOf:       string
  actions:    TradeAction[]
}

export interface TradePosition {
  id:          string
  ticker:      string
  signal:      'buy' | 'sell'
  entryPrice:  number
  stopLoss:    number
  target:      number
  shares:      number
  openedAt:    string
  closedAt:    string | null
  closePrice:  number | null
  pnl:         number | null
  status:      'open' | 'closed' | 'stopped'
}

export interface WavePortfolioJSON {
  exportedAt:      string
  openPositions:   TradePosition[]
  closedPositions: TradePosition[]
  totalPnl:        number
}
