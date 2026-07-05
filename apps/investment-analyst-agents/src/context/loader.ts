import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type {
  ContextBundle, AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON,
  PeopleEvent, PeopleEventsJSON,
} from '../types.js'

interface LoaderPaths {
  analysisPath?:     string
  simulationPath?:   string
  graphPath?:        string
  stockIntelPath?:   string
  worldIntelPath?:   string
  profilePath?:      string
  thesisDbPath?:     string
  peopleEventsPath?: string
  calibrationPath?:      string
  taxHarvestPath?:       string
  riskPath?:             string
  correlationReportPath?: string
}

const defaults = () => ({
  analysisPath:     join(process.cwd(), '../ai-analysis-engine/data/analysis.json'),
  simulationPath:   join(process.cwd(), '../scenario-simulator/data/simulation.json'),
  graphPath:        join(process.cwd(), '../dependency-graph-engine/data/graph.json'),
  stockIntelPath:   join(process.cwd(), '../world-intelligence-data-hub-/exports/stock-project/intelligence.json'),
  worldIntelPath:   join(process.cwd(), '../world-intelligence-data-hub-/exports/world-map/intelligence.json'),
  profilePath:      join(process.cwd(), 'knowledge/profile.md'),
  thesisDbPath:     join(process.cwd(), '../thesis-memory/data/thesis.db'),
  peopleEventsPath: join(process.cwd(), '../ai-analysis-engine/data/people-events.json'),
  calibrationPath:       join(process.cwd(), 'backtest/calibration.json'),
  taxHarvestPath:        join(process.cwd(), 'tax/harvest.json'),
  riskPath:              join(process.cwd(), 'risk/risk.json'),
  correlationReportPath: join(process.cwd(), 'correlation/report.md'),
})

interface CalibrationJSON {
  generatedAt:          string
  predictionsAnalyzed:  number
  scoredCalls:          number
  windows:              number[]
  byAction:             Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  byConviction:         Record<string, Record<string, { accuracy: number; calls: number; avgReturn: number }>>
  calibrationInverted:  boolean
  highConvictionPenalty:number
  bestEdge:             { signal: string; accuracy: number } | null
  worstSignal:          { signal: string; accuracy: number } | null
}

function loadCalibration(path: string): CalibrationJSON | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as CalibrationJSON }
  catch { return null }
}

interface TaxHarvestSnapshot {
  schemaVersion:    string
  generatedAt:      string
  realizedYTD: { gainsUSD: number; lossesUSD: number; netTaxableUSD: number; trades: number }
  harvestOpportunities: Array<{
    ticker: string; strategy: string; taxJurisdiction: string;
    unrealizedLossUSD: number; harvestable: boolean; washSaleRisk: boolean; notes: string
  }>
  washSaleAlerts: Array<{
    ticker: string; soldAt: string; doNotRebuyBefore: string; daysRemaining: number
  }>
  summary: string
}

function loadTaxHarvest(path: string): TaxHarvestSnapshot | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as TaxHarvestSnapshot }
  catch { return null }
}

interface RiskSnapshot {
  schemaVersion:       string
  generatedAt:         string
  windowDays:          number
  benchmark:           string
  portfolioValueUSD:   number
  portfolioVolatility: number
  portfolioReturn:     number
  sharpeRatio:         number
  maxDrawdown:         number
  oneDayVAR95:         number
  portfolioBeta:       number
  perTicker:           Array<{ ticker: string; weight: number; volatility: number; totalReturn: number; beta: number; correlation: number }>
  summary:             string
}

function loadRisk(path: string): RiskSnapshot | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as RiskSnapshot }
  catch { return null }
}

function loadCorrelationReport(path: string): string | null {
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf-8') }
  catch { return null }
}

function loadThesisSummary(dbPath: string): string {
  if (!existsSync(dbPath)) return ''
  try {
    const db = new Database(dbPath, { readonly: true })
    const theses = db.prepare(
      `SELECT id, ticker, type, position_size FROM theses ORDER BY updated_at DESC`
    ).all() as { id: string; ticker: string; type: string; position_size: string }[]
    if (theses.length === 0) { db.close(); return '' }
    const lines = theses.map(t => {
      const assumptions = db.prepare(
        `SELECT label, status FROM assumptions WHERE thesis_id = ? ORDER BY updated_at DESC LIMIT 4`
      ).all(t.id) as { label: string; status: string }[]
      const assumptionLine = assumptions.map(a => `    - ${a.label}: ${a.status}`).join('\n')
      return `  ${t.ticker} (${t.type}, ${t.position_size}):\n${assumptionLine || '    (no assumptions)'}`
    }).join('\n')
    db.close()
    return lines
  } catch {
    return ''
  }
}

function loadPeopleEvents(path: string): PeopleEvent[] {
  if (!existsSync(path)) return []
  try {
    const data: PeopleEventsJSON = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(data.events) ? data.events : []
  } catch (err) {
    console.warn(`⚠ Failed to read people-events.json at ${path}:`, err instanceof Error ? err.message : err)
    return []
  }
}

export function loadContext(date: string, paths: LoaderPaths = {}): ContextBundle {
  const p = { ...defaults(), ...paths }

  const analysis:   AnalysisJSON   = JSON.parse(readFileSync(p.analysisPath, 'utf-8'))
  const simulation: SimulationJSON = JSON.parse(readFileSync(p.simulationPath, 'utf-8'))
  const graph:      GraphJSON      = JSON.parse(readFileSync(p.graphPath, 'utf-8'))
  const stockIntel: StockIntelJSON = JSON.parse(readFileSync(p.stockIntelPath, 'utf-8'))
  const worldIntel: WorldIntelJSON = JSON.parse(readFileSync(p.worldIntelPath, 'utf-8'))

  // Warn (don't fail) on schema version mismatch so the briefing keeps running
  // even if an upstream project ships an old format. Visible in stderr only.
  const EXPECTED = '1.0'
  for (const [name, json] of Object.entries({ analysis, simulation, graph })) {
    const v = (json as { schemaVersion?: string }).schemaVersion
    if (v && v !== EXPECTED) {
      console.warn(`⚠ ${name}.json schema version ${v} != expected ${EXPECTED} — output may be malformed`)
    }
  }

  let profile        = ''
  let profileMissing = false
  if (existsSync(p.profilePath)) {
    profile = readFileSync(p.profilePath, 'utf-8')
  } else {
    profileMissing = true
    console.warn('⚠ No profile found at knowledge/profile.md — proceeding without personal context')
  }

  const thesisSummary = loadThesisSummary(p.thesisDbPath)
  const peopleEvents  = loadPeopleEvents(p.peopleEventsPath)
  const calibration        = loadCalibration(p.calibrationPath)
  const taxHarvest         = loadTaxHarvest(p.taxHarvestPath)
  const risk               = loadRisk(p.riskPath)
  const correlationReport  = loadCorrelationReport(p.correlationReportPath)

  return { date, analysis, simulation, graph, stockIntel, worldIntel, profile, profileMissing, thesisSummary, peopleEvents, calibration, taxHarvest, risk, correlationReport }
}
