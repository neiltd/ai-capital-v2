import 'dotenv/config'
import cron from 'node-cron'
import { spawn } from 'child_process'
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

async function runAnalysis() {
  const startTime = Date.now()
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

    const runId      = randomUUID()
    const today      = new Date().toISOString().slice(0, 10)
    const scenarios  = await generateScenarios(analysis, graph, { runId })
    for (const s of scenarios) simStore.insertScenario(s)

    const freshPositions = await portfolioStore.getPositions()
    let actions: Awaited<ReturnType<typeof generateActions>> = []
    if (freshPositions.length > 0) {
      actions = await generateActions(scenarios, freshPositions, { runId })
      for (const a of actions) simStore.insertAction(a)
    }

    simStore.insertRun({
      id: runId, date: today, type: 'daily', trigger: null,
      scenarioCount: scenarios.length, actionCount: actions.length,
      durationMs: Date.now() - startTime, createdAt: new Date().toISOString(),
    })

    await exportSimulation(simStore, portfolioStore, join(DATA_DIR, 'simulation.json'))
    generateReport(today, scenarios, actions, freshPositions, join(REPORTS_DIR, `${today}.md`))
    console.log(`[${new Date().toISOString()}] Simulation complete: ${scenarios.length} scenarios, ${actions.length} actions`)
  } finally {
    simStore.close()
    await portfolioStore.close()
  }
}

mkdirSync(DATA_DIR,    { recursive: true })
mkdirSync(REPORTS_DIR, { recursive: true })

console.log('Scenario Simulator scheduler started. Running daily at 06:30 (simulate) and 06:45 (discover).')
cron.schedule('30 6 * * *', () => {
  runAnalysis().catch(err => console.error('Simulation failed:', err))
})

cron.schedule('45 6 * * *', () => {
  console.log('[schedule] Running discovery...')
  const child = spawn('npx', ['tsx', 'src/cli/cli-discover.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  child.on('error', err => console.error('[schedule] discover error:', err))
  child.on('close', code => console.log(`[schedule] discover exited with code ${code}`))
})
