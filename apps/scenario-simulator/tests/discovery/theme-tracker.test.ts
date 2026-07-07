import { describe, it, expect } from 'vitest'
import {
  paperBookThemeValue,
  realPortfolioThemeValueUSD,
  formatThemeContext,
  THEME_CONCENTRATION_CAP,
} from '../../src/discovery/theme-tracker.js'
import type { DiscoveryPosition } from '../../src/discovery/types.js'
import type { Position } from '../../src/types.js'

function paperPos(overrides: Partial<DiscoveryPosition> = {}): DiscoveryPosition {
  return {
    ticker: 'NVDA', company: 'NVIDIA', shares: 10, avgCost: 100,
    currentPrice: 100, currentValue: 1000, unrealizedPnl: 0, score: 80,
    source: 'companies_table', rationale: 'test', openedAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z', benchmarkPriceAtOpen: null,
    ...overrides,
  }
}

function realPos(overrides: Partial<Position> = {}): Position {
  return {
    ticker: 'CRWD', company: 'CrowdStrike', shares: 5, avgCost: 200,
    currentPrice: 200, currentValue: 1000, unrealizedPnl: 0, updatedAt: '2026-07-01T00:00:00Z',
    assetClass: 'us_equity', currency: 'USD', priceSymbol: 'CRWD', strategy: 'tactical',
    ...overrides,
  }
}

describe('THEME_CONCENTRATION_CAP', () => {
  it('is 30%, matching correlation-runner.ts\'s concentration threshold', () => {
    expect(THEME_CONCENTRATION_CAP).toBe(0.30)
  })
})

describe('paperBookThemeValue', () => {
  it('sums cost basis (shares * avgCost) by theme', () => {
    const positions = [
      paperPos({ ticker: 'NVDA', shares: 10, avgCost: 100 }),
      paperPos({ ticker: 'AMD', shares: 5, avgCost: 200 }),
      paperPos({ ticker: 'UNH', shares: 2, avgCost: 300 }),
    ]
    const themesMap = { NVDA: 'ai-infrastructure', AMD: 'ai-infrastructure', UNH: 'healthcare' }
    const result = paperBookThemeValue(positions, themesMap)
    expect(result.get('ai-infrastructure')).toBeCloseTo(1000 + 1000) // 10*100 + 5*200
    expect(result.get('healthcare')).toBeCloseTo(600)
  })

  it('ignores tickers not in the theme map', () => {
    const positions = [paperPos({ ticker: 'UNKNOWN_TICKER', shares: 10, avgCost: 100 })]
    const result = paperBookThemeValue(positions, {})
    expect(result.size).toBe(0)
  })

  it('returns an empty map for an empty book', () => {
    expect(paperBookThemeValue([], {}).size).toBe(0)
  })
})

describe('realPortfolioThemeValueUSD', () => {
  it('sums USD value by theme and computes total in USD', () => {
    const positions = [
      realPos({ ticker: 'CRWD', currentValue: 1000, currency: 'USD' }),
      realPos({ ticker: 'NET', currentValue: 500, currency: 'USD' }),
      realPos({ ticker: 'AOT.BK', currentValue: 33000, currency: 'THB' }),
    ]
    const themesMap = { CRWD: 'cybersecurity', NET: 'cybersecurity' }
    const { byTheme, totalUsd } = realPortfolioThemeValueUSD(positions, themesMap, 33)
    expect(byTheme.get('cybersecurity')).toBeCloseTo(1500)
    // AOT.BK has no theme mapping, so it contributes to totalUsd but not byTheme
    expect(totalUsd).toBeCloseTo(1000 + 500 + 1000) // 33000/33 = 1000
    expect(byTheme.has('th_equity')).toBe(false)
  })

  it('falls back to raw currentValue when usdThb is null (no double-counting bug)', () => {
    const positions = [realPos({ ticker: 'AOT.BK', currentValue: 33000, currency: 'THB' })]
    const { totalUsd } = realPortfolioThemeValueUSD(positions, {}, null)
    expect(totalUsd).toBe(33000) // not converted, but at least doesn't crash
  })

  it('returns zero total for an empty portfolio', () => {
    const { totalUsd, byTheme } = realPortfolioThemeValueUSD([], {}, 33)
    expect(totalUsd).toBe(0)
    expect(byTheme.size).toBe(0)
  })
})

describe('formatThemeContext', () => {
  it('flags a theme at or above the cap in the paper book', () => {
    const paperBook = new Map([['ai-infrastructure', 3000]])
    const ctx = formatThemeContext(paperBook, 10000, { byTheme: new Map(), totalUsd: 0 })
    expect(ctx).toContain('ai-infrastructure: 30.0%')
    expect(ctx).toContain('AT CAP')
  })

  it('flags a concentrated real-portfolio theme', () => {
    const real = { byTheme: new Map([['cybersecurity', 4000]]), totalUsd: 10000 }
    const ctx = formatThemeContext(new Map(), 10000, real)
    expect(ctx).toContain('cybersecurity: 40.0%')
    expect(ctx).toContain('concentrated')
  })

  it('handles an empty paper book and unavailable real portfolio gracefully', () => {
    const ctx = formatThemeContext(new Map(), 10000, { byTheme: new Map(), totalUsd: 0 })
    expect(ctx).toContain('no open positions yet')
    expect(ctx).toContain('unavailable')
  })
})
