import { describe, it, expect } from 'vitest'
import { computeCalibration, formatCalibrationBlock, scoreBand, MIN_N_FOR_VERDICT } from '../../src/discovery/calibration.js'
import type { DiscoveryClosedPosition, DiscoveryPosition } from '../../src/discovery/types.js'

function closedPos(overrides: Partial<DiscoveryClosedPosition> = {}): DiscoveryClosedPosition {
  return {
    ticker: 'NVDA', company: 'NVIDIA', shares: 10, avgCost: 100, exitPrice: 110,
    realizedPnl: 100, score: 85, source: 'companies_table', rationale: 'test',
    exitReason: 'stop hit', openedAt: '2026-06-01T00:00:00Z', closedAt: '2026-06-15T00:00:00Z',
    benchmarkPriceAtOpen: 500, benchmarkPriceAtClose: 510,
    stopPrice: 90, targetPrice: 120, adjustedConviction: 'high',
    ...overrides,
  }
}

function openPos(overrides: Partial<DiscoveryPosition> = {}): DiscoveryPosition {
  return {
    ticker: 'AMD', company: 'AMD', shares: 5, avgCost: 100, currentPrice: 105,
    currentValue: 525, unrealizedPnl: 25, score: 85, source: 'companies_table',
    rationale: 'test', openedAt: '2026-06-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    benchmarkPriceAtOpen: 500, stopPrice: 90, targetPrice: 120, adjustedConviction: 'medium',
    ...overrides,
  }
}

describe('scoreBand', () => {
  it('classifies scores into 90+/80-89/70-79', () => {
    expect(scoreBand(95)).toBe('90+')
    expect(scoreBand(90)).toBe('90+')
    expect(scoreBand(85)).toBe('80-89')
    expect(scoreBand(80)).toBe('80-89')
    expect(scoreBand(75)).toBe('70-79')
    expect(scoreBand(70)).toBe('70-79')
  })
})

describe('computeCalibration', () => {
  it('computes win rate and avg return for closed positions in a band', () => {
    const closed = [
      closedPos({ ticker: 'A', score: 85, avgCost: 100, exitPrice: 110 }), // +10%, win
      closedPos({ ticker: 'B', score: 82, avgCost: 100, exitPrice: 90 }),  // -10%, loss
    ]
    const cal = computeCalibration(closed, [], null)
    expect(cal.byScoreBand['80-89'].n).toBe(2)
    expect(cal.byScoreBand['80-89'].winRate).toBeCloseTo(0.5)
    expect(cal.byScoreBand['80-89'].avgReturnPct).toBeCloseTo(0) // +10 and -10 average to 0
  })

  it('computes avg return vs SPY when both benchmark prices are present', () => {
    // Position: +10% return. SPY: 500->510 = +2%. vs SPY = +8%.
    const closed = [closedPos({ score: 85, avgCost: 100, exitPrice: 110, benchmarkPriceAtOpen: 500, benchmarkPriceAtClose: 510 })]
    const cal = computeCalibration(closed, [], null)
    expect(cal.byScoreBand['80-89'].avgReturnVsSpyPct).toBeCloseTo(8, 1)
  })

  it('returns null vsSpy when benchmark prices are missing', () => {
    const closed = [closedPos({ score: 85, benchmarkPriceAtOpen: null, benchmarkPriceAtClose: null })]
    const cal = computeCalibration(closed, [], null)
    expect(cal.byScoreBand['80-89'].avgReturnVsSpyPct).toBeNull()
  })

  it('returns n=0 stats for an empty band', () => {
    const cal = computeCalibration([], [], null)
    expect(cal.byScoreBand['90+']).toEqual({ n: 0, winRate: null, avgReturnPct: null, avgReturnVsSpyPct: null })
  })

  it('breaks down by adjustedConviction, excluding positions with no conviction recorded', () => {
    const closed = [
      closedPos({ ticker: 'A', adjustedConviction: 'high', avgCost: 100, exitPrice: 120 }),
      closedPos({ ticker: 'B', adjustedConviction: 'medium', avgCost: 100, exitPrice: 105 }),
      closedPos({ ticker: 'C', adjustedConviction: null, avgCost: 100, exitPrice: 200 }), // excluded
    ]
    const cal = computeCalibration(closed, [], null)
    expect(cal.byConviction.high.n).toBe(1)
    expect(cal.byConviction.medium.n).toBe(1)
    expect(cal.byConviction.low.n).toBe(0)
    // C is not double counted anywhere in byConviction
    const totalConvictionN = cal.byConviction.high.n + cal.byConviction.medium.n + cal.byConviction.low.n
    expect(totalConvictionN).toBe(2)
  })

  it('computes provisional (unrealized) stats for open positions separately from closed', () => {
    const open = [openPos({ score: 85, avgCost: 100, currentPrice: 110, benchmarkPriceAtOpen: 500 })]
    const cal = computeCalibration([], open, 520) // SPY now at 520 (+4% from 500)
    expect(cal.provisionalByScoreBand['80-89'].n).toBe(1)
    expect(cal.provisionalByScoreBand['80-89'].avgUnrealizedReturnPct).toBeCloseTo(10) // (110-100)/100
    expect(cal.provisionalByScoreBand['80-89'].avgUnrealizedVsSpyPct).toBeCloseTo(6, 1) // 10% - 4%
    // Open positions never appear in the closed byScoreBand
    expect(cal.byScoreBand['80-89'].n).toBe(0)
  })

  it('omits vs-SPY for provisional stats when currentSpyPrice is null', () => {
    const open = [openPos({ score: 85 })]
    const cal = computeCalibration([], open, null)
    expect(cal.provisionalByScoreBand['80-89'].avgUnrealizedVsSpyPct).toBeNull()
    expect(cal.provisionalByScoreBand['80-89'].avgUnrealizedReturnPct).not.toBeNull()
  })
})

describe('formatCalibrationBlock', () => {
  it('renders "insufficient data" for a band under MIN_N_FOR_VERDICT', () => {
    const closed = [closedPos({ score: 85 })] // n=1, below MIN_N_FOR_VERDICT
    const cal = computeCalibration(closed, [], null)
    const block = formatCalibrationBlock(cal)
    expect(block).toContain('insufficient data')
    expect(block).toContain('80-89')
  })

  it('renders real stats for a band at or above MIN_N_FOR_VERDICT', () => {
    const closed = Array.from({ length: MIN_N_FOR_VERDICT }, (_, i) =>
      closedPos({ ticker: `T${i}`, score: 85, avgCost: 100, exitPrice: 110 }))
    const cal = computeCalibration(closed, [], null)
    const block = formatCalibrationBlock(cal)
    expect(block).not.toContain('80-89: n=')
    expect(block).toContain('win rate 100%')
  })

  it('states plainly when no band has enough data for a verdict', () => {
    const cal = computeCalibration([], [], null)
    const block = formatCalibrationBlock(cal)
    expect(block).toContain('Not enough closed trades yet')
  })

  it('labels provisional (open-position) stats as provisional, not a verdict', () => {
    const open = [openPos({ score: 85 })]
    const cal = computeCalibration([], open, 520)
    const block = formatCalibrationBlock(cal)
    expect(block).toContain('provisional')
    expect(block).toContain('do not treat as a verdict')
  })
})
