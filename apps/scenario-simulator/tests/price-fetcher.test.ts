import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPrices } from '../src/portfolio/price-fetcher.js'

beforeEach(() => { vi.resetAllMocks() })

describe('fetchPrices', () => {
  it('returns a price map from a successful API response', async () => {
    // Real shape from Yahoo's chart endpoint (see fetchPrice in price-fetcher.ts) —
    // this test predates the FinancialData.net → Yahoo Finance migration.
    const chartResponse = (price: number) => ({
      chart: { result: [{ meta: { regularMarketPrice: price }, timestamp: [], indicators: { quote: [{ close: [] }] } }] },
    })
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => chartResponse(92.00) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => chartResponse(415.00) } as any)

    const prices = await fetchPrices(['NVDA', 'MSFT'])

    expect(prices).toEqual({ NVDA: 92.00, MSFT: 415.00 })
  })

  it('returns an empty object on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as any)

    const prices = await fetchPrices(['NVDA'])

    expect(prices).toEqual({})
  })

  it('returns an empty object on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network failure'))

    const prices = await fetchPrices(['NVDA'])

    expect(prices).toEqual({})
  })

  it('returns an empty object without calling fetch when given empty tickers', async () => {
    global.fetch = vi.fn()

    const prices = await fetchPrices([])

    expect(prices).toEqual({})
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
