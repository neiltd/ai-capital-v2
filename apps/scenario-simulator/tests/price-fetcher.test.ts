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

  it('resolves a Finnomena fund via case-insensitive ticker matching', async () => {
    // K-ESGSI-ThaiESG -> F00001M4QH is a real entry in finnomena-fund-ids.json.
    // This system stores the ticker upper-cased as K-ESGSI-THAIESG, which
    // must still resolve to the same fund_id despite the casing mismatch.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any) // Yahoo — not exchange-listed
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.8548, d_change: 0 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.8548 })
    const finnomenaUrl = (global.fetch as any).mock.calls[1][0] as string
    expect(finnomenaUrl).toContain('F00001M4QH')
  })

  it('rejects an implausible Finnomena NAV move (>60% vs previous)', async () => {
    // d_change: 90 on a value of 100 implies a previous NAV of 10 — a 900%
    // jump, the same class of bad-fetch bug that corrupted the KLAC
    // discovery position on 2026-06-02.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 100, d_change: 90 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({})
  })

  it('accepts a plausible Finnomena NAV move', async () => {
    // d_change: 0.05 on a value of 10.85 implies a previous NAV of 10.80 —
    // a small, ordinary daily move.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.85, d_change: 0.05 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.85 })
  })

  it('accepts a Finnomena NAV when d_change is missing (nothing to compare against)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.85 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.85 })
  })
})
