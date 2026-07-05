import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchOHLCV } from '../src/fetchers/ohlcv-fetcher.js'

const SAMPLE_RESPONSE = {
  chart: {
    result: [{
      timestamp: [1704067200, 1704153600, 1704240000],
      indicators: {
        quote: [{
          open:   [190.0, 192.0, null],
          high:   [195.0, 194.0, null],
          low:    [189.0, 191.0, null],
          close:  [193.0, 193.5, null],
          volume: [50_000_000, 48_000_000, null],
        }]
      }
    }]
  }
}

describe('fetchOHLCV', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('extracts candles and filters null bars', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    } as Response)

    const candles = await fetchOHLCV('AAPL')
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)  // third bar is null, filtered out
    expect(candles![0].date).toBe('2024-01-01')
    expect(candles![0].open).toBe(190.0)
    expect(candles![0].high).toBe(195.0)
    expect(candles![0].low).toBe(189.0)
    expect(candles![0].close).toBe(193.0)
    expect(candles![0].volume).toBe(50_000_000)
  })

  it('returns null on HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as Response)
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })

  it('returns null when chart result is empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: null } }),
    } as Response)
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })

  it('returns null on fetch exception', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))
    expect(await fetchOHLCV('AAPL')).toBeNull()
  })
})
