import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMostActiveScreener } from '../src/fetchers/screener-fetcher.js'

describe('fetchMostActiveScreener', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('extracts ticker symbols from screener response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        finance: {
          result: [{
            quotes: [
              { symbol: 'NVDA' },
              { symbol: 'AAPL' },
              { symbol: 'TSLA' },
            ]
          }]
        }
      }),
    } as Response)

    const tickers = await fetchMostActiveScreener(3)
    expect(tickers).toEqual(['NVDA', 'AAPL', 'TSLA'])
  })

  it('returns empty array on HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as Response)
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })

  it('returns empty array when result is null', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ finance: { result: null } }),
    } as Response)
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })

  it('returns empty array on fetch exception', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))
    const tickers = await fetchMostActiveScreener(10)
    expect(tickers).toEqual([])
  })
})
