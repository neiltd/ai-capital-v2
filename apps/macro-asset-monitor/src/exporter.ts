import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { MarketAsset, EconomicIndicator, LiquidityIndicator, MacroJSON } from './types.js'

export function buildMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
  liquidityIndicators: LiquidityIndicator[] = [],
): MacroJSON {
  return {
    exportedAt:          new Date().toISOString(),
    asOf:                new Date().toISOString().slice(0, 10),
    marketAssets,
    economicIndicators,
    liquidityIndicators,
  }
}

export function exportMacro(
  marketAssets: MarketAsset[],
  economicIndicators: EconomicIndicator[],
  outputPath: string,
  liquidityIndicators: LiquidityIndicator[] = [],
): MacroJSON {
  let assets = marketAssets
  if (assets.length === 0 && existsSync(outputPath)) {
    try {
      const cached = JSON.parse(readFileSync(outputPath, 'utf-8')) as MacroJSON
      assets = cached.marketAssets
      console.log('[macro] No new market data — using cached asset prices')
    } catch {
      // ignore corrupt cache
    }
  }

  const macro = buildMacro(assets, economicIndicators, liquidityIndicators)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(macro, null, 2), 'utf-8')
  return macro
}
