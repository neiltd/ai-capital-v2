import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fetchWatchlistAwards, fetchAgencyFlows } from './fetchers/awards-fetcher.js'
import { fetchRecentBills } from './fetchers/budget-fetcher.js'
import { summarizeBills } from './summarizer.js'
import type { WatchlistAward, AgencyFlow, BudgetSignal, GovFlowJSON } from './types.js'

const BASE_WATCHLIST = ['MSFT','NVDA','GOOGL','AMZN','META','AAPL','PLTR','JPM','BAC','GS','LLY','UNH','JNJ','ABBV','MRNA']

function loadWatchlistTickers(): string[] {
  const envTickers = process.env.GOV_WATCHLIST_TICKERS
  if (envTickers) {
    const tickers = envTickers.split(',').map(t => t.trim()).filter(Boolean)
    if (tickers.length > 0) return [...new Set([...tickers, ...BASE_WATCHLIST])]
  }
  const dataRoot = process.env.DATA_ROOT
  if (dataRoot) {
    const portfolioTickers = join(dataRoot, 'scenario-simulator/data/portfolio-tickers.json')
    if (existsSync(portfolioTickers)) {
      try {
        const tickers: string[] = JSON.parse(readFileSync(portfolioTickers, 'utf-8'))
        return [...new Set([...tickers, ...BASE_WATCHLIST])]
      } catch { /* fall through */ }
    }
  }
  return BASE_WATCHLIST
}

export function buildGovFlow(
  watchlistAwards: WatchlistAward[],
  agencyFlows: AgencyFlow[],
  budgetSignals: BudgetSignal[],
): GovFlowJSON {
  return {
    exportedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    watchlistAwards,
    agencyFlows,
    budgetSignals,
  }
}

export async function exportGovFlow(outputPath: string): Promise<void> {
  const cachePath = join(dirname(outputPath), 'budget-cache.json')

  const [watchlistAwards, agencyFlows, rawBills] = await Promise.all([
    fetchWatchlistAwards(),
    fetchAgencyFlows(),
    fetchRecentBills(),
  ])

  const watchlistTickers = loadWatchlistTickers()
  console.log(`[govflow] watchlist: ${watchlistTickers.join(', ')}`)
  const budgetSignals = await summarizeBills(rawBills, watchlistTickers, cachePath)

  const result = buildGovFlow(watchlistAwards, agencyFlows, budgetSignals)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(result, null, 2))

  console.log(`[govflow] awards: ${watchlistAwards.length} companies, agency flows: ${agencyFlows.length}, budget signals: ${budgetSignals.length}`)
  console.log(`[govflow] Exported to ${outputPath}`)
}
