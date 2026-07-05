import { describe, it, expect } from 'vitest'
import { computeZigzag } from '../src/analysis/zigzag.js'
import type { Candle } from '../src/types.js'

function makeCandle(date: string, price: number): Candle {
  return { date, open: price * 0.998, high: price * 1.005, low: price * 0.995, close: price, volume: 1_000_000 }
}

describe('computeZigzag', () => {
  it('returns empty array for fewer than 2 candles', () => {
    expect(computeZigzag([makeCandle('2024-01-01', 100)], 0.05)).toEqual([])
  })

  it('detects a high pivot when price drops more than threshold', () => {
    // Peak at 120, then drops 5.8% to 113 — triggers HIGH pivot
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 108),
      makeCandle('2024-01-03', 115),
      makeCandle('2024-01-04', 120),  // peak: high = 120 * 1.005 = 120.6
      makeCandle('2024-01-05', 117),
      makeCandle('2024-01-06', 113),  // close=113 < 120.6 * 0.95 = 114.57 → HIGH pivot recorded
      makeCandle('2024-01-07', 109),
    ]
    const pivots = computeZigzag(candles, 0.05)
    expect(pivots.some(p => p.type === 'high')).toBe(true)
  })

  it('does not trigger pivot for move below threshold', () => {
    // Only a 2% drop — below 5% threshold, no confirmed pivot
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 104),
      makeCandle('2024-01-03', 102),  // ~1.9% drop from 104*1.005 — below threshold
    ]
    const pivots = computeZigzag(candles, 0.05)
    // Only the trailing unconfirmed pivot, no confirmed reversal
    expect(pivots.length).toBe(1)
  })

  it('produces alternating high/low pivot types', () => {
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 108),
      makeCandle('2024-01-03', 116),
      makeCandle('2024-01-04', 120),  // peak
      makeCandle('2024-01-05', 113),  // drop triggers HIGH
      makeCandle('2024-01-06', 107),
      makeCandle('2024-01-07', 100),  // trough: low = 99.5
      makeCandle('2024-01-08', 103),
      makeCandle('2024-01-09', 106),  // close=106 > 99.5*1.05=104.5 → LOW pivot recorded
    ]
    const pivots = computeZigzag(candles, 0.05)
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i].type).not.toBe(pivots[i - 1].type)
    }
  })

  it('appends a trailing unconfirmed pivot at the last extreme index', () => {
    const candles = [
      makeCandle('2024-01-01', 100),
      makeCandle('2024-01-02', 110),
      makeCandle('2024-01-03', 120),
    ]
    const pivots = computeZigzag(candles, 0.05)
    expect(pivots.length).toBe(1)
    expect(pivots[0].date).toBe('2024-01-03')
  })
})
