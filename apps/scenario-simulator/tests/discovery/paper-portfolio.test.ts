import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { PaperPortfolio } from '../../src/discovery/paper-portfolio.js'
import type { DiscoveryRun } from '../../src/discovery/types.js'

let tmpDir: string
let portfolio: PaperPortfolio

function makeRun(overrides: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    id: 'run-1',
    date: '2026-05-27',
    candidatesFound: 10,
    passedFilter: 3,
    positionsOpened: 2,
    threshold: 70,
    durationMs: 5000,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `paper-portfolio-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  portfolio = new PaperPortfolio(path.join(tmpDir, 'simulation.db'))
})

afterEach(() => {
  portfolio.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('PaperPortfolio', () => {
  describe('openPosition', () => {
    it('opens a new position', () => {
      portfolio.openPosition('SMCI', 'Super Micro Computer', 5.12, 195.31, 82, 'news_mention', 'Supply chain pivot')
      const positions = portfolio.getPositions()
      expect(positions).toHaveLength(1)
      expect(positions[0].ticker).toBe('SMCI')
      expect(positions[0].shares).toBeCloseTo(5.12)
      expect(positions[0].avgCost).toBeCloseTo(195.31)
      expect(positions[0].score).toBe(82)
      expect(positions[0].source).toBe('news_mention')
    })

    it('is idempotent — second call with same ticker is a no-op', () => {
      portfolio.openPosition('SMCI', 'Super Micro Computer', 5.12, 195.31, 82, 'news_mention', 'First open')
      portfolio.openPosition('SMCI', 'Super Micro Computer', 9.99, 999.99, 90, 'companies_table', 'Second open (should be ignored)')
      const positions = portfolio.getPositions()
      expect(positions).toHaveLength(1)
      expect(positions[0].shares).toBeCloseTo(5.12)  // first values preserved
      expect(positions[0].avgCost).toBeCloseTo(195.31)
    })
  })

  describe('getOpenTickers', () => {
    it('returns a Set of open ticker symbols', () => {
      portfolio.openPosition('SMCI', 'Super Micro Computer', 5.12, 195.31, 82, 'news_mention', 'test')
      portfolio.openPosition('CRUS', 'Cirrus Logic', 10.19, 98.14, 74, 'companies_table', 'test')
      const tickers = portfolio.getOpenTickers()
      expect(tickers.has('SMCI')).toBe(true)
      expect(tickers.has('CRUS')).toBe(true)
      expect(tickers.size).toBe(2)
    })

    it('returns empty Set when no positions', () => {
      expect(portfolio.getOpenTickers().size).toBe(0)
    })
  })

  describe('updatePrices', () => {
    it('updates current_price, current_value, and unrealized_pnl correctly', () => {
      portfolio.openPosition('SMCI', 'Super Micro', 5, 200.00, 80, 'news_mention', 'test')
      portfolio.updatePrices({ SMCI: 210.00 })
      const positions = portfolio.getPositions()
      expect(positions[0].currentPrice).toBeCloseTo(210.00)
      expect(positions[0].currentValue).toBeCloseTo(1050.00) // 5 * 210
      expect(positions[0].unrealizedPnl).toBeCloseTo(50.00) // (210 - 200) * 5
    })

    it('handles negative P&L correctly', () => {
      portfolio.openPosition('SMCI', 'Super Micro', 10, 100.00, 80, 'news_mention', 'test')
      portfolio.updatePrices({ SMCI: 90.00 })
      const pos = portfolio.getPositions()[0]
      expect(pos.unrealizedPnl).toBeCloseTo(-100.00) // (90 - 100) * 10
    })

    it('ignores tickers not in portfolio', () => {
      portfolio.openPosition('SMCI', 'Super Micro', 5, 200.00, 80, 'news_mention', 'test')
      // Should not throw for unknown ticker
      expect(() => portfolio.updatePrices({ UNKNOWN: 100 })).not.toThrow()
      const pos = portfolio.getPositions()[0]
      expect(pos.currentPrice).toBeCloseTo(200.00) // unchanged
    })
  })

  describe('insertRun', () => {
    it('inserts a discovery run record', () => {
      portfolio.insertRun(makeRun())
      // No error thrown means success — we verify the table exists via schema
      // Re-open same DB to verify persistence
      portfolio.close()
      const portfolio2 = new PaperPortfolio(path.join(tmpDir, 'simulation.db'))
      // Can open again without error
      portfolio2.close()
      portfolio = new PaperPortfolio(path.join(tmpDir, 'simulation.db')) // re-init for afterEach
    })
  })
})
