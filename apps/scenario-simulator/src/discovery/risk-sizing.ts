// Risk-based position sizing for discovery (P2 — see
// docs/discovery-agent-enhancement-proposal-2026-07-06.md). Replaces
// score-band-only sizing (12%/8%/5% of deployable) with a stop-distance-based
// share count, so every buy has to answer "at what price am I wrong" and
// volatile/calm names carry comparable dollar risk instead of comparable
// notional. This is a NEW policy combining two patterns already proven
// elsewhere in this repo — stop/target derivation (wave-analyzer's
// action-generator.ts) and daily-return volatility math (risk-runner.ts's
// stdev(rets) * sqrt(252)) — it is not a port of existing "2%-risk" code,
// because no such code exists yet anywhere in the repo (verified).

/** Fraction of BUDGET risked per position if the stop is hit. */
export const RISK_PER_TRADE_PCT = 0.02

export const CONVICTION_MULTIPLIER: Record<'high' | 'medium' | 'low', number> = {
  high:   1.0,
  medium: 0.75,
  low:    0.5,
}

async function fetchDailyCloses(ticker: string, days: number): Promise<number[]> {
  const end   = Math.floor(Date.now() / 1000)
  const start = end - days * 86_400
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return []
    const data = await res.json() as {
      chart: { result?: Array<{ indicators: { quote: Array<{ close: (number | null)[] }> } }> }
    }
    const closes = data.chart.result?.[0]?.indicators.quote[0]?.close ?? []
    return closes.filter((c): c is number => c != null)
  } catch {
    return []
  }
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue
    out.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  return out
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
}

export interface RiskProfile {
  /** Daily volatility (stdev of daily returns) over the lookback window. Null if too little data. */
  sigmaDaily: number | null
  /** entry * (1 - 2 * sigmaDaily * sqrt(5)) — a ~1-week 2-sigma downside band. Null if sigmaDaily is null. */
  stopPrice: number | null
  /** entry + 2 * (entry - stopPrice) — a 2:1 reward:risk target. Null if stopPrice is null. */
  targetPrice: number | null
}

/**
 * Fetch ~60 trading days of closes and derive a volatility-based stop/target.
 * Returns nulls (not throws) on any fetch/data failure — callers must fall
 * back to score-band-only sizing rather than block a buy on a Yahoo hiccup.
 */
export async function computeRiskProfile(ticker: string, entryPrice: number, lookbackDays = 60): Promise<RiskProfile> {
  const closes = await fetchDailyCloses(ticker, lookbackDays)
  if (closes.length < 10) return { sigmaDaily: null, stopPrice: null, targetPrice: null }

  const sigmaDaily = stdev(dailyReturns(closes))
  if (sigmaDaily <= 0) return { sigmaDaily: null, stopPrice: null, targetPrice: null }

  const stopPrice = entryPrice * (1 - 2 * sigmaDaily * Math.sqrt(5))
  if (stopPrice <= 0 || stopPrice >= entryPrice) return { sigmaDaily, stopPrice: null, targetPrice: null }

  const targetPrice = entryPrice + 2 * (entryPrice - stopPrice)
  return { sigmaDaily, stopPrice, targetPrice }
}

/**
 * Risk-based notional: risk `riskBudget` dollars if the stop is hit, capped
 * by `scoreBandCap` (the pre-existing score-band dollar cap, so a very calm
 * name can't balloon to a huge notional just because its stop is tight), then
 * scaled by the post-bear conviction multiplier.
 */
export function computeRiskBasedAllocation(
  entryPrice: number,
  stopPrice: number,
  riskBudget: number,
  scoreBandCap: number,
  conviction: 'high' | 'medium' | 'low',
): number {
  const perShareRisk = entryPrice - stopPrice
  if (perShareRisk <= 0) return 0
  const sharesFromRisk = riskBudget / perShareRisk
  const notionalFromRisk = sharesFromRisk * entryPrice
  const capped = Math.min(notionalFromRisk, scoreBandCap)
  return capped * CONVICTION_MULTIPLIER[conviction]
}
