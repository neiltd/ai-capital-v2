import { describe, it, expect, afterEach } from 'vitest'
import { fetchHistoricalClose } from '../src/backtest/backtest-runner.js'

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
