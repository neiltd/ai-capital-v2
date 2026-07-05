import { describe, it, expect } from 'vitest'
import { computeAwardTrend, normalizeAwards } from '../src/fetchers/awards-fetcher.js'

describe('computeAwardTrend', () => {
  it('returns rising when current > prior * 1.1', () => {
    expect(computeAwardTrend(1100, 1000)).toBe('rising')
  })

  it('returns falling when current < prior * 0.9', () => {
    expect(computeAwardTrend(800, 1000)).toBe('falling')
  })

  it('returns stable in the middle', () => {
    expect(computeAwardTrend(1000, 1000)).toBe('stable')
  })

  it('returns stable when prior is 0', () => {
    expect(computeAwardTrend(500, 0)).toBe('stable')
  })
})

describe('normalizeAwards', () => {
  it('truncates contracts to 120 chars', () => {
    const long = 'A'.repeat(200)
    const result = normalizeAwards([{ ticker: 'X', company: 'XCo', description: long, amount: 1000, agency: 'DoD' }])
    expect(result[0].contracts[0].length).toBeLessThanOrEqual(120)
  })

  it('groups multiple awards for same ticker', () => {
    const rows = [
      { ticker: 'NVDA', company: 'NVIDIA', description: 'GPU contract', amount: 1_000_000, agency: 'DoD' },
      { ticker: 'NVDA', company: 'NVIDIA', description: 'AI compute', amount: 2_000_000, agency: 'DARPA' },
    ]
    const result = normalizeAwards(rows)
    expect(result).toHaveLength(1)
    expect(result[0].total30d).toBe(3_000_000)
    expect(result[0].awardCount).toBe(2)
  })
})
