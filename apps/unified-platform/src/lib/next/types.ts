// View-model types for the redesigned screens.
//
// AssetClass/Currency/Strategy/Position are canonical — re-exported from
// @common/types rather than re-declared (see packages/common-types/src/portfolio.ts).
// Everything below has no producer-side envelope equivalent yet.
//
// Types marked `// GAP:` describe data the backend does not yet produce —
// see design-redesign-2026-07/backend-gaps.md for the build list.

export type { AssetClass, Currency, Strategy, Position } from '@common/types'

export interface Scenario {
  id: string
  scenarioType: 'best' | 'base' | 'disruption' | 'whatif'
  title: string
  narrative: string
  timeHorizon: string
  probability: number // 0..1
  triggers: string[]
}

export interface RecommendedAction {
  id: string
  ticker: string
  action: 'buy' | 'hold' | 'trim' | 'exit'
  conviction: 'high' | 'medium' | 'low'
  allocationChangePct: number
  rationale: string
  // GAP: fields below exist only in the briefing *markdown* today —
  // the briefing must also emit structured JSON (backend-gaps #1).
  convictionDowngraded?: boolean
  harvestableUsd?: number | null
  washSaleNote?: string | null
}

export interface RegimeSummary {
  regime: string
  confidence: 'high' | 'medium' | 'low'
  rationale: string
  keyIndicators: string[]
  date: string
}

/** From backtest/calibration.json — accuracy per action class. */
export interface Calibration {
  // GAP: needs a stable exported schema (currently internal to the briefing prompt)
  byAction: Record<string, { accuracy7d: number; accuracy30d: number; n: number }>
  note: string
}

export interface RiskJSON {
  generatedAt: string
  windowDays: number
  benchmark: string
  fxRateUsdThb: number
  portfolioValueUSD: number // priced/analyzed subset only — label it as such!
  portfolioVolatility: number
  portfolioReturn: number
  sharpeRatio: number
  maxDrawdown: number
  oneDayVAR95: number
  portfolioBeta: number
  perTicker: Array<{
    ticker: string
    weight: number
    volatility: number
    totalReturn: number
    beta: number
    correlation: number
  }>
}

export interface HarvestJSON {
  generatedAt: string
  fxRateUsdThb: number
  realizedYTD: { gainsUSD: number; lossesUSD: number; netTaxableUSD: number; trades: number }
  harvestOpportunities: Array<{
    ticker: string
    assetClass: import('@common/types').AssetClass
    currency: import('@common/types').Currency
    strategy: import('@common/types').Strategy
    unrealizedLoss: number
    unrealizedLossUSD: number
    shares: number
    taxJurisdiction: 'thai-exempt' | 'thai-taxable' | 'us-taxable' | 'tax-locked'
    harvestable: boolean
    washSaleRisk: boolean
    notes: string
  }>
  washSaleAlerts: Array<{
    ticker: string
    soldAt: string
    soldShares: number
    soldPrice: number
    doNotRebuyBefore: string
    daysRemaining: number
  }>
}

export interface DiscoveryHolding {
  ticker: string
  company: string
  shares: number
  avgCost: number
  currentPrice: number
  currentValue: number
  unrealizedPnl: number
  openedAt: string
  score: number
  rationale: string
  bearScore?: number // GAP: persisted for candidates, not for open paper positions
}

export interface DiscoveryCandidate {
  ticker: string
  company: string
  score: number
  bearScore?: number
  conviction?: string
  currentPrice: number
  recommendation: string
  rationale: string
  bearRationale?: string // GAP: adversarial reviewer's text is not persisted (#5)
}

export interface WorldEvent {
  eventId: string
  title: string
  summary: string
  severity: number // 1..5
  countries: string[]
  marketRelevance: number
  escalationPotential: number
  latestSeenAt: string
}

// GAP (#2): per-symbol daily close history + portfolio value series.
export interface SeriesPoint {
  date: string
  value: number
}
