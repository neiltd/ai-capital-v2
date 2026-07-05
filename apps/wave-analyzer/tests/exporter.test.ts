import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../src/fetchers/screener-fetcher.js', () => ({
  fetchMostActiveScreener: vi.fn(),
}))
vi.mock('../src/fetchers/ohlcv-fetcher.js', () => ({
  fetchOHLCV: vi.fn(),
}))

import { fetchMostActiveScreener } from '../src/fetchers/screener-fetcher.js'
import { fetchOHLCV } from '../src/fetchers/ohlcv-fetcher.js'
import { buildWaveAssets, exportWaves } from '../src/exporter.js'
import type { Candle } from '../src/types.js'

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    date:   `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1_000_000,
  }))
}

describe('buildWaveAssets', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.WATCHLIST_TICKERS = 'AAPL'
    process.env.SCREENER_COUNT = '1'
  })

  it('includes Gold, watchlist, and screener results', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))

    const assets = await buildWaveAssets()
    const tickers = assets.map(a => a.ticker)
    expect(tickers).toContain('GC=F')
    expect(tickers).toContain('AAPL')
    expect(tickers).toContain('NVDA')
  })

  it('deduplicates tickers across sources', async () => {
    process.env.WATCHLIST_TICKERS = 'NVDA'  // same as screener result
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))

    const assets = await buildWaveAssets()
    const nvda = assets.filter(a => a.ticker === 'NVDA')
    expect(nvda).toHaveLength(1)
  })

  it('skips tickers with insufficient candle data', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue(['NVDA'])
    ;(fetchOHLCV as any).mockImplementation((ticker: string) =>
      ticker === 'NVDA' ? null : makeCandles(25)
    )

    const assets = await buildWaveAssets()
    expect(assets.find(a => a.ticker === 'NVDA')).toBeUndefined()
  })
})

describe('exportWaves', () => {
  it('writes valid waves.json to the output path', async () => {
    ;(fetchMostActiveScreener as any).mockResolvedValue([])
    ;(fetchOHLCV as any).mockResolvedValue(makeCandles(25))
    process.env.WATCHLIST_TICKERS = ''
    process.env.SCREENER_COUNT = '0'

    const outPath = join(tmpdir(), `waves-test-${Date.now()}.json`)
    await exportWaves(outPath)

    expect(existsSync(outPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed).toHaveProperty('exportedAt')
    expect(parsed).toHaveProperty('asOf')
    expect(Array.isArray(parsed.assets)).toBe(true)
  })
})
