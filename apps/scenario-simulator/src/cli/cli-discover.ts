import 'dotenv/config'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { usePostgres, closePool } from '@common/db'

import { IngestionReader } from '../discovery/ingestion-reader.js'
import { filterCandidates } from '../discovery/ticker-filter.js'
import { extractTickers } from '../discovery/ticker-extractor.js'
import { scoreCandidates } from '../discovery/discovery-scorer.js'
import { analyzeCandidate } from '../discovery/discovery-analyzer.js'
import { reviewCandidate, adjustForBear } from '../discovery/discovery-reviewer.js'
import { PaperPortfolio } from '../discovery/paper-portfolio.js'
import { exportDiscovery } from '../discovery/discovery-exporter.js'
import { fetchPrices, fetchPricesAndFx } from '../portfolio/price-fetcher.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { sendLine, formatDiscoveryBuy } from '../notify/line.js'
import {
  loadThemesMap, paperBookThemeValue, realPortfolioThemeValueUSD, formatThemeContext,
  THEME_CONCENTRATION_CAP,
} from '../discovery/theme-tracker.js'
import { checkMechanicalExits, selectThesisCheckCandidates } from '../discovery/exit-checks.js'
import { computeRiskProfile, computeRiskBasedAllocation, RISK_PER_TRADE_PCT } from '../discovery/risk-sizing.js'
import { computeCalibration, formatCalibrationBlock } from '../discovery/calibration.js'
import type { DiscoveryExportCandidate, DiscoveryScenario, DiscoveryAction, DiscoveryRun, ScoredCandidate } from '../discovery/types.js'

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

// Hard cap on LLM-based thesis re-reviews per run — the selection criteria
// (down >10% or held >90d) is the primary throttle and should normally yield
// 0-3 candidates a week, but a market-wide drawdown could otherwise spike
// this; this cap keeps a bad week bounded rather than unbounded.
const MAX_THESIS_CHECKS_PER_RUN = 5

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
const CALIBRATION_JSON_PATH = join(DATA_DIR, 'discovery-calibration.json')
const INGESTION_DB_PATH   = join(process.cwd(), '../capital-intelligence-ingestion/data/sqlite.db')
const ANALYSIS_JSON_PATH  = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const THEMES_MAP_PATH     = join(process.cwd(), '../capital-intelligence-ingestion/data/themes-map.json')

// Manual exit path: `npm run discover -- --exit=TICKER --price=12.34 --reason="thesis broken"`.
// Bypasses the full weekly screen — this is the only way to close a paper
// position today (see gap: PaperPortfolio had no exit mechanism until this
// was added, which made win-rate and realized P&L structurally unmeasurable).
async function runExit(ticker: string, price: number, reason: string) {
  const portfolio = new PaperPortfolio(SIM_DB_PATH)
  try {
    if (!portfolio.getOpenTickers().has(ticker)) {
      console.error(`[discover] --exit: ${ticker} is not an open paper position`)
      process.exit(1)
    }
    let benchmarkAtClose: number | null = null
    try {
      const spy = await fetchPrices(['SPY'])
      benchmarkAtClose = spy['SPY'] ?? null
    } catch (err) {
      console.warn('[discover] --exit: SPY benchmark fetch failed (closing without it):', err)
    }
    const closed = portfolio.closePosition(ticker, price, reason, benchmarkAtClose)
    console.log(`[discover] Closed ${closed.ticker}: ${closed.shares.toFixed(4)} shares @ $${closed.exitPrice} (avg cost $${closed.avgCost}) → realized ${closed.realizedPnl >= 0 ? '+' : ''}$${closed.realizedPnl.toFixed(2)}`)

    // Re-export discovery.json so the closed position shows up immediately,
    // without waiting for the next weekly run.
    if (existsSync(DISCOVERY_JSON_PATH)) {
      const existing = JSON.parse(readFileSync(DISCOVERY_JSON_PATH, 'utf-8'))
      exportDiscovery({
        candidates:         existing.candidates ?? [],
        discoveryPortfolio: portfolio.getPositions(),
        closedPositions:    portfolio.getClosedPositions(),
        scenarios:          existing.scenarios ?? [],
        actions:            existing.actions ?? [],
        config: { threshold: THRESHOLD, paperBudget: BUDGET, cashReservePct: CASH_RESERVE_PCT, newsDays: NEWS_DAYS },
      }, DISCOVERY_JSON_PATH)
    }
  } finally {
    portfolio.close()
  }
}

// Automated exit checks (P2), run at the top of every weekly cycle, before
// any new candidate is scored — this is what converts the reset's
// closePosition() *mechanism* into an actual *policy*. Without this, the
// paper book only frees budget when a human remembers to run --exit, which
// is exactly how the 2026-06 cohort went dead for five straight runs.
// Returns the set of tickers exited this run, so the main loop's theme/budget
// math (computed before this call, on the pre-exit book) can be treated as
// conservative rather than stale.
async function runAutomatedExitChecks(
  portfolio: PaperPortfolio,
  macroRegime: string,
  macroSignals: string,
): Promise<Set<string>> {
  const exitedTickers = new Set<string>()
  const openPositions = portfolio.getPositions()
  if (openPositions.length === 0) return exitedTickers

  let currentPrices: Record<string, number> = {}
  try {
    currentPrices = await fetchPrices(openPositions.map(p => p.ticker))
  } catch (err) {
    console.warn('[discover] Exit-check price fetch failed — skipping exit checks this run:', err)
    return exitedTickers
  }

  let benchmarkAtClose: number | null = null
  try {
    const spy = await fetchPrices(['SPY'])
    benchmarkAtClose = spy['SPY'] ?? null
  } catch {
    // Non-fatal — closePosition accepts a null benchmark.
  }

  // ── Mechanical exits: stop hit / time stop ──────────────────────────────
  const mechanicalExits = checkMechanicalExits(openPositions, currentPrices)
  for (const exit of mechanicalExits) {
    try {
      const closed = portfolio.closePosition(exit.ticker, exit.exitPrice, exit.reason, benchmarkAtClose)
      exitedTickers.add(exit.ticker)
      console.log(`[discover] Auto-closed ${closed.ticker} (${exit.reason}): ${closed.shares.toFixed(4)} shares @ $${exit.exitPrice} → realized ${closed.realizedPnl >= 0 ? '+' : ''}$${closed.realizedPnl.toFixed(2)}`)
    } catch (err) {
      console.warn(`[discover] Auto-close failed for ${exit.ticker}:`, err)
    }
  }

  // ── Thesis re-review: LLM, throttled ────────────────────────────────────
  const thesisCandidates = selectThesisCheckCandidates(openPositions, currentPrices, exitedTickers)
    .slice(0, MAX_THESIS_CHECKS_PER_RUN)
  if (thesisCandidates.length > 0) {
    console.log(`[discover] Thesis re-review: ${thesisCandidates.length} position(s) down >10% or held >90d`)
  }
  for (const position of thesisCandidates) {
    const syntheticCandidate: ScoredCandidate = {
      ticker: position.ticker,
      company: position.company,
      source: position.source,
      score: position.score,
      rationale: position.rationale,
    }
    const syntheticBullAction: DiscoveryAction = {
      ticker: position.ticker,
      recommendation: 'buy',
      conviction: position.adjustedConviction ?? 'medium',
      rationale: position.rationale,
    }
    const price = currentPrices[position.ticker]
    try {
      // No fresh bull scenarios exist for an already-open position (the
      // original analysis is long past its 7-day cache TTL) — this is a
      // lighter-weight review than the open-time one, critiquing the stored
      // rationale directly rather than a fresh scenario set.
      const bear = await reviewCandidate(syntheticCandidate, price, macroRegime, macroSignals, [], syntheticBullAction)
      if (bear?.suggestedAdjustment === 'reject') {
        const closed = portfolio.closePosition(position.ticker, price, 'thesis broken', benchmarkAtClose)
        exitedTickers.add(position.ticker)
        console.log(`[discover] Auto-closed ${closed.ticker} (thesis broken, bear score ${bear.bearScore}): realized ${closed.realizedPnl >= 0 ? '+' : ''}$${closed.realizedPnl.toFixed(2)} — ${bear.topConcerns.slice(0, 2).join('; ')}`)
      } else if (bear) {
        console.log(`[discover] ${position.ticker} — thesis re-review: bear score ${bear.bearScore}, held (${bear.suggestedAdjustment})`)
      }
    } catch (err) {
      console.warn(`[discover] Thesis re-review failed for ${position.ticker}:`, err)
    }
  }

  return exitedTickers
}

async function run() {
  const exitArg = process.argv.slice(2).find(a => a.startsWith('--exit='))
  if (exitArg) {
    const ticker    = exitArg.split('=')[1]
    const priceArg  = process.argv.slice(2).find(a => a.startsWith('--price='))
    const reasonArg = process.argv.slice(2).find(a => a.startsWith('--reason='))
    const price = priceArg ? parseFloat(priceArg.split('=')[1]) : NaN
    if (!ticker || !Number.isFinite(price) || price <= 0) {
      console.error('Usage: npm run discover -- --exit=TICKER --price=12.34 --reason="thesis broken"')
      process.exit(1)
    }
    const reason = reasonArg ? reasonArg.split('=').slice(1).join('=').replace(/^"|"$/g, '') : 'manual exit'
    await runExit(ticker, price, reason)
    return
  }

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
    // Automated exit checks — before anything else, so freed budget/theme
    // room is available to this run's candidate loop, and so a position that
    // just hit its stop can't also be re-scored as a "new" candidate.
    console.log('[discover] Running automated exit checks...')
    await runAutomatedExitChecks(portfolio, macroRegime, macroSignals)

    // Get open discovery tickers (to skip re-opening positions) — read AFTER
    // exit checks so anything just closed is correctly treated as available
    // budget/theme room, not a phantom still-open position.
    const openDiscoveryTickers = portfolio.getOpenTickers()
    console.log(`[discover] Open discovery positions: ${openDiscoveryTickers.size}`)

    // Get real portfolio positions (tickers for candidate filtering, full
    // objects + FX for theme-concentration awareness — see theme-tracker.ts).
    const portfolioStore = createPortfolioStore(PORTFOLIO_DB_PATH, { fileMustExist: true })
    let realPortfolioTickers: string[] = []
    let realPortfolioPositions: Awaited<ReturnType<typeof portfolioStore.getPositions>> = []
    try {
      realPortfolioPositions = await portfolioStore.getPositions()
      realPortfolioTickers = realPortfolioPositions.map(p => p.ticker)
    } finally {
      await portfolioStore.close()
    }
    console.log(`[discover] Real portfolio: ${realPortfolioTickers.length} tickers`)

    // Theme-weight context (P1 — see docs/discovery-agent-enhancement-proposal-2026-07-06.md).
    const themesMap = loadThemesMap(THEMES_MAP_PATH)
    let usdThb: number | null = null
    try {
      const fx = await fetchPricesAndFx([], { includeFx: true })
      usdThb = fx.usdThb
    } catch (err) {
      console.warn('[discover] FX fetch failed — real-portfolio theme values will be unconverted for THB positions:', err)
    }
    const paperMaxDeployable = BUDGET * (1 - CASH_RESERVE_PCT)
    const paperThemeValue = paperBookThemeValue(portfolio.getPositions(), themesMap)
    const realThemeValue  = realPortfolioThemeValueUSD(realPortfolioPositions, themesMap, usdThb)
    const themeContext = formatThemeContext(paperThemeValue, paperMaxDeployable, realThemeValue)
    console.log(`[discover] Theme context:\n${themeContext}`)

    // Calibration context (P3 — see docs/discovery-agent-enhancement-proposal-2026-07-06.md).
    // No historical data exists before the 2026-07-06 reset; formatCalibrationBlock
    // is explicit about "insufficient data" until n grows.
    let currentSpyPrice: number | null = null
    try {
      const spy = await fetchPrices(['SPY'])
      currentSpyPrice = spy['SPY'] ?? null
    } catch (err) {
      console.warn('[discover] SPY fetch failed — calibration provisional stats will skip vs-SPY:', err)
    }
    const calibration = computeCalibration(portfolio.getClosedPositions(), portfolio.getPositions(), currentSpyPrice)
    const calibrationContext = formatCalibrationBlock(calibration)
    console.log(`[discover] Calibration:\n${calibrationContext}`)
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(CALIBRATION_JSON_PATH, JSON.stringify(calibration, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[discover] Failed to write discovery-calibration.json:', err)
    }

    // Read ingestion DB
    const reader = new IngestionReader(INGESTION_DB_PATH)
    const trackedCandidates = await reader.getTrackedTickers(realPortfolioTickers)
    const recentNews = reader.getRecentNews(NEWS_DAYS)
    await reader.close()
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
        closedPositions: portfolio.getClosedPositions(),
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

    // Fetch prices for candidate tickers, plus SPY as the benchmark snapshot
    // captured at open time (backend-gaps: previously no benchmark was
    // recorded at entry, so "vs SPY since open" could never be computed).
    const candidateTickers = filtered.map(c => c.ticker)
    let prices: Record<string, number> = {}
    let benchmarkPrice: number | null = null
    try {
      prices = await fetchPrices([...candidateTickers, 'SPY'])
      benchmarkPrice = prices['SPY'] ?? null
    } catch (err) {
      console.warn('[discover] Price fetch failed for candidates:', err)
    }

    // Score all candidates in one batch call
    const openDiscoveryTickersArray = Array.from(openDiscoveryTickers)
    const scored = await scoreCandidates(filtered, macroRegime, realPortfolioTickers, openDiscoveryTickersArray, themeContext, calibrationContext)
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
    // Running per-theme paper-book value, mutated as positions open in this
    // loop — starts from pre-run state so a batch of correlated candidates in
    // the *same* run can't all sail through together (P1).
    const runningThemeDeployed = new Map(paperThemeValue)

    for (const candidate of topScorers) {
      // The paper book (discovery_positions) has no currency column — every
      // number in it is treated as USD. Yahoo quotes .BK tickers in THB, so
      // opening one would book THB values as dollars (~33x off) and corrupt
      // the deployed-budget math. Skip until the schema carries currency.
      if (candidate.ticker.endsWith('.BK')) {
        console.log(`[discover] Skipping ${candidate.ticker} — THB-quoted (.BK); paper portfolio is USD-only`)
        continue
      }

      const currentPrice = prices[candidate.ticker] ?? 0
      if (currentPrice <= 0) {
        console.log(`[discover] Skipping ${candidate.ticker} — no price available`)
        continue
      }

      let positionAllocation = computeAllocation(runningDeployed, candidate.score)
      if (positionAllocation <= 0) {
        console.log(`[discover] Skipping ${candidate.ticker} — budget limit reached (deployed: $${runningDeployed.toFixed(2)})`)
        continue
      }

      // ── Theme concentration guardrails (P1) ─────────────────────────────
      const theme = themesMap[candidate.ticker]
      let themeHaircutNote = ''
      if (theme) {
        const themeDeployedSoFar = runningThemeDeployed.get(theme) ?? 0
        if (paperMaxDeployable > 0 && (themeDeployedSoFar + positionAllocation) / paperMaxDeployable > THEME_CONCENTRATION_CAP) {
          console.log(`[discover] Skipping ${candidate.ticker} — theme-cap: "${theme}" would exceed ${(THEME_CONCENTRATION_CAP * 100).toFixed(0)}% of paper book (currently $${themeDeployedSoFar.toFixed(2)} of $${paperMaxDeployable.toFixed(2)} max)`)
          continue
        }
        const realThemePct = realThemeValue.totalUsd > 0 ? (realThemeValue.byTheme.get(theme) ?? 0) / realThemeValue.totalUsd : 0
        if (realThemePct > THEME_CONCENTRATION_CAP) {
          positionAllocation = positionAllocation / 2
          themeHaircutNote = ` [sized down 50% — "${theme}" is already ${(realThemePct * 100).toFixed(0)}% of real portfolio]`
          console.log(`[discover] ${candidate.ticker} — real-portfolio overlap haircut applied (theme "${theme}" is ${(realThemePct * 100).toFixed(0)}% of real net worth)`)
        }
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
        analysis = await analyzeCandidate(candidate, currentPrice, macroRegime, macroSignals, themeContext, calibrationContext)
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
        // ── Risk-based sizing (P2) ─────────────────────────────────────────
        // positionAllocation so far is the score-band cap (already theme-
        // haircut-adjusted); risk sizing can only bring it DOWN from there
        // (min() below), so the theme-cap check earlier remains valid without
        // re-checking here.
        let finalAllocation = positionAllocation
        let stopPrice: number | null = null
        let targetPrice: number | null = null
        const riskProfile = await computeRiskProfile(candidate.ticker, currentPrice)
        if (riskProfile.stopPrice != null && riskProfile.targetPrice != null) {
          const riskBudget = RISK_PER_TRADE_PCT * BUDGET
          finalAllocation = computeRiskBasedAllocation(
            currentPrice, riskProfile.stopPrice, riskBudget, positionAllocation, finalAction.conviction,
          )
          stopPrice = riskProfile.stopPrice
          targetPrice = riskProfile.targetPrice
          console.log(`[discover] ${candidate.ticker} — risk sizing: stop $${stopPrice.toFixed(2)}, target $${targetPrice.toFixed(2)}, conviction ${finalAction.conviction} → $${finalAllocation.toFixed(2)} (score-band cap was $${positionAllocation.toFixed(2)})`)
        } else {
          // Volatility fetch failed or produced a degenerate stop — fall back
          // to score-band sizing rather than block the buy on a Yahoo hiccup,
          // but still apply the conviction multiplier so the bear review's
          // downgrade isn't silently ignored.
          finalAllocation = positionAllocation * (finalAction.conviction === 'high' ? 1.0 : finalAction.conviction === 'medium' ? 0.75 : 0.5)
          console.log(`[discover] ${candidate.ticker} — risk profile unavailable, falling back to score-band sizing × conviction: $${finalAllocation.toFixed(2)}`)
        }

        if (finalAllocation <= 0) {
          console.log(`[discover] Skipping ${candidate.ticker} — risk-based allocation resolved to $0`)
          continue
        }

        const shares = parseFloat((finalAllocation / currentPrice).toFixed(4))
        portfolio.openPosition(
          candidate.ticker,
          candidate.company,
          shares,
          currentPrice,
          candidate.score,
          candidate.source,
          candidate.rationale + themeHaircutNote,
          benchmarkPrice,
          { stopPrice, targetPrice, adjustedConviction: finalAction.conviction },
        )
        if (theme) runningThemeDeployed.set(theme, (runningThemeDeployed.get(theme) ?? 0) + finalAllocation)
        openDiscoveryTickers.add(candidate.ticker) // prevent re-opening in same run
        runningDeployed += finalAllocation
        positionsOpened++
        console.log(`[discover] Opened paper position: ${candidate.ticker} x ${shares} @ $${currentPrice} ($${finalAllocation.toFixed(2)})`)
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
      closedPositions: portfolio.getClosedPositions(),
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

run()
  .catch(err => {
    console.error('[discover] Fatal error:', err)
    process.exit(1)
  })
  .finally(() => { if (usePostgres()) return closePool() })
