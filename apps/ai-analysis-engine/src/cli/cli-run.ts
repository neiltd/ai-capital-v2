import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { createAnalysisStore } from '../store/sqlite.js'
import { collectHealth } from '../collector/health-collector.js'
import { analyzeRegime } from '../analysis/regime-analyzer.js'
import type { WorldIntelContext, WorldCoverage, LiquidityContext, GovFlowContext, ThaiGovFlowContext } from '../analysis/regime-analyzer.js'
import { readProvenance, coverageIsComplete, absenceCaveat, type ProvenanceRecord } from '@common/types'

/**
 * How old a provenance record may be before its verdicts stop being assertable.
 * The producer writes one per pipeline run (daily), so a record older than a day
 * plus slack means nobody has checked since — which is UNKNOWN, not healthy.
 */
const PROVENANCE_MAX_AGE_HOURS = 30
import { analyzePropagation } from '../analysis/propagation-analyzer.js'
import { analyzePeople } from '../analysis/people-analyzer.js'
import { exportAnalysis } from '../export/exporter.js'
import { exportPeopleEvents } from '../export/people-exporter.js'
import { generateReport } from '../export/reporter.js'
import type { GraphJSON } from '../types.js'

const DATA_DIR              = join(process.cwd(), 'data')
const REPORTS_DIR           = join(DATA_DIR, 'reports')
const GRAPH_PATH            = join(process.cwd(), '../dependency-graph-engine/data/graph.json')
const STOCK_INTEL_PATH      = join(process.cwd(), '../world-intelligence-data-hub-/exports/stock-project/intelligence.json')
const WORLD_INTEL_ROOT      = join(process.cwd(), '../world-intelligence-data-hub-')
const WORLD_INTEL_PATH      = join(WORLD_INTEL_ROOT, 'exports/world-map/intelligence.json')
const MACRO_PATH            = join(process.cwd(), '../macro-asset-monitor/data/macro.json')
const GOV_FLOW_PATH         = join(process.cwd(), '../government-flow-monitor/data/govflow.json')
const THAI_GOV_FLOW_PATH    = join(process.cwd(), '../government-flow-monitor/data/thai-govflow.json')
const PORTFOLIO_TICKERS_PATH = join(process.cwd(), '../scenario-simulator/data/portfolio-tickers.json')
const PEOPLE_WINDOW_DAYS    = 7

function loadMacroAssets(): import('../analysis/regime-analyzer.js').MacroContext | undefined {
  try {
    if (!existsSync(MACRO_PATH)) return undefined
    return JSON.parse(readFileSync(MACRO_PATH, 'utf-8'))
  } catch {
    console.log('  macro.json not available, running without macro asset context')
    return undefined
  }
}

function loadLiquidityContext(): LiquidityContext | undefined {
  try {
    if (!existsSync(MACRO_PATH)) return undefined
    const macro = JSON.parse(readFileSync(MACRO_PATH, 'utf-8'))
    const indicators = macro.liquidityIndicators
    if (!Array.isArray(indicators) || indicators.length === 0) return undefined
    return {
      asOf: macro.asOf,
      indicators: indicators.map((ind: any) => ({
        seriesId:  ind.seriesId,
        label:     ind.label,
        value:     ind.value,
        unit:      ind.unit,
        change4w:  ind.change4w  ?? null,
        changeYoY: ind.changeYoY ?? null,
        signal:    ind.signal,
      })),
    }
  } catch {
    return undefined
  }
}

function loadGovFlow(): GovFlowContext | undefined {
  try {
    if (!existsSync(GOV_FLOW_PATH)) return undefined
    return JSON.parse(readFileSync(GOV_FLOW_PATH, 'utf-8'))
  } catch { return undefined }
}

function loadThaiGovFlow(): ThaiGovFlowContext | undefined {
  try {
    if (!existsSync(THAI_GOV_FLOW_PATH)) return undefined
    return JSON.parse(readFileSync(THAI_GOV_FLOW_PATH, 'utf-8'))
  } catch { return undefined }
}

function loadPortfolioTickers(): string[] {
  try {
    if (!existsSync(PORTFOLIO_TICKERS_PATH)) return []
    const arr = JSON.parse(readFileSync(PORTFOLIO_TICKERS_PATH, 'utf-8'))
    if (!Array.isArray(arr)) return []
    // Filter out cash/commodity/fund pseudo-tickers — keep tradable equities only.
    // News pipeline ingests by exchange ticker; CASH_*, GOLD_OZ, *.BK, K-*, KFINDIA-*, SCBCEH, PFM* are skipped.
    const skipPrefixes  = ['CASH_', 'GOLD_', 'K-', 'KFINDIA', 'PFM']
    const skipSuffixes  = ['.BK']
    const skipExact     = new Set(['SCBCEH'])
    return arr.filter((t): t is string => {
      if (typeof t !== 'string') return false
      if (skipExact.has(t)) return false
      if (skipPrefixes.some(p => t.startsWith(p))) return false
      if (skipSuffixes.some(s => t.endsWith(s))) return false
      return true
    })
  } catch {
    return []
  }
}

/**
 * Source coverage behind the events. Read at ANALYSIS time, not export time, so
 * a provenance record that has itself gone stale cannot present its verdicts as
 * current — the classification is an observation with an age like any other.
 */
export function loadCoverage(): WorldCoverage {
  try {
    const p = join(WORLD_INTEL_ROOT, 'quota', 'freshness.json')
    const record = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as ProvenanceRecord : null
    const r = readProvenance(record, new Date(), PROVENANCE_MAX_AGE_HOURS)
    return {
      complete: coverageIsComplete(r.sources),
      summary:  r.summary,
      caveat:   absenceCaveat(r.sources),
      sources:  r.sources,
    }
  } catch {
    // Unreadable provenance is UNKNOWN coverage, never assumed-complete.
    return { complete: false, summary: 'world-intel coverage unknown: provenance record unreadable',
             caveat: 'events may be MISSING rather than absent — the provenance record could not be read', sources: [] }
  }
}

function loadWorldIntel(): WorldIntelContext | undefined {
  try {
    if (!existsSync(STOCK_INTEL_PATH) || !existsSync(WORLD_INTEL_PATH)) return undefined
    const stock = JSON.parse(readFileSync(STOCK_INTEL_PATH, 'utf-8'))
    const world = JSON.parse(readFileSync(WORLD_INTEL_PATH, 'utf-8'))
    return {
      marketEvents: stock.marketEvents ?? [],
      worldEvents:  world.events ?? [],
    }
  } catch {
    return undefined
  }
}

async function run() {
  const startTime = Date.now()

  mkdirSync(DATA_DIR,    { recursive: true })
  mkdirSync(REPORTS_DIR, { recursive: true })

  const graph: GraphJSON = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
  const store = createAnalysisStore(join(DATA_DIR, 'analysis.db'))
  const today = new Date().toISOString().slice(0, 10)

  console.log(`[${new Date().toISOString()}] Stage 1: collecting health for ${graph.nodes.length} companies...`)
  const health = await collectHealth(graph.nodes)
  const pos = health.filter(h => h.healthScore === 'positive').length
  const neg = health.filter(h => h.healthScore === 'negative').length
  const neu = health.filter(h => h.healthScore === 'neutral').length
  const ins = health.filter(h => h.healthScore === 'insufficient_data').length
  console.log(`  positive=${pos}  neutral=${neu}  negative=${neg}  insufficient=${ins}`)

  console.log(`[${new Date().toISOString()}] Stage 2a: classifying macro regime...`)
  const worldIntel = loadWorldIntel()
  if (worldIntel) {
    console.log(`  World intel: ${worldIntel.marketEvents.length} market events, ${worldIntel.worldEvents.length} world events`)
  } else {
    console.log('  World intel: not available (world-intelligence-data-hub exports missing)')
  }
  const macroAssets = loadMacroAssets()
  if (macroAssets) {
    console.log(`  Macro assets: ${macroAssets.marketAssets.length} assets, ${macroAssets.economicIndicators.length} indicators (as of ${macroAssets.asOf})`)
  } else {
    console.log('  Macro assets: not available')
  }
  const liquidityContext = loadLiquidityContext()
  if (liquidityContext) {
    console.log(`  Liquidity: ${liquidityContext.indicators.length} indicators (as of ${liquidityContext.asOf})`)
  } else {
    console.log('  Liquidity: not available')
  }
  const govFlowContext = loadGovFlow()
  if (govFlowContext) {
    console.log(`  Gov flow: ${govFlowContext.watchlistAwards.length} companies, ${govFlowContext.budgetSignals.length} budget signals (as of ${govFlowContext.asOf})`)
  }

  const thaiGovFlow = loadThaiGovFlow()
  if (thaiGovFlow) {
    const newAwards = thaiGovFlow.contractors.filter(c => c.newProjects > 0 || c.newContractTHB > 0).length
    console.log(`  Thai gov flow: ${thaiGovFlow.contractors.length} contractors, ${newAwards} with new awards (as of ${thaiGovFlow.asOf})`)
  } else {
    console.log('  Gov flow: not available')
  }
  // Loaded SEPARATELY from the events: a failure to read the event exports must
  // not take the coverage statement with it.
  const worldCoverage = loadCoverage()
  const regime = await analyzeRegime(health, { worldIntel, worldCoverage, macroAssets, liquidityContext, govFlowContext, thaiGovFlow })
  store.insertRegime(regime)
  console.log(`  Regime: ${regime.regime} (${regime.confidence})`)

  console.log(`[${new Date().toISOString()}] Stage 2b: analyzing propagation signals...`)
  const signals = await analyzePropagation(regime, graph, health)
  for (const s of signals) store.insertSignal(s)
  console.log(`  ${signals.length} propagation signal(s)`)

  console.log(`[${new Date().toISOString()}] Stage 2c: extracting key-people events...`)
  const portfolioTickers = loadPortfolioTickers()
  if (portfolioTickers.length === 0) {
    console.log('  Portfolio tickers list not available — skipping people extraction')
  } else {
    console.log(`  Scanning ${portfolioTickers.length} portfolio tickers over last ${PEOPLE_WINDOW_DAYS} days`)
  }
  const peopleEvents = portfolioTickers.length > 0
    ? await analyzePeople({ portfolioTickers, days: PEOPLE_WINDOW_DAYS })
    : []
  exportPeopleEvents(peopleEvents, {
    windowDays: PEOPLE_WINDOW_DAYS,
    tickers:    portfolioTickers,
    outputPath: join(DATA_DIR, 'people-events.json'),
  })

  exportAnalysis(store, health, join(DATA_DIR, 'analysis.json'))

  const reportPath = join(REPORTS_DIR, `${today}.md`)
  generateReport(today, regime, signals, health, reportPath)

  store.insertRun({
    id: randomUUID(), date: today,
    companiesAnalyzed: health.length,
    regimeId: regime.id,
    propagationSignalCount: signals.length,
    durationMs: Date.now() - startTime,
    createdAt: new Date().toISOString(),
  })

  store.close()
  console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
  console.log(`Report: ${reportPath}`)
}

run().catch(err => { console.error(err); process.exit(1) })
