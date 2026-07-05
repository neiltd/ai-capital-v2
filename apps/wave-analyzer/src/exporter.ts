import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fetchMostActiveScreener } from './fetchers/screener-fetcher.js'
import { fetchOHLCV } from './fetchers/ohlcv-fetcher.js'
import { computeZigzag } from './analysis/zigzag.js'
import { detectWaves } from './analysis/wave-detector.js'
import { generateActions } from './actions/action-generator.js'
import { createTradePortfolio } from './portfolio/trade-portfolio.js'
import type { WaveAsset, WaveSource, WavesJSON, WaveActionsJSON, WavePortfolioJSON } from './types.js'

const GOLD_TICKER = 'GC=F'
const GOLD_LABEL  = 'Gold'

export async function buildWaveAssets(): Promise<WaveAsset[]> {
  const screenerCount = parseInt(process.env.SCREENER_COUNT ?? '20', 10)
  const watchlist = (process.env.WATCHLIST_TICKERS ?? '')
    .split(',').map(t => t.trim()).filter(Boolean)

  const screenerTickers = await fetchMostActiveScreener(screenerCount)

  const seen   = new Set<string>()
  const toFetch: Array<{ ticker: string; label: string; source: WaveSource }> = []

  const add = (ticker: string, label: string, source: WaveSource) => {
    if (seen.has(ticker)) return
    seen.add(ticker)
    toFetch.push({ ticker, label, source })
  }

  add(GOLD_TICKER, GOLD_LABEL, 'macro')
  for (const t of watchlist) add(t, t, 'watchlist')
  for (const t of screenerTickers) add(t, t, 'screener')

  const results = await Promise.all(toFetch.map(async ({ ticker, label, source }) => {
    const candles = await fetchOHLCV(ticker)
    if (!candles || candles.length < 20) {
      console.warn(`[wave] ${ticker}: insufficient data, skipping`)
      return null
    }
    const threshold = source === 'macro' ? 0.03 : 0.05
    const pivots    = computeZigzag(candles, threshold)
    const { wavePivots, currentWave, waveDirection, confidence, fibChecks } = detectWaves(pivots)
    const asset: WaveAsset = {
      ticker, label, source, candles, pivots,
      wavePivots, currentWave, waveDirection, confidence, fibChecks,
    }
    return asset
  }))

  return results.filter((r): r is WaveAsset => r !== null)
}

export async function exportWaves(outputPath: string): Promise<void> {
  const assets   = await buildWaveAssets()
  const allDates = assets.flatMap(a => a.candles.map(c => c.date)).sort()
  const asOf     = allDates.at(-1) ?? new Date().toISOString().slice(0, 10)

  const output: WavesJSON = {
    exportedAt: new Date().toISOString(),
    asOf,
    assets,
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`[wave] Wrote ${assets.length} assets to ${outputPath}`)

  const dataDir         = dirname(outputPath)
  const actionsPath     = join(dataDir, 'wave-actions.json')
  const portfolioPath   = join(dataDir, 'wave-portfolio.json')
  const narrativeCachePath = join(dataDir, 'narrative-cache.json')
  const tradesDbPath    = join(dataDir, 'trades.db')

  const actions = await generateActions(assets, narrativeCachePath)
  const waveActionsOutput: WaveActionsJSON = {
    exportedAt: new Date().toISOString(),
    asOf,
    actions,
  }
  writeFileSync(actionsPath, JSON.stringify(waveActionsOutput, null, 2))
  console.log(`[wave] Trade actions: ${actions.filter(a => a.signal !== 'no-signal').length} signals, wrote to ${actionsPath}`)

  const portfolio = createTradePortfolio(tradesDbPath)

  // --- Paper trading sync ---
  // Close open trades that hit stop or target based on the latest candle close
  const openTrades = portfolio.getOpenPositions()
  const latestPrices = new Map(assets.map(a => [a.ticker, a.candles.at(-1)?.close ?? null]))
  let closed = 0
  for (const trade of openTrades) {
    const price = latestPrices.get(trade.ticker)
    if (price == null) continue
    if (trade.signal === 'buy') {
      if (price <= trade.stopLoss) { portfolio.closeTrade(trade.id, trade.stopLoss); closed++ }
      else if (price >= trade.target) { portfolio.closeTrade(trade.id, trade.target); closed++ }
    } else {
      if (price >= trade.stopLoss) { portfolio.closeTrade(trade.id, trade.stopLoss); closed++ }
      else if (price <= trade.target) { portfolio.closeTrade(trade.id, trade.target); closed++ }
    }
  }

  // Open new paper trades for buy/sell signals not already tracked
  const openTickers = new Set(portfolio.getOpenPositions().map(p => p.ticker))
  let opened = 0
  const POSITION_SIZE_USD = 1000
  for (const action of actions) {
    if (action.signal !== 'buy' && action.signal !== 'sell') continue
    if (openTickers.has(action.ticker)) continue
    if (!action.entryZone || action.stopLoss == null || action.target == null) continue
    const entryPrice = (action.entryZone.low + action.entryZone.high) / 2
    const shares     = Math.max(1, Math.floor(POSITION_SIZE_USD / entryPrice))
    portfolio.openTrade({
      ticker: action.ticker, signal: action.signal,
      entryPrice, stopLoss: action.stopLoss, target: action.target,
      shares, openedAt: new Date().toISOString(),
    })
    opened++
  }
  if (opened || closed) {
    console.log(`[wave] Paper trades: +${opened} opened, ${closed} closed`)
  }
  // --- End paper trading sync ---

  const openPositions   = portfolio.getOpenPositions()
  const closedPositions = portfolio.getClosedPositions(50)
  const totalPnl        = closedPositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const wavePortfolioOutput: WavePortfolioJSON = {
    exportedAt: new Date().toISOString(),
    openPositions,
    closedPositions,
    totalPnl,
  }
  writeFileSync(portfolioPath, JSON.stringify(wavePortfolioOutput, null, 2))
  portfolio.close()
  console.log(`[wave] Portfolio: ${openPositions.length} open, ${closedPositions.length} closed, wrote to ${portfolioPath}`)
}
