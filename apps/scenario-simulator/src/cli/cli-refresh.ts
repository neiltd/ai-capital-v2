import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync } from 'fs'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices, fetchPricesAndFx } from '../portfolio/price-fetcher.js'
import { fetchThaiNavs } from '../portfolio/thai-nav-fetcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const store = createPortfolioStore(join(__dirname, '../../data/portfolio.db'))

function exportPortfolioTickers(tickers: string[]): void {
  const dataRoot = process.env.DATA_ROOT
  if (!dataRoot || tickers.length === 0) return
  const outPath = join(dataRoot, 'scenario-simulator/data/portfolio-tickers.json')
  try {
    writeFileSync(outPath, JSON.stringify(tickers, null, 2))
  } catch { /* non-fatal */ }
}

async function run() {
  const positions = await store.getPositions()
  const log = await store.getTradeLog()

  if (positions.length === 0 && log.length === 0) {
    console.log('[refresh] No tickers to update')
    return
  }

  // th_fund prices are fetched from SEC Thailand API below — exclude them here.
  const symbols = positions
    .filter(p => p.assetClass !== 'cash' && p.assetClass !== 'th_fund' && p.priceSymbol)
    .map(p => p.priceSymbol)
  const logTickers = log.map(t => t.ticker)

  console.log(`[refresh] Fetching prices for: ${[...new Set([...symbols, ...logTickers])].join(', ')}`)
  const { prices, usdThb } = await fetchPricesAndFx(symbols)

  // Position price map: include cash at 1, and proxy-fetched prices keyed by priceSymbol.
  const positionPrices: Record<string, number> = { ...prices }
  for (const p of positions) {
    if (p.assetClass === 'cash') positionPrices[p.ticker] = 1
  }

  // Fetch Thai mutual fund NAVs from SEC Thailand API.
  const thaiFundTickers = positions
    .filter(p => p.assetClass === 'th_fund')
    .map(p => p.ticker)
  if (thaiFundTickers.length > 0) {
    const thaiNavs = await fetchThaiNavs(thaiFundTickers)
    Object.assign(positionPrices, thaiNavs)
  }

  // Trade log price refresh still uses ticker symbols directly.
  const logPrices = logTickers.length > 0 ? await fetchPrices(logTickers) : {}

  const fetched = Object.keys(positionPrices).length
  await store.updatePrices(positionPrices)
  if (Object.keys(logPrices).length > 0) await store.updateTradeCurrentPrices(logPrices)

  const allTickers = [...new Set([...positions.map(p => p.ticker), ...logTickers])]
  exportPortfolioTickers(allTickers)
  const fxNote = usdThb ? ` — FX 1 USD = ${usdThb.toFixed(4)} THB` : ''
  console.log(`[refresh] Updated ${fetched}/${positions.length} positions at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT${fxNote}`)
}

run()
  .catch(err => { console.error('[refresh] Error:', err.message); process.exit(1) })
  .finally(() => store.close())
