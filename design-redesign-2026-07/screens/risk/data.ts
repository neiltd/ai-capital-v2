// Loader contract for /portfolio/risk.
// Source: investment-analyst-agents/risk/risk.json (real 2026-07-07 values
// below, post-FX-bug-fix) + correlation engine output.

import type { RiskJSON } from '../_shared/types'

export interface RiskViewModel extends RiskJSON {
  /** From the correlation engine. GAP #4: full pairwise matrix is only a
   *  markdown report today — needs correlation.json with the matrix +
   *  clusters so the heatmap and pair chips render from data. */
  topPairs: Array<{ a: string; b: string; corr: number }>
  clusters: Array<{ tickers: string[]; avgCorr: number; note: string }>
  /** Total NW for the honesty banner (priced subset ≠ net worth). */
  totalNetWorthUsd: number
}

export async function loadRisk(): Promise<RiskViewModel> {
  return {
    generatedAt: '2026-07-07',
    windowDays: 90,
    benchmark: 'VOO',
    fxRateUsdThb: 33.29,
    portfolioValueUSD: 26144.43,
    portfolioVolatility: 0.196,
    portfolioReturn: 0.167,
    sharpeRatio: 3.35,
    maxDrawdown: -0.054,
    oneDayVAR95: 473.63,
    portfolioBeta: 0.28,
    perTicker: [
      { ticker: 'AOT.BK', weight: 0.3691, volatility: 0.2612, totalReturn: 0.1789, beta: -0.0994, correlation: -0.0503 },
      { ticker: 'SCB.BK', weight: 0.1567, volatility: 0.2147, totalReturn: 0.0377, beta: -0.0085, correlation: -0.0053 },
      { ticker: 'LLY', weight: 0.14, volatility: 0.3765, totalReturn: 0.2588, beta: 0.0673, correlation: 0.0236 },
      { ticker: 'CRWD', weight: 0.0762, volatility: 0.5308, totalReturn: 0.8699, beta: 1.2596, correlation: 0.3135 },
      { ticker: 'GULF.BK', weight: 0.076, volatility: 0.2878, totalReturn: 0.0576, beta: -0.1963, correlation: -0.0901 },
      { ticker: 'PLTR', weight: 0.0744, volatility: 0.5847, totalReturn: -0.0584, beta: 1.3504, correlation: 0.3051 },
      { ticker: 'NET', weight: 0.0575, volatility: 0.8514, totalReturn: 0.1718, beta: 1.3895, correlation: 0.2156 },
      { ticker: 'GOLD_OZ', weight: 0.0502, volatility: 0.2341, totalReturn: -0.1224, beta: 0.9385, correlation: 0.5297 },
    ],
    topPairs: [
      { a: 'PLTR', b: 'CRWD', corr: 0.62 },
      { a: 'CRWD', b: 'NET', corr: 0.49 },
      { a: 'CRWD', b: 'GULF.BK', corr: -0.37 },
    ],
    clusters: [
      {
        tickers: ['PLTR', 'CRWD', 'NET'],
        avgCorr: 0.44,
        note: 'AI-gov/cyber direction — ~21% of priced portfolio moves together on NDAA / AI-capex headlines.',
      },
    ],
    totalNetWorthUsd: 74574,
  }
}
