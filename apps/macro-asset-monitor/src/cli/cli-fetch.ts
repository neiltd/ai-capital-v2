import 'dotenv/config'
import { join } from 'path'
import { fetchAllYahooAssets }      from '../fetchers/yahoo-fetcher.js'
import { fetchAllFredSeries }       from '../fetchers/fred-fetcher.js'
import { fetchLiquidityIndicators } from '../fetchers/liquidity-fetcher.js'
import { exportMacro }              from '../exporter.js'

const OUTPUT_PATH = join(process.cwd(), 'data/macro.json')

async function run() {
  const startTime = Date.now()
  console.log('[macro] Fetching macro asset data...')

  const [marketAssets, economicIndicators, liquidityIndicators] = await Promise.all([
    fetchAllYahooAssets(),
    fetchAllFredSeries(),
    fetchLiquidityIndicators(),
  ])

  console.log(`[macro] Market assets: ${marketAssets.length}`)
  console.log(`[macro] Economic indicators: ${economicIndicators.length}`)
  console.log(`[macro] Liquidity indicators: ${liquidityIndicators.length}/4`)

  const macro = exportMacro(marketAssets, economicIndicators, OUTPUT_PATH, liquidityIndicators)
  console.log(`[macro] Exported to ${OUTPUT_PATH}`)
  console.log(`[macro] asOf: ${macro.asOf}`)
  console.log(`[macro] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

run().catch(err => { console.error('[macro] Fatal:', err); process.exit(1) })
