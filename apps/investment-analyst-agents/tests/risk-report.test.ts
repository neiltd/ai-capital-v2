import { describe, it, expect } from 'vitest'
import { formatReport } from '../src/risk/risk-report.js'
import type { RiskMetricsJSON } from '../src/risk/risk-runner.js'

const base: RiskMetricsJSON = {
  schemaVersion:       '1.1',
  generatedAt:         '2026-08-19',
  windowDays:          90,
  benchmark:           'VOO',
  fxRateUsdThb:        32.86,
  portfolioValueUSD:   14286,
  netWorthUSD:         91107,
  analyzedValueUSD:    14286,
  coverageOfNetWorth:  14286 / 91107,
  cashUSD:             44724,
  unpricedUSD:         32097,
  unpricedTickers:     ['PFM009', 'SCBCEH', 'GLDM'],
  portfolioVolatility: 0.1792,
  portfolioReturn:     0.05,
  sharpeRatio:         3.26,
  maxDrawdown:         -0.0422,
  oneDayVAR95:         142,
  portfolioBeta:       -0.13,
  perTicker: [
    { ticker: 'LLY', weight: 0.2749, weightOfNetWorth: 0.0431, volatility: 0.56, totalReturn: 0.2, beta: 0.9, correlation: 0.4 },
  ],
  summary:             'Portfolio value ~$14286 (analyzed)',
}

describe('formatReport', () => {
  it('shows net worth alongside the analyzed sleeve and the coverage fraction', () => {
    const md = formatReport(base)
    expect(md).toContain('91,107')
    expect(md).toContain('14,286')
    expect(md).toMatch(/15\.7%/)
  })

  it('lists what is excluded from the metrics', () => {
    const md = formatReport(base)
    expect(md).toContain('PFM009')
    expect(md).toMatch(/cash/i)
  })

  it('gives the per-ticker table a net-worth weight column, not just a sleeve weight', () => {
    const md = formatReport(base)
    expect(md).toMatch(/% of net worth/i)
    const row = md.split('\n').find(l => l.startsWith('| LLY'))
    expect(row).toBeDefined()
    expect(row).toContain('4.31%')   // of net worth
    expect(row).toContain('27.49%')  // of sleeve
  })

  it('degrades to sleeve-only wording when net worth is unavailable', () => {
    const md = formatReport({ ...base, netWorthUSD: null, coverageOfNetWorth: null })
    expect(md).toContain('14,286')
    expect(md).not.toMatch(/of net worth.*91,107/)
  })
})
