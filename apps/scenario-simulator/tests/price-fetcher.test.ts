import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPrices } from '../src/portfolio/price-fetcher.js'

beforeEach(() => { vi.resetAllMocks() })

describe('fetchPrices', () => {
  it('returns a price map from a successful API response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ data: [{ ticker: 'NVDA', price: 92.00 }, { ticker: 'MSFT', price: 415.00 }] }),
    } as any)

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
