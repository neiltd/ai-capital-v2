import { describe, it, expect } from 'vitest'
import type { TradeAction, TradePosition, WaveActionsJSON, WavePortfolioJSON } from '../src/types.js'

describe('trade types', () => {
  it('TradeAction has all required fields', () => {
    const a: TradeAction = {
      ticker: 'NVDA', label: 'NVIDIA',
      currentWave: '3', waveDirection: 'up',
      confidence: 72, signal: 'buy',
      entryZone: { low: 1080, high: 1120 },
      stopLoss: 980, target: 1380, riskReward: 2.5,
      narrative: 'Wave 3 in progress targeting 1.618 extension.',
      narrativeKey: 'NVDA:3:70',
      generatedAt: '2026-05-29T00:00:00.000Z',
    }
    expect(a.signal).toBe('buy')
    expect(a.riskReward).toBe(2.5)
  })

  it('WaveActionsJSON has exportedAt, asOf, actions', () => {
    const j: WaveActionsJSON = {
      exportedAt: '2026-05-29T00:00:00.000Z',
      asOf: '2026-05-29',
      actions: [],
    }
    expect(j.actions).toHaveLength(0)
  })

  it('TradePosition tracks open/closed state', () => {
    const p: TradePosition = {
      id: 'test-id', ticker: 'NVDA', signal: 'buy',
      entryPrice: 1100, stopLoss: 980, target: 1380, shares: 10,
      openedAt: '2026-05-29T00:00:00.000Z',
      closedAt: null, closePrice: null, pnl: null, status: 'open',
    }
    expect(p.status).toBe('open')
  })
})
