import 'dotenv/config'
import cron from 'node-cron'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createAnalysisStore } from '../store/sqlite.js'
import { collectHealth } from '../collector/health-collector.js'
import { analyzeRegime } from '../analysis/regime-analyzer.js'
import { analyzePropagation } from '../analysis/propagation-analyzer.js'
import { exportAnalysis } from '../export/exporter.js'
import { generateReport } from '../export/reporter.js'
import type { GraphJSON } from '../types.js'

const DATA_DIR    = join(process.cwd(), 'data')
const REPORTS_DIR = join(DATA_DIR, 'reports')
const GRAPH_PATH  = join(process.cwd(), '../dependency-graph-engine/data/graph.json')

async function runAnalysis() {
  const startTime = Date.now()
  const graph: GraphJSON = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
  const store = createAnalysisStore(join(DATA_DIR, 'analysis.db'))
  const today = new Date().toISOString().slice(0, 10)

  try {
    const health  = await collectHealth(graph.nodes)
    const regime  = await analyzeRegime(health)
    store.insertRegime(regime)
    const signals = await analyzePropagation(regime, graph, health)
    for (const s of signals) store.insertSignal(s)
    exportAnalysis(store, health, join(DATA_DIR, 'analysis.json'))
    generateReport(today, regime, signals, health, join(REPORTS_DIR, `${today}.md`))
    store.insertRun({
      id: randomUUID(), date: today,
      companiesAnalyzed: health.length,
      regimeId: regime.id,
      propagationSignalCount: signals.length,
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    })
    console.log(`[${new Date().toISOString()}] Analysis complete: ${regime.regime} (${regime.confidence}), ${signals.length} signals`)
  } finally {
    store.close()
  }
}

mkdirSync(DATA_DIR,    { recursive: true })
mkdirSync(REPORTS_DIR, { recursive: true })

console.log('AI Analysis Engine scheduler started. Running daily at 06:00.')
cron.schedule('0 6 * * *', () => {
  runAnalysis().catch(err => console.error('Analysis failed:', err))
})
