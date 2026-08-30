import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { coverageIsComplete, absenceCaveat, classifyArticleSources, withDomain,
  type FeedRegistryEntry, type FeedHealthEntry, type CollectionMetrics } from '@common/types'

/** A provenance record older than a day plus slack means nobody has checked since. */
import Database from 'better-sqlite3'
import type {
  ContextBundle, AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON,
  PeopleEvent, PeopleEventsJSON, MacroSnapshot,
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
  macroPath?:            string
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
  macroPath:             join(process.cwd(), '../macro-asset-monitor/data/macro.json'),
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
  decayWindowPredictions?: number
  decaying?: Array<{
    signal:          string
    allTimeAccuracy: number
    recentAccuracy:  number
    allTimeCalls:    number
    recentCalls:     number
  }>
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
  portfolioValueUSD:   number   // priced/analyzed subset only — NOT net worth
  netWorthUSD?:        number | null   // whole book incl. cash + unpriced holdings
  analyzedValueUSD?:   number | null   // explicit alias of the priced subset
  coverageOfNetWorth?: number | null   // analyzedValueUSD / netWorthUSD
  cashUSD?:            number | null
  unpricedUSD?:        number | null
  unpricedTickers?:    string[]
  portfolioVolatility: number
  portfolioReturn:     number
  sharpeRatio:         number
  maxDrawdown:         number
  oneDayVAR95:         number
  portfolioBeta:       number
  perTicker:           Array<{ ticker: string; weight: number; weightOfNetWorth?: number | null; volatility: number; totalReturn: number; beta: number; correlation: number }>
  summary:             string
}

function loadRisk(path: string): RiskSnapshot | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as RiskSnapshot }
  catch { return null }
}

function loadMacro(path: string): MacroSnapshot | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as MacroSnapshot }
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

  // Source coverage behind those events, evaluated at READ time so a provenance
  // record that has itself gone stale cannot assert its verdicts as current.
  // Without this the briefing cannot tell "nothing happened" from "we could not
  // see what happened" — which on 2026-08-29 was the live condition.
  // DOMAIN-CORRECT: the briefing's world events come from world-map/intelligence.json,
  // which is article-derived (12 RSS feeds). Coverage previously came from
  // quota/freshness.json — gdelt/acled/eia/worldbank/ucdp — sources the briefing
  // does not consume, so it warned about irrelevant evidence while real feed
  // degradation was invisible.
  const worldCoverage = (() => {
    const unknown = (why: string) => ({
      complete: false, summary: `world-intel article coverage unknown: ${why}`,
      caveat: 'events may be MISSING rather than absent — article feed health could not be established',
      sources: [] as ReturnType<typeof classifyArticleSources>,
    })
    try {
      const hub = join(dirname(p.worldIntelPath), '..', '..')
      const registryPath = join(hub, 'intelligence', 'sources', 'sources.json')
      if (!existsSync(registryPath)) return unknown('article source registry not found')
      const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as unknown
      const registry = (Array.isArray(raw) ? raw : (raw as { sources?: unknown[] })?.sources ?? []) as FeedRegistryEntry[]
      if (!Array.isArray(registry) || registry.length === 0) return unknown('article source registry is empty or malformed')

      const healthPath = join(hub, 'intelligence', 'sources', 'source-health.json')
      const health = existsSync(healthPath)
        ? JSON.parse(readFileSync(healthPath, 'utf-8')) as Record<string, FeedHealthEntry>
        : {}

      let metrics: CollectionMetrics | null = null
      const metricsDir = join(hub, 'intelligence', 'metrics')
      if (existsSync(metricsDir)) {
        const days = readdirSync(metricsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
        const latest = days[days.length - 1]
        if (latest) {
          const rec = JSON.parse(readFileSync(join(metricsDir, latest), 'utf-8')) as { collection?: CollectionMetrics }
          metrics = rec?.collection ?? null
        }
      }

      const sources = withDomain(classifyArticleSources({ registry, health, metrics, now: new Date() }), 'article_intelligence')
      if (sources.length === 0) return unknown('no enabled article feeds in the registry')
      const degraded = sources.filter(s => s.availability !== 'current')
      return {
        complete: coverageIsComplete(sources),
        summary: degraded.length === 0 ? 'article coverage complete'
          : `article coverage degraded: ${degraded.map(s => `${s.source} ${s.availability}`).join(', ')}`,
        caveat: absenceCaveat(sources),
        sources,
      }
    } catch {
      return unknown('article coverage records unreadable')
    }
  })()

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
  const macro               = loadMacro(p.macroPath)
  const correlationReport  = loadCorrelationReport(p.correlationReportPath)

  return { date, analysis, simulation, graph, stockIntel, worldIntel, worldCoverage, profile, profileMissing, thesisSummary, peopleEvents, calibration, taxHarvest, risk, macro, correlationReport }
}
