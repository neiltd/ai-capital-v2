import { describe, it, expect } from 'vitest'
import { formatReport } from '../src/backtest/backtest-report.js'
import type { BacktestRow, DecayEntry } from '../src/backtest/backtest-runner.js'

const sampleRows: BacktestRow[] = [
  {
    date: '2026-01-01', ticker: 'TEST', action: 'hold', conviction: 'medium',
    scenarioType: 'base', pctChange: 0, priceAtCall: 100, priceLater: 101,
    windowDays: 7, return: 1, correct: true,
  },
]

describe('formatReport - signal decay section', () => {
  it('omits the Signal Decay section when nothing is decaying', () => {
    const report = formatReport(sampleRows, 1, [], 15)
    expect(report).not.toContain('Signal Decay')
  })

  it('renders a Signal Decay table row for each flagged signal', () => {
    const decaying: DecayEntry[] = [
      { signal: 'trim (30d)', allTimeAccuracy: 0.75, recentAccuracy: 0.2, allTimeCalls: 12, recentCalls: 5 },
    ]
    const report = formatReport(sampleRows, 1, decaying, 15)
    expect(report).toContain('Signal Decay')
    expect(report).toContain('trim (30d)')
    expect(report).toContain('75.0%')
    expect(report).toContain('20.0%')
  })
})
