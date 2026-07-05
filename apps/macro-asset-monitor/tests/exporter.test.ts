import { describe, it, expect } from 'vitest'
import { buildMacro, exportMacro } from '../src/exporter.js'
import type { MarketAsset, EconomicIndicator } from '../src/types.js'
import type { LiquidityIndicator } from '../src/types.js'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const asset: MarketAsset = {
  ticker: '^TNX', label: 'US 10Y Yield', category: 'rates',
  close: 4.61, change1d: 0.06, changePct1d: 1.32,
  changePct5d: 4.07, changePct30d: 10.0, trend: 'rising',
}
const indicator: EconomicIndicator = {
  seriesId: 'CPIAUCSL', label: 'CPI YoY %', category: 'inflation',
  value: 3.4, releaseDate: '2026-05-14', unit: 'Percent', trend: 'rising',
}
const liquidityIndicator: LiquidityIndicator = {
  seriesId: 'WALCL', label: 'Fed Balance Sheet',
  value: 7200, releaseDate: '2026-05-22', unit: 'Billions USD',
  change4w: -85, changeYoY: -2.1, signal: 'draining',
}

describe('buildMacro', () => {
  it('builds MacroJSON with correct shape', () => {
    const result = buildMacro([asset], [indicator])
    expect(result.marketAssets).toHaveLength(1)
    expect(result.economicIndicators).toHaveLength(1)
    expect(result.marketAssets[0].ticker).toBe('^TNX')
    expect(result.economicIndicators[0].seriesId).toBe('CPIAUCSL')
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('sets asOf to today', () => {
    const result = buildMacro([asset], [])
    const today = new Date().toISOString().slice(0, 10)
    expect(result.asOf).toBe(today)
  })

  it('includes liquidityIndicators in output', () => {
    const result = buildMacro([asset], [indicator], [liquidityIndicator])
    expect(result.liquidityIndicators).toHaveLength(1)
    expect(result.liquidityIndicators[0].seriesId).toBe('WALCL')
    expect(result.liquidityIndicators[0].signal).toBe('draining')
  })

  it('accepts empty liquidityIndicators array', () => {
    const result = buildMacro([asset], [indicator], [])
    expect(result.liquidityIndicators).toHaveLength(0)
  })
})

describe('exportMacro', () => {
  const tmpFile = join(tmpdir(), `macro-test-${Date.now()}.json`)

  it('writes macro.json to output path', () => {
    const result = exportMacro([asset], [indicator], tmpFile)
    expect(existsSync(tmpFile)).toBe(true)
    const written = JSON.parse(readFileSync(tmpFile, 'utf-8'))
    expect(written.marketAssets).toHaveLength(1)
    expect(written.marketAssets[0].ticker).toBe('^TNX')
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    rmSync(tmpFile, { force: true })
  })

  it('uses cached assets when new assets is empty and cache exists', () => {
    const cachedMacro = buildMacro([asset], [])
    writeFileSync(tmpFile, JSON.stringify(cachedMacro), 'utf-8')

    const result = exportMacro([], [indicator], tmpFile)
    expect(result.marketAssets).toHaveLength(1)
    expect(result.marketAssets[0].ticker).toBe('^TNX')
    rmSync(tmpFile, { force: true })
  })

  it('does not crash when cache is corrupt JSON', () => {
    writeFileSync(tmpFile, 'NOT VALID JSON', 'utf-8')
    expect(() => exportMacro([], [], tmpFile)).not.toThrow()
    rmSync(tmpFile, { force: true })
  })
})
