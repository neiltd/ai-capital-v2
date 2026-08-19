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

  // Was a bare toHaveLength(6) and went stale the moment the Thai structural
  // indicators landed (8d64efb, 2026-08-10). Assert the composition instead, so
  // the failure message says which region regressed rather than just a count.
  it('covers both the US and Thailand macro blocks', () => {
    const byRegion = (r: string) => FRED_SERIES.filter(s => s.region === r).map(s => s.seriesId)
    expect(byRegion('US')).toEqual(['CPIAUCSL', 'JTSJOL', 'UNRATE', 'UMCSENT', 'DRCCLACBS', 'DRSFRMACBS'])
    expect(byRegion('TH')).toEqual(['QTHHAM770A', 'RBTHBIS'])
    expect(FRED_SERIES).toHaveLength(byRegion('US').length + byRegion('TH').length)
  })
})
