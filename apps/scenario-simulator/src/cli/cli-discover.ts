import 'dotenv/config'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

import { IngestionReader } from '../discovery/ingestion-reader.js'
import { filterCandidates } from '../discovery/ticker-filter.js'
import { extractTickers } from '../discovery/ticker-extractor.js'
import { scoreCandidates } from '../discovery/discovery-scorer.js'
import { analyzeCandidate } from '../discovery/discovery-analyzer.js'
import { reviewCandidate, adjustForBear } from '../discovery/discovery-reviewer.js'
import { PaperPortfolio } from '../discovery/paper-portfolio.js'
import { exportDiscovery } from '../discovery/discovery-exporter.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { sendLine, formatDiscoveryBuy } from '../notify/line.js'
import type { DiscoveryExportCandidate, DiscoveryScenario, DiscoveryAction, DiscoveryRun } from '../discovery/types.js'

const THRESHOLD  = parseInt(process.env.DISCOVERY_THRESHOLD  ?? '70', 10)
const NEWS_DAYS  = parseInt(process.env.DISCOVERY_NEWS_DAYS   ?? '7', 10)
const BUDGET     = parseFloat(process.env.DISCOVERY_BUDGET    ?? '20184.73')
const CASH_RESERVE_PCT = 0.20  // Keep 20% of budget in cash

// Cache analysis results for 7 days, bypassed for fast-moving "hot" tickers
// (typically high-volatility names you want re-analyzed every day).
const ANALYSIS_CACHE_TTL_DAYS = parseInt(process.env.DISCOVERY_CACHE_DAYS ?? '7', 10)
const HOT_TICKERS = new Set(
  (process.env.DISCOVERY_HOT_TICKERS ?? 'NVDA,ARM,CRWD,NET,APP,PLTR,MSTR,TSLA')
    .split(',').map(s => s.trim()).filter(Boolean)
)

function computeAllocation(totalDeployed: number, score: number): number {
  const maxDeployable = BUDGET * (1 - CASH_RESERVE_PCT)
  const remaining = maxDeployable - totalDeployed
  if (remaining <= 0) return 0
  // Base size on total deployable (not remaining) so positions stay consistent size.
  // Cap by remaining to never exceed budget.
  const pct = score >= 90 ? 0.12 : score >= 80 ? 0.08 : 0.05
  return Math.min(maxDeployable * pct, remaining)
}

const DATA_DIR            = join(process.cwd(), 'data')
const SIM_DB_PATH         = join(DATA_DIR, 'simulation.db')
const PORTFOLIO_DB_PATH   = join(DATA_DIR, 'portfolio.db')
const DISCOVERY_JSON_PATH = join(DATA_DIR, 'discovery.json')
const INGESTION_DB_PATH   = join(process.cwd(), '../capital-intelligence-ingestion/data/sqlite.db')
const ANALYSIS_JSON_PATH  = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')

async function run() {
  const startTime = Date.now()
  console.log('[discover] Starting discovery pipeline...')

  // Load macro context (optional — fall back gracefully if missing)
  let macroRegime = 'Unknown'
  let macroSignals = 'No signals available'
  try {
    if (existsSync(ANALYSIS_JSON_PATH)) {
      const analysis = JSON.parse(readFileSync(ANALYSIS_JSON_PATH, 'utf-8'))
      macroRegime = analysis.latestRegime?.regime ?? 'Unknown'
      if (Array.isArray(analysis.latestSignals)) {
        macroSignals = analysis.latestSignals
          .map((s: { sourceTicker?: string; targetTicker?: string; signalType?: string; direction?: string; magnitude?: string; sentiment?: string; description?: string }) => {
            const ticker = s.sourceTicker ?? s.targetTicker ?? '?'
            const kind   = s.signalType ?? 'signal'
            const tail   = [s.magnitude, s.sentiment, s.direction].filter(Boolean).join('/')
            const desc   = s.description ? ` — ${s.description}` : ''
            return `${ticker} ${kind}${tail ? ` (${tail})` : ''}${desc}`
          })
          .join('\n')
      }
    }
  } catch {
    console.log('[discover] analysis.json not available, using fallback macro context')
  }

  console.log(`[discover] Macro regime: ${macroRegime}`)

  const portfolio = new PaperPortfolio(SIM_DB_PATH)

  try {
    // Get open discovery tickers (to skip re-opening positions)
    const openDiscoveryTickers = portfolio.getOpenTickers()
    console.log(`[discover] Open discovery positions: ${openDiscoveryTickers.size}`)

    // Get real portfolio tickers
    const portfolioStore = createPortfolioStore(PORTFOLIO_DB_PATH)
    let realPortfolioTickers: string[] = []
    try {
      const positions = await portfolioStore.getPositions()
      realPortfolioTickers = positions.map((p: { ticker: string }) => p.ticker)
    } finally {
      await portfolioStore.close()
    }
    console.log(`[discover] Real portfolio: ${realPortfolioTickers.length} tickers`)

    // Read ingestion DB
    const reader = new IngestionReader(INGESTION_DB_PATH)
    const trackedCandidates = reader.getTrackedTickers(realPortfolioTickers)
    const recentNews = reader.getRecentNews(NEWS_DAYS)
    reader.close()
    console.log(`[discover] Tracked candidates: ${trackedCandidates.length}, Recent news docs: ${recentNews.length}`)

    // Extract additional tickers from news text
    const knownTickers = new Set([
      ...realPortfolioTickers,
      ...trackedCandidates.map(c => c.ticker),
      ...Array.from(openDiscoveryTickers),
    ])
    const newsMentions = await extractTickers(recentNews, knownTickers)
    console.log(`[discover] News mentions extracted: ${newsMentions.length}`)

    // Merge tracked candidates + news candidates, then filter out open positions
    const allCandidates = [...trackedCandidates, ...newsMentions]
    const filtered = filterCandidates(allCandidates, openDiscoveryTickers)
    console.log(`[discover] Candidates after filter: ${filtered.length}`)

    if (filtered.length === 0) {
      console.log('[discover] No new candidates to score. Refreshing existing positions and exporting.')

      const existingPositions = portfolio.getPositions()
      if (existingPositions.length > 0) {
        const existingTickers = existingPositions.map(p => p.ticker)
        let existingPrices: Record<string, number> = {}
        try {
          existingPrices = await fetchPrices(existingTickers)
        } catch (err) {
          console.warn('[discover] Price fetch failed for existing positions:', err)
        }
        portfolio.updatePrices(existingPrices)
      }

      exportDiscovery({
        candidates: [],
        discoveryPortfolio: portfolio.getPositions(),
        scenarios: [],
        actions: [],
        config: { threshold: THRESHOLD, paperBudget: BUDGET, cashReservePct: CASH_RESERVE_PCT, newsDays: NEWS_DAYS },
      }, DISCOVERY_JSON_PATH)

      portfolio.insertRun({
        id: randomUUID(),
        date: new Date().toISOString().slice(0, 10),
        candidatesFound: 0,
        passedFilter: 0,
        positionsOpened: 0,
        threshold: THRESHOLD,
        durationMs: Date.now() - startTime,
        createdAt: new Date().toISOString(),
      })

      console.log(`[discover] Done (no new candidates). Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
      return
    }

    // Fetch prices for candidate tickers
    const candidateTickers = filtered.map(c => c.ticker)
    let prices: Record<string, number> = {}
    try {
      prices = await fetchPrices(candidateTickers)
    } catch (err) {
      console.warn('[discover] Price fetch failed for candidates:', err)
    }

    // Score all candidates in one batch call
    const openDiscoveryTickersArray = Array.from(openDiscoveryTickers)
    const scored = await scoreCandidates(filtered, macroRegime, realPortfolioTickers, openDiscoveryTickersArray)
    console.log(`[discover] Scored ${scored.length} candidates`)

    // Build map from ticker → original candidate (to preserve newsSnippet)
    const filteredMap = new Map(filtered.map(c => [c.ticker, c]))

    // Deep analyze top scorers
    const exportCandidates: DiscoveryExportCandidate[] = []
    const allScenarios: DiscoveryScenario[] = []
    const allActions: DiscoveryAction[] = []
    let positionsOpened = 0
    const today = new Date().toISOString().slice(0, 10)

    const topScorers = scored.filter(s => s.score >= THRESHOLD)
    console.log(`[discover] Top scorers (>= ${THRESHOLD}): ${topScorers.length}`)

    if (BUDGET > 0) {
      const maxDeployable = BUDGET * (1 - CASH_RESERVE_PCT)
      const deployed = portfolio.getTotalDeployed()
      console.log(`[discover] Budget: $${deployed.toFixed(2)} deployed / $${maxDeployable.toFixed(2)} max (${(deployed / BUDGET * 100).toFixed(1)}% of $${BUDGET})`)
    }

    let runningDeployed = portfolio.getTotalDeployed()

    for (const candidate of topScorers) {
      const currentPrice = prices[candidate.ticker] ?? 0
      if (currentPrice <= 0) {
        console.log(`[discover] Skipping ${candidate.ticker} — no price available`)
        continue
      }

      const positionAllocation = computeAllocation(runningDeployed, candidate.score)
      if (positionAllocation <= 0) {
        console.log(`[discover] Skipping ${candidate.ticker} — budget limit reached (deployed: $${runningDeployed.toFixed(2)})`)
        continue
      }

      // Try cache first unless the ticker is in the hot list.
      let analysis = null
      if (!HOT_TICKERS.has(candidate.ticker)) {
        const cached = portfolio.getCachedAnalysis(candidate.ticker, ANALYSIS_CACHE_TTL_DAYS)
        if (cached) {
          console.log(`[discover] ${candidate.ticker} (score: ${candidate.score}) — using cached analysis`)
          analysis = cached
        }
      }
      if (!analysis) {
        console.log(`[discover] Analyzing ${candidate.ticker} (score: ${candidate.score}, alloc: $${positionAllocation.toFixed(2)})...`)
        analysis = await analyzeCandidate(candidate, currentPrice, macroRegime, macroSignals)
        if (analysis) portfolio.setCachedAnalysis(candidate.ticker, analysis)
      }

      if (!analysis) {
        console.log(`[discover] ${candidate.ticker} — analysis failed, skipping`)
        continue
      }

      // ── Adversarial bear review ─────────────────────────────────────────
      // Only run on actual BUY recommendations — there's no point
      // adversarializing a "watch" the model already declined to commit to.
      let finalAction = analysis.action
      if (analysis.action.recommendation === 'buy') {
        console.log(`[discover] ${candidate.ticker} — running adversarial bear review...`)
        const bear = await reviewCandidate(candidate, currentPrice, macroRegime, macroSignals, analysis.scenarios, analysis.action)
        if (bear) {
          const adjustment = adjustForBear(analysis.action, bear)
          if (adjustment.wasAdjusted) {
            console.log(`[discover] ${candidate.ticker} — bear score ${bear.bearScore}, ${adjustment.bull.recommendation}/${adjustment.bull.conviction} → ${adjustment.adjusted.recommendation}/${adjustment.adjusted.conviction}`)
          } else {
            console.log(`[discover] ${candidate.ticker} — bear score ${bear.bearScore}, bull thesis held`)
          }
          finalAction = adjustment.adjusted
        }
      }

      allScenarios.push(...analysis.scenarios)
      allActions.push(finalAction)

      const recommendation = finalAction.recommendation
      exportCandidates.push({
        ticker: candidate.ticker,
        company: candidate.company,
        score: candidate.score,
        rationale: candidate.rationale,
        source: candidate.source,
        discoveredAt: today,
        action: recommendation,
        newsSnippet: filteredMap.get(candidate.ticker)?.newsSnippet ?? null,
      })

      if (recommendation === 'buy' && !openDiscoveryTickers.has(candidate.ticker)) {
        const shares = parseFloat((positionAllocation / currentPrice).toFixed(4))
        portfolio.openPosition(
          candidate.ticker,
          candidate.company,
          shares,
          currentPrice,
          candidate.score,
          candidate.source,
          candidate.rationale,
        )
        openDiscoveryTickers.add(candidate.ticker) // prevent re-opening in same run
        runningDeployed += positionAllocation
        positionsOpened++
        console.log(`[discover] Opened paper position: ${candidate.ticker} x ${shares} @ $${currentPrice} ($${positionAllocation.toFixed(2)})`)
        await sendLine(formatDiscoveryBuy({
          ticker:     candidate.ticker,
          company:    candidate.company,
          score:      candidate.score,
          conviction: finalAction.conviction,
          price:      currentPrice,
          shares,
          rationale:  candidate.rationale,
        }))
      } else {
        console.log(`[discover] ${candidate.ticker} => ${recommendation} (no position opened)`)
      }
    }

    // Refresh prices for all open discovery positions (including newly opened ones)
    const allPositionTickers = Array.from(portfolio.getOpenTickers())
    if (allPositionTickers.length > 0) {
      try {
        const allPrices = await fetchPrices(allPositionTickers)
        portfolio.updatePrices(allPrices)
      } catch (err) {
        console.warn('[discover] Price refresh failed:', err)
      }
    }

    // Export discovery.json
    exportDiscovery({
      candidates: exportCandidates,
      discoveryPortfolio: portfolio.getPositions(),
      scenarios: allScenarios,
      actions: allActions,
      config: { threshold: THRESHOLD, paperBudget: BUDGET, cashReservePct: CASH_RESERVE_PCT, newsDays: NEWS_DAYS },
    }, DISCOVERY_JSON_PATH)

    // Insert run record
    const runRecord: DiscoveryRun = {
      id: randomUUID(),
      date: today,
      candidatesFound: filtered.length,
      passedFilter: topScorers.length,
      positionsOpened,
      threshold: THRESHOLD,
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    }
    portfolio.insertRun(runRecord)

    console.log(`[discover] Done. Candidates: ${filtered.length}, Passed filter: ${topScorers.length}, Positions opened: ${positionsOpened}`)
    console.log(`[discover] Exported to ${DISCOVERY_JSON_PATH}`)
    console.log(`[discover] Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  } finally {
    portfolio.close()
  }
}

run().catch(err => {
  console.error('[discover] Fatal error:', err)
  process.exit(1)
})
