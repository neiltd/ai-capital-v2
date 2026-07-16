import { describe, it, expect, afterEach } from 'vitest'
import { fetchHistoricalClose, computeCalibration } from '../src/backtest/backtest-runner.js'
import type { BacktestRow } from '../src/backtest/backtest-runner.js'

function mockChartResponse(timestamps: number[], closes: (number | null)[], adjcloses: (number | null)[]) {
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: {
          quote:    [{ close: closes }],
          adjclose: [{ adjclose: adjcloses }],
        },
      }],
    },
  }
}

describe('fetchHistoricalClose', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('uses adjclose, not raw close, so a split inside the scored window does not show as a fake price cliff', async () => {
    // Simulates a ticker that did a 4:1 split shortly after this historical
    // date: Yahoo's raw `close` for this day is still pre-split-scale (400),
    // while `adjclose` has been retroactively divided by 4 (100) to stay
    // consistent with today's share count.
    const day = new Date('2026-01-05')
    const ts  = Math.floor(day.getTime() / 1000)
    global.fetch = (async () => ({
      ok:   true,
      json: async () => mockChartResponse([ts], [400], [100]),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('TEST', '2026-01-05')
    expect(price).toBe(100)
  })

  it('picks the trading day at or before the target date', async () => {
    const day1 = new Date('2026-01-05')
    const day2 = new Date('2026-01-06')
    const ts1  = Math.floor(day1.getTime() / 1000)
    const ts2  = Math.floor(day2.getTime() / 1000)
    global.fetch = (async () => ({
      ok:   true,
      json: async () => mockChartResponse([ts1, ts2], [400, 410], [100, 102.5]),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('TEST', '2026-01-06')
    expect(price).toBe(102.5)
  })

  it('returns null when the Yahoo response has no result', async () => {
    global.fetch = (async () => ({
      ok:   true,
      json: async () => ({ chart: { error: { code: 'Not Found' } } }),
    })) as unknown as typeof fetch

    const price = await fetchHistoricalClose('BOGUS', '2026-01-05')
    expect(price).toBeNull()
  })
})

function makeRow(overrides: Partial<BacktestRow>): BacktestRow {
  return {
    date:         '2026-01-01',
    ticker:       'TEST',
    action:       'hold',
    conviction:   'medium',
    scenarioType: 'base',
    pctChange:    0,
    priceAtCall:  100,
    priceLater:   100,
    windowDays:   7,
    return:       0,
    correct:      true,
    ...overrides,
  }
}

function dateAt(dayOfMonth: number): string {
  return `2026-01-${String(dayOfMonth).padStart(2, '0')}`
}

describe('computeCalibration - signal decay tracking', () => {
  it('flags a signal whose recent accuracy has dropped well below its all-time accuracy', () => {
    const rows: BacktestRow[] = []

    // 5 older dates (outside the most-recent-15-date window), all correct
    for (let d = 1; d <= 5; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: true }))
    }
    // 10 recent dates (inside the most-recent-15-date window), all incorrect
    for (let d = 6; d <= 15; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: false }))
    }
    // Filler dates so the dataset has 20 distinct dates total, putting the
    // most-recent-15-date window exactly on 2026-01-06..2026-01-20.
    for (let d = 16; d <= 20; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'low', windowDays: 7, correct: true }))
    }

    const calibration = computeCalibration(rows, rows.length)

    const trimDecay = calibration.decaying.find(e => e.signal === 'trim (30d)')
    expect(trimDecay).toBeDefined()
    expect(trimDecay!.allTimeCalls).toBe(15)
    expect(trimDecay!.allTimeAccuracy).toBeCloseTo(5 / 15, 5)
    expect(trimDecay!.recentCalls).toBe(10)
    expect(trimDecay!.recentAccuracy).toBe(0)

    const highDecay = calibration.decaying.find(e => e.signal === 'high (30d)')
    expect(highDecay).toBeDefined()
  })

  it('does not flag a signal with too few calls to be statistically meaningful', () => {
    const rows: BacktestRow[] = [
      makeRow({ date: dateAt(1),  action: 'buy', conviction: 'low', windowDays: 90, correct: true }),
      makeRow({ date: dateAt(18), action: 'buy', conviction: 'low', windowDays: 90, correct: false }),
      ...Array.from({ length: 18 }, (_, i) =>
        makeRow({ date: dateAt(i + 1), action: 'hold', conviction: 'medium', windowDays: 7, correct: true })),
    ]

    const calibration = computeCalibration(rows, rows.length)

    expect(calibration.decaying.find(e => e.signal === 'buy (90d)')).toBeUndefined()
    expect(calibration.decaying.find(e => e.signal === 'low (90d)')).toBeUndefined()
  })

  it('does not flag a signal whose recent accuracy is close to its all-time accuracy', () => {
    const rows: BacktestRow[] = []
    for (let d = 1; d <= 5; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'medium', windowDays: 7, correct: true }))
    }
    for (let d = 6; d <= 15; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'hold', conviction: 'medium', windowDays: 7, correct: d !== 6 }))
    }
    for (let d = 16; d <= 20; d++) {
      rows.push(makeRow({ date: dateAt(d), action: 'trim', conviction: 'high', windowDays: 30, correct: true }))
    }

    const calibration = computeCalibration(rows, rows.length)

    expect(calibration.decaying.find(e => e.signal === 'hold (7d)')).toBeUndefined()
    expect(calibration.decaying.find(e => e.signal === 'medium (7d)')).toBeUndefined()
  })
})
