import { describe, it, expect } from 'vitest'
import { computeSignal, computePrices, roundConfidence } from '../src/actions/action-generator.js'
import type { WavePivot } from '../src/types.js'

const mockPivots: WavePivot[] = [
  { label: '0', price: 800, date: '2026-01-01' },
  { label: '1', price: 1000, date: '2026-02-01' },
  { label: '2', price: 900, date: '2026-03-01' },
]

describe('computeSignal', () => {
  it('returns buy for up wave 3 with confidence >= 50', () => {
    expect(computeSignal('3', 'up', 72)).toBe('buy')
  })

  it('returns buy for up wave 5', () => {
    expect(computeSignal('5', 'up', 60)).toBe('buy')
  })

  it('returns sell for down wave 3', () => {
    expect(computeSignal('3', 'down', 65)).toBe('sell')
  })

  it('returns watch for corrective wave 2', () => {
    expect(computeSignal('2', 'up', 70)).toBe('watch')
  })

  it('returns no-signal when confidence < 50', () => {
    expect(computeSignal('3', 'up', 45)).toBe('no-signal')
  })

  it('returns no-signal when currentWave is null', () => {
    expect(computeSignal(null, 'up', 70)).toBe('no-signal')
  })
})

describe('computePrices', () => {
  it('computes entry zone as close ± 2%', () => {
    const result = computePrices('3', 'up', 1100, mockPivots)
    expect(result.entryZone?.low).toBeCloseTo(1078, 0)
    expect(result.entryZone?.high).toBeCloseTo(1122, 0)
  })

  it('computes stop loss from wave 2 pivot for up wave 3', () => {
    const result = computePrices('3', 'up', 1100, mockPivots)
    expect(result.stopLoss).toBe(900)
  })

  it('computes target as wave 2 low + wave 1 height * 1.618', () => {
    // Wave 1 height = 1000 - 800 = 200, target = 900 + 200*1.618 ≈ 1223.6
    const result = computePrices('3', 'up', 1100, mockPivots)
    expect(result.target).toBeCloseTo(1223.6, 0)
  })

  it('returns null prices when pivots insufficient', () => {
    const result = computePrices('3', 'up', 1100, [])
    expect(result.stopLoss).toBeNull()
    expect(result.target).toBeNull()
  })
})

describe('roundConfidence', () => {
  it('rounds 72 to 70', () => expect(roundConfidence(72)).toBe(70))
  it('rounds 75 to 75', () => expect(roundConfidence(75)).toBe(75))
  it('rounds 53 to 55', () => expect(roundConfidence(53)).toBe(55))
})
