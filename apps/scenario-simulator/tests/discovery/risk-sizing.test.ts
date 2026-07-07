import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeRiskProfile, computeRiskBasedAllocation, CONVICTION_MULTIPLIER, RISK_PER_TRADE_PCT } from '../../src/discovery/risk-sizing.js'

beforeEach(() => { vi.resetAllMocks() })

function mockChart(closes: (number | null)[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: closes }] } }] } }),
  } as any)
}

describe('computeRiskProfile', () => {
  it('returns nulls when fewer than 10 closes are available', async () => {
    mockChart([100, 101, 102])
    const profile = await computeRiskProfile('TEST', 100)
    expect(profile.stopPrice).toBeNull()
    expect(profile.targetPrice).toBeNull()
  })

  it('derives a stop below entry and a target above entry for a volatile series', async () => {
    // Deliberately volatile daily closes so sigmaDaily > 0
    const closes = [100, 105, 98, 103, 96, 107, 94, 108, 92, 110, 90, 112]
    mockChart(closes)
    const profile = await computeRiskProfile('TEST', 100, 60)
    expect(profile.sigmaDaily).not.toBeNull()
    expect(profile.stopPrice).not.toBeNull()
    expect(profile.stopPrice!).toBeLessThan(100)
    expect(profile.targetPrice!).toBeGreaterThan(100)
    // target is exactly a 2:1 reward:risk from entry
    const risk = 100 - profile.stopPrice!
    expect(profile.targetPrice!).toBeCloseTo(100 + 2 * risk, 5)
  })

  it('returns nulls for a perfectly flat series (zero volatility)', async () => {
    const closes = Array(20).fill(100)
    mockChart(closes)
    const profile = await computeRiskProfile('TEST', 100, 60)
    expect(profile.stopPrice).toBeNull()
  })

  it('returns nulls on fetch failure rather than throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const profile = await computeRiskProfile('TEST', 100)
    expect(profile.stopPrice).toBeNull()
    expect(profile.targetPrice).toBeNull()
  })

  it('returns nulls on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as any)
    const profile = await computeRiskProfile('TEST', 100)
    expect(profile.stopPrice).toBeNull()
  })

  it('filters out null closes from a sparse series', async () => {
    const closes = [100, null, 105, null, 98, 103, 96, 107, 94, 108, 92, 110, 90]
    mockChart(closes)
    const profile = await computeRiskProfile('TEST', 100, 60)
    expect(profile.stopPrice).not.toBeNull()
  })
})

describe('computeRiskBasedAllocation', () => {
  it('sizes to risk exactly riskBudget dollars at the stop, before caps', () => {
    // entry 100, stop 90 => $10/share risk. riskBudget 400 => 40 shares => $4000 notional
    const allocation = computeRiskBasedAllocation(100, 90, 400, 100000, 'high')
    expect(allocation).toBeCloseTo(4000)
  })

  it('caps notional at the score-band cap even if risk math implies more', () => {
    // Very tight stop (low per-share risk) would imply a huge notional — capped.
    const allocation = computeRiskBasedAllocation(100, 99, 400, 2000, 'high')
    expect(allocation).toBeCloseTo(2000)
  })

  it('applies the conviction multiplier after capping', () => {
    const high   = computeRiskBasedAllocation(100, 90, 400, 100000, 'high')
    const medium = computeRiskBasedAllocation(100, 90, 400, 100000, 'medium')
    const low    = computeRiskBasedAllocation(100, 90, 400, 100000, 'low')
    expect(medium).toBeCloseTo(high * 0.75)
    expect(low).toBeCloseTo(high * 0.5)
  })

  it('returns 0 when stop is at or above entry (invalid risk)', () => {
    expect(computeRiskBasedAllocation(100, 100, 400, 100000, 'high')).toBe(0)
    expect(computeRiskBasedAllocation(100, 105, 400, 100000, 'high')).toBe(0)
  })
})

describe('constants', () => {
  it('risk per trade is 2% and conviction multipliers are 1.0/0.75/0.5', () => {
    expect(RISK_PER_TRADE_PCT).toBe(0.02)
    expect(CONVICTION_MULTIPLIER.high).toBe(1.0)
    expect(CONVICTION_MULTIPLIER.medium).toBe(0.75)
    expect(CONVICTION_MULTIPLIER.low).toBe(0.5)
  })
})
