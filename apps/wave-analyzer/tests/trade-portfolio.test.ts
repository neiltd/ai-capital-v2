import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTradePortfolio } from '../src/portfolio/trade-portfolio.js'

const DB_PATH = join(tmpdir(), `trade-test-${Date.now()}.db`)

afterEach(() => { rmSync(DB_PATH, { force: true }) })

describe('trade-portfolio', () => {
  it('opens and closes a trade with correct P&L', () => {
    const p = createTradePortfolio(DB_PATH)
    const trade = p.openTrade({
      ticker: 'NVDA', signal: 'buy',
      entryPrice: 1100, stopLoss: 980, target: 1380, shares: 10,
      openedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(trade.status).toBe('open')
    expect(trade.id).toMatch(/^[0-9a-f-]{36}$/)

    const closed = p.closeTrade(trade.id, 1350)
    expect(closed.status).toBe('closed')
    expect(closed.pnl).toBeCloseTo((1350 - 1100) * 10, 2)
    p.close()
  })

  it('returns open positions', () => {
    const p = createTradePortfolio(DB_PATH)
    p.openTrade({
      ticker: 'AAPL', signal: 'buy',
      entryPrice: 200, stopLoss: 185, target: 230, shares: 5,
      openedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(p.getOpenPositions()).toHaveLength(1)
    p.close()
  })

  it('computes P&L correctly for sell trades', () => {
    const p = createTradePortfolio(DB_PATH)
    const t = p.openTrade({
      ticker: 'MSFT', signal: 'sell',
      entryPrice: 450, stopLoss: 470, target: 410, shares: 8,
      openedAt: '2026-05-29T00:00:00.000Z',
    })
    p.closeTrade(t.id, 420)
    const closed = p.getClosedPositions()
    expect(closed).toHaveLength(1)
    expect(closed[0].pnl).toBeCloseTo((450 - 420) * 8, 2) // sell P&L is entry - close
    p.close()
  })
})
