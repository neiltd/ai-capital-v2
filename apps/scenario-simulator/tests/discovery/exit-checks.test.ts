import { describe, it, expect } from 'vitest'
import {
  checkMechanicalExits, selectThesisCheckCandidates,
  TIME_STOP_DAYS, THESIS_CHECK_DOWN_PCT, THESIS_CHECK_HELD_DAYS,
} from '../../src/discovery/exit-checks.js'
import type { DiscoveryPosition } from '../../src/discovery/types.js'

function pos(overrides: Partial<DiscoveryPosition> = {}): DiscoveryPosition {
  return {
    ticker: 'NVDA', company: 'NVIDIA', shares: 10, avgCost: 100,
    currentPrice: 100, currentValue: 1000, unrealizedPnl: 0, score: 80,
    source: 'companies_table', rationale: 'test',
    openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    benchmarkPriceAtOpen: null, stopPrice: null, targetPrice: null, adjustedConviction: null,
    ...overrides,
  }
}

const NOW = new Date('2026-07-07T00:00:00Z')
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString()
}

describe('checkMechanicalExits', () => {
  it('flags a position whose current price is at or below its stop', () => {
    const positions = [pos({ ticker: 'NVDA', stopPrice: 90 })]
    const exits = checkMechanicalExits(positions, { NVDA: 89 }, NOW)
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ ticker: 'NVDA', reason: 'stop hit', exitPrice: 89 })
  })

  it('does not flag a position still above its stop', () => {
    const positions = [pos({ ticker: 'NVDA', stopPrice: 90 })]
    const exits = checkMechanicalExits(positions, { NVDA: 95 }, NOW)
    expect(exits).toHaveLength(0)
  })

  it(`flags a position held past ${TIME_STOP_DAYS} days regardless of price`, () => {
    const positions = [pos({ ticker: 'OLD', openedAt: daysAgo(TIME_STOP_DAYS + 1), stopPrice: null })]
    const exits = checkMechanicalExits(positions, { OLD: 150 }, NOW)
    expect(exits).toHaveLength(1)
    expect(exits[0].reason).toBe('time-stop')
  })

  it('does not flag a position held under the time-stop window', () => {
    const positions = [pos({ ticker: 'RECENT', openedAt: daysAgo(TIME_STOP_DAYS - 10) })]
    const exits = checkMechanicalExits(positions, { RECENT: 100 }, NOW)
    expect(exits).toHaveLength(0)
  })

  it('reports stop-hit rather than time-stop when both would apply', () => {
    const positions = [pos({ ticker: 'BOTH', openedAt: daysAgo(TIME_STOP_DAYS + 5), stopPrice: 90 })]
    const exits = checkMechanicalExits(positions, { BOTH: 80 }, NOW)
    expect(exits).toHaveLength(1)
    expect(exits[0].reason).toBe('stop hit')
  })

  it('skips positions with no current price available', () => {
    const positions = [pos({ ticker: 'NOPRICE', stopPrice: 90 })]
    const exits = checkMechanicalExits(positions, {}, NOW)
    expect(exits).toHaveLength(0)
  })

  it('skips positions with no stop set and within the time window', () => {
    const positions = [pos({ ticker: 'NOSTOP', stopPrice: null })]
    const exits = checkMechanicalExits(positions, { NOSTOP: 1 }, NOW)
    expect(exits).toHaveLength(0)
  })
})

describe('selectThesisCheckCandidates', () => {
  it(`selects a position down more than ${THESIS_CHECK_DOWN_PCT * 100}%`, () => {
    const positions = [pos({ ticker: 'DOWN', avgCost: 100 })]
    const candidates = selectThesisCheckCandidates(positions, { DOWN: 85 }, new Set(), NOW)
    expect(candidates.map(c => c.ticker)).toContain('DOWN')
  })

  it('does not select a position down less than the threshold', () => {
    const positions = [pos({ ticker: 'FLAT', avgCost: 100 })]
    const candidates = selectThesisCheckCandidates(positions, { FLAT: 95 }, new Set(), NOW)
    expect(candidates.map(c => c.ticker)).not.toContain('FLAT')
  })

  it(`selects a position held more than ${THESIS_CHECK_HELD_DAYS} days even if flat/up`, () => {
    const positions = [pos({ ticker: 'STALE', avgCost: 100, openedAt: daysAgo(THESIS_CHECK_HELD_DAYS + 1) })]
    const candidates = selectThesisCheckCandidates(positions, { STALE: 110 }, new Set(), NOW)
    expect(candidates.map(c => c.ticker)).toContain('STALE')
  })

  it('excludes tickers already exiting mechanically this run', () => {
    const positions = [pos({ ticker: 'ALREADY_EXITING', avgCost: 100 })]
    const candidates = selectThesisCheckCandidates(positions, { ALREADY_EXITING: 80 }, new Set(['ALREADY_EXITING']), NOW)
    expect(candidates).toHaveLength(0)
  })

  it('skips positions with no current price', () => {
    const positions = [pos({ ticker: 'NOPRICE', avgCost: 100, openedAt: daysAgo(200) })]
    const candidates = selectThesisCheckCandidates(positions, {}, new Set(), NOW)
    expect(candidates).toHaveLength(0)
  })
})
