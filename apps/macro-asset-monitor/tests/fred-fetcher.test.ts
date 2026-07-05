import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchFredSeries, FRED_SERIES } from '../src/fetchers/fred-fetcher.js'

const makeObs = (values: string[], dates?: string[]) => ({
  observations: values.map((value, i) => ({
    date: dates?.[i] ?? `2026-0${5 - i}-14`,
    value,
  })),
})

describe('fetchFredSeries', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    process.env.FRED_API_KEY = 'testkey'
  })

  it('extracts latest non-dot value and computes rising trend', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['3.4', '3.2', '3.0']),
    } as Response)

    const result = await fetchFredSeries('CPIAUCSL', 'CPI YoY %', 'inflation', 'Percent')
    expect(result).not.toBeNull()
    expect(result!.value).toBe(3.4)
    expect(result!.trend).toBe('rising')
  })

  it('skips dot values and picks next available', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['.', '3.4', '3.5']),
    } as Response)

    const result = await fetchFredSeries('CPIAUCSL', 'CPI YoY %', 'inflation', 'Percent')
    expect(result!.value).toBe(3.4)
    expect(result!.trend).toBe('falling')
  })

  it('returns stable when change < 0.05', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => makeObs(['3.401', '3.400', '3.399']),
    } as Response)

    const result = await fetchFredSeries('UNRATE', 'Unemployment', 'labour', 'Percent')
    expect(result!.trend).toBe('stable')
  })

  it('returns null on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response)
    const result = await fetchFredSeries('CPIAUCSL', 'CPI', 'inflation', 'Percent')
    expect(result).toBeNull()
  })

  it('FRED_SERIES has 6 entries', () => {
    expect(FRED_SERIES).toHaveLength(6)
  })
})
