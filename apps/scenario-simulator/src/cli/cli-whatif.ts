import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createSimulationStore } from '../store/sqlite.js'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices } from '../portfolio/price-fetcher.js'
import { generateScenarios } from '../simulation/scenario-generator.js'
import { generateActions } from '../simulation/action-generator.js'
import { exportSimulation } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { AnalysisJSON, GraphJSON } from '../types.js'

const DATA_DIR      = join(process.cwd(), 'data')
const REPORTS_DIR   = join(DATA_DIR, 'reports')
const ANALYSIS_PATH = join(process.cwd(), '../ai-analysis-engine/data/analysis.json')
const GRAPH_PATH    = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

const args        = process.argv.slice(2)
const triggerIdx  = args.findIndex(a => a === '--trigger')
const trigger     = triggerIdx !== -1
  ? args[triggerIdx + 1]
  : args.find(a => a.startsWith('--trigger='))?.split('=').slice(1).join('=')

if (!trigger) {
  console.error('Usage: npm run whatif -- --trigger "TSMC cuts 2nm capacity by 30%"')
  process.exit(1)
}

async function run() {
  const startTime = Date.now()
  mkdirSync(DATA_DIR,    { recursive: true })
  mkdirSync(REPORTS_DIR, { recursive: true })

  const analysis: AnalysisJSON = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf-8'))
  const graph: GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))

  const portfolioStore = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))
  const simStore       = createSimulationStore(join(DATA_DIR, 'simulation.db'))

  try {
    const positions = await portfolioStore.getPositions()
    if (positions.length > 0) {
      const symbols = positions
        .filter(p => p.assetClass !== 'cash' && p.priceSymbol)
        .map(p => p.priceSymbol)
      const prices = await fetchPrices(symbols)
      for (const p of positions) if (p.assetClass === 'cash') prices[p.ticker] = 1
      if (Object.keys(prices).length > 0) await portfolioStore.updatePrices(prices)
    }

    const runId = randomUUID()
    const today = new Date().toISOString().slice(0, 10)

    console.log(`[${new Date().toISOString()}] What-if: "${trigger}"`)
    const scenarios = await generateScenarios(analysis, graph, { trigger: trigger as string, runId })
    for (const s of scenarios) simStore.insertScenario(s)

    const freshPositions = await portfolioStore.getPositions()
    let actions: Awaited<ReturnType<typeof generateActions>> = []

    if (freshPositions.length > 0) {
      actions = await generateActions(scenarios, freshPositions, { runId })
      for (const a of actions) simStore.insertAction(a)
    }

    simStore.insertRun({
      id: runId, date: today, type: 'whatif', trigger: trigger ?? null,
      scenarioCount: scenarios.length, actionCount: actions.length,
      durationMs: Date.now() - startTime, createdAt: new Date().toISOString(),
    })

    await exportSimulation(simStore, portfolioStore, join(DATA_DIR, 'simulation.json'))
    const reportPath = join(REPORTS_DIR, `${today}-whatif.md`)
    generateReport(today, scenarios, actions, freshPositions, reportPath)

    console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
    console.log(`Report: ${reportPath}`)
  } finally {
    simStore.close()
    await portfolioStore.close()
  }
}

run().catch(err => { console.error(err); process.exit(1) })
