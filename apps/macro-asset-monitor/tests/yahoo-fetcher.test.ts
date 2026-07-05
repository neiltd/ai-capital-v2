import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchYahooAsset, YAHOO_ASSETS } from '../src/fetchers/yahoo-fetcher.js'

const makeYahooResponse = (closes: number[]) => ({
  chart: {
    result: [{
      timestamp: closes.map((_, i) => 1716307200 + i * 86400),
      indicators: { quote: [{ close: closes }] },
    }],
    error: null,
  },
})

describe('fetchYahooAsset', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('computes 1d/5d/30d changes correctly', async () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 + i)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeYahooResponse(closes),
    } as Response)

    const result = await fetchYahooAsset('^TNX', 'US 10Y Yield', 'rates')

    expect(result).not.toBeNull()
    expect(result!.close).toBe(130)
    expect(result!.change1d).toBeCloseTo(1)
    expect(result!.changePct1d).toBeCloseTo(0.775, 1)
    expect(result!.changePct5d).toBeCloseTo(4.0, 1)
    expect(result!.changePct30d).toBeCloseTo(30.0, 1)
    expect(result!.trend).toBe('rising')
  })

  it('skips null closes', async () => {
    const closes = [100, null, null, 103, 104, null, 106]
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeYahooResponse(closes as number[]),
    } as Response)

    const result = await fetchYahooAsset('HYG', 'HYG', 'credit')
    expect(result).not.toBeNull()
    expect(result!.close).toBe(106)
  })

  it('returns null on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as Response)
    const result = await fetchYahooAsset('^VIX', 'VIX', 'volatility')
    expect(result).toBeNull()
  })

  it('returns null on fetch exception', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network'))
    const result = await fetchYahooAsset('^VIX', 'VIX', 'volatility')
    expect(result).toBeNull()
  })

  it('YAHOO_ASSETS has 11 entries', () => {
    expect(YAHOO_ASSETS).toHaveLength(11)
  })
})
