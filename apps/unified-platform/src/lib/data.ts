import fs from 'fs'
import { readProvenance, classifyArticleSources, withDomain,
  type ProvenanceRecord, type SourceProvenance,
  type FeedRegistryEntry, type FeedHealthEntry, type CollectionMetrics } from '@common/types'
import path from 'path'
import type { AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON, DiscoveryJSON, DiscoveryPosition, MacroJSON, WavesJSON, WaveActionsJSON, WavePortfolioJSON, GovFlowJSON } from '@/types'
import type { RiskJSON, HarvestJSON } from '@/lib/next/types'
import type { BriefingJSON } from '@common/types'

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
}

/**
 * Today's date (YYYY-MM-DD) in the server's local timezone (en-CA formats as
 * ISO). Briefing files are named with the local calendar date; computing
 * "today" via toISOString() (UTC) rolled over at 5pm PT, making every evening
 * lookup ask for tomorrow's briefing and silently report it missing/stale.
 */
export function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA')
}

function readJSON<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Failed to parse JSON from ${filePath}`)
  }
}

export function readAnalysis(): AnalysisJSON {
  return readJSON<AnalysisJSON>(
    path.join(dataRoot(), 'ai-analysis-engine/data/analysis.json')
  )
}

export function readSimulation(): SimulationJSON {
  return readJSON<SimulationJSON>(
    path.join(dataRoot(), 'scenario-simulator/data/simulation.json')
  )
}

export function readGraph(): GraphJSON {
  return readJSON<GraphJSON>(
    path.join(dataRoot(), 'dependency-graph-engine/data/graph.json')
  )
}

export function readStockIntel(): StockIntelJSON {
  return readJSON<StockIntelJSON>(
    path.join(dataRoot(), 'world-intelligence-data-hub-/exports/stock-project/intelligence.json')
  )
}

export function readWorldIntel(): WorldIntelJSON {
  return readJSON<WorldIntelJSON>(
    path.join(dataRoot(), 'world-intelligence-data-hub-/exports/world-map/intelligence.json')
  )
}

export function readBriefing(date: string): string | null {
  const p = path.join(dataRoot(), `investment-analyst-agents/briefings/${date}.md`)
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf-8')
}

export function readBriefingJson(date: string): BriefingJSON | null {
  const p = path.join(dataRoot(), `investment-analyst-agents/briefings/${date}.json`)
  try {
    return readJSON<BriefingJSON>(p)
  } catch { return null }
}

/**
 * Dates (YYYY-MM-DD, newest first) that have an archived structured
 * briefing JSON — i.e. dates /today's date-picker may legitimately offer.
 * Deliberately checks for the `.json` sibling, not just the `.md`, since
 * the page needs the structured envelope (recommendedActions/regime/etc),
 * not just prose.
 */
export function listBriefingDates(): string[] {
  const dir = path.join(dataRoot(), 'investment-analyst-agents/briefings')
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export function readProfile(): string {
  const p = path.join(dataRoot(), 'investment-analyst-agents/knowledge/profile.md')
  if (!fs.existsSync(p)) return ''
  return fs.readFileSync(p, 'utf-8')
}

export function qaArchivePath(): string {
  return path.join(dataRoot(), 'investment-analyst-agents/archive/qa.jsonl')
}

/**
 * Threshold alert records — "this condition existed", not "a message was sent".
 *
 * These replaced `alert-state.json`, which existed only to stop LINE repeating
 * itself and which no surface read. The detector's output had nowhere to go, so
 * a muted channel silently consumed alerts. Read-only here, as everywhere.
 */
export interface ThresholdAlertRecord {
  alert_id: string
  rule_id: 'price_drop' | 'news_velocity'
  instrument: string
  direction: 'down' | 'up' | 'elevated'
  severity: 'info' | 'warning' | 'critical'
  observed_value: number
  threshold: number
  detected_at: string
  last_observed_at: string
  status: 'active' | 'resolved'
  resolved_at: string | null
  business_date: string
  evidence: Record<string, unknown>
}

/**
 * Per-source provenance — the pull surface that replaced the LINE stale-source
 * alert, now classified rather than a bare boolean.
 *
 * Evaluated at READ time: every time-dependent verdict is recomputed from
 * `lastSuccessfulFetch` against that source's OWN bound, so a persisted
 * "current" cannot outlive the bound it was measured against.
 * "Unavailable" and "all current" are different facts, and a missing export
 * means nobody has told us — not that every feed is healthy.
 */
export type FreshnessResult =
  | { ok: true; sources: SourceProvenance[]; classifiedAt: string; recordAgeHours: number | null; recordStale: boolean; summary: string }
  | { ok: false; error: string }

/** A record older than a day plus slack means nobody has checked since. */
export const PROVENANCE_MAX_AGE_HOURS = 30

export function readSourceFreshness(now: Date = new Date()): FreshnessResult {
  const filePath = path.join(dataRoot(), 'world-intelligence-data-hub-', 'quota', 'freshness.json')
  if (!fs.existsSync(filePath))
    return { ok: false, error: 'no provenance export yet — the world-intel pipeline has not written one' }
  try {
    const record = readJSON<ProvenanceRecord>(filePath)
    if (!record || !Array.isArray(record.sources))
      return { ok: false, error: "freshness.json is malformed: 'sources' is not an array" }
    const r = readProvenance(record, now, PROVENANCE_MAX_AGE_HOURS)
    // Degraded first — the point is that a dead feed is hard to miss.
    const order: Record<string, number> = { unavailable: 0, restricted: 1, unknown: 2, stale: 3, current: 4 }
    const sources = [...r.sources].sort((a, b) =>
      (order[a.availability] ?? 9) - (order[b.availability] ?? 9) || (b.ageHours ?? 0) - (a.ageHours ?? 0))
    return { ok: true, sources, classifiedAt: record.classifiedAt, recordAgeHours: r.recordAgeHours, recordStale: r.recordStale, summary: r.summary }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * ARTICLE-domain coverage, from the records the collector already writes.
 *
 * The four world surfaces and the analytical consumers read article-derived
 * intelligence (12 RSS feeds), not gdelt/acled/eia/worldbank/ucdp. Reporting the
 * structured/energy sources to them warned about evidence they never use while
 * hiding real feed degradation. This reads the collector's own registry, health
 * store and daily metrics — no new collection, no API call.
 */
export type ArticleCoverageResult =
  | { ok: true; sources: SourceProvenance[]; metricsDate: string | null }
  | { ok: false; error: string }

export function readArticleCoverage(now: Date = new Date()): ArticleCoverageResult {
  const hub = path.join(dataRoot(), 'world-intelligence-data-hub-')
  const registryPath = path.join(hub, 'intelligence', 'sources', 'sources.json')
  const healthPath   = path.join(hub, 'intelligence', 'sources', 'source-health.json')
  const metricsDir   = path.join(hub, 'intelligence', 'metrics')

  if (!fs.existsSync(registryPath))
    return { ok: false, error: 'no article source registry — intelligence/sources/sources.json is missing' }
  try {
    const raw = readJSON<unknown>(registryPath)
    const registry = (Array.isArray(raw) ? raw : (raw as { sources?: unknown[] })?.sources ?? []) as FeedRegistryEntry[]
    if (!Array.isArray(registry) || registry.length === 0)
      return { ok: false, error: 'article source registry is empty or malformed' }

    const health = fs.existsSync(healthPath)
      ? (readJSON<Record<string, FeedHealthEntry>>(healthPath) ?? {})
      : {}

    // Latest daily metrics record. Absent -> every feed classifies unknown,
    // which is the honest answer, not a healthy one.
    let metrics: CollectionMetrics | null = null
    let metricsDate: string | null = null
    if (fs.existsSync(metricsDir)) {
      const days = fs.readdirSync(metricsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
      const latest = days[days.length - 1]
      if (latest) {
        metricsDate = latest.replace('.json', '')
        const rec = readJSON<{ collection?: CollectionMetrics }>(path.join(metricsDir, latest))
        metrics = rec?.collection ?? null
      }
    }

    const sources = withDomain(
      classifyArticleSources({ registry, health, metrics, now }),
      'article_intelligence',
    )
    if (sources.length === 0) return { ok: false, error: 'no enabled article feeds in the registry' }
    const order: Record<string, number> = { unavailable: 0, unknown: 1, stale: 2, restricted: 3, current: 4 }
    sources.sort((a, b) => (order[a.availability] ?? 9) - (order[b.availability] ?? 9) || a.source.localeCompare(b.source))
    return { ok: true, sources, metricsDate }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Business day in the business timezone — matches the detector's own notion. */
export const BUSINESS_TIMEZONE = 'America/Los_Angeles'
export function businessToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE })
}

/**
 * A3 — "no alerts" and "the record is unreadable" are different facts and must
 * not render the same. The previous version caught everything and returned [],
 * so a corrupt authoritative store displayed as a clean day.
 */
export type ThresholdAlertsResult =
  | { ok: true; alerts: ThresholdAlertRecord[] }
  | { ok: false; error: string }

export function readThresholdAlerts(): ThresholdAlertsResult {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', 'threshold-alerts.json')
  if (!fs.existsSync(filePath)) return { ok: true, alerts: [] }   // genuinely nothing yet
  try {
    const file = readJSON<{ alerts?: ThresholdAlertRecord[] }>(filePath)
    if (!file || !Array.isArray(file.alerts))
      return { ok: false, error: "threshold-alerts.json is malformed: 'alerts' is not an array" }
    // Newest first; active before resolved so what is live reads first.
    const alerts = [...file.alerts].sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
      b.last_observed_at.localeCompare(a.last_observed_at))
    return { ok: true, alerts }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function readDiscovery(): DiscoveryJSON | null {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', 'discovery.json')
  try {
    return readJSON<DiscoveryJSON>(filePath)
  } catch {
    return null
  }
}

export interface DiscoveryCohortArchive {
  archivedAt: string
  reason: string
  positions: DiscoveryPosition[]
}

export function readDiscoveryCohortArchive(cohort: number): DiscoveryCohortArchive | null {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', `discovery-cohort-${cohort}-archive.json`)
  try {
    return readJSON<DiscoveryCohortArchive>(filePath)
  } catch {
    return null
  }
}

/** Doesn't exist until the first Sunday discovery run after calibration.ts landed. */
export function readDiscoveryCalibration(): unknown | null {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', 'discovery-calibration.json')
  try {
    return readJSON<unknown>(filePath)
  } catch {
    return null
  }
}

export function readMacro(): MacroJSON {
  return readJSON<MacroJSON>(
    path.join(dataRoot(), 'macro-asset-monitor/data/macro.json')
  )
}

export function readWaves(): WavesJSON | null {
  const filePath = path.join(dataRoot(), 'wave-analyzer/data/waves.json')
  try {
    return readJSON<WavesJSON>(filePath)
  } catch {
    return null
  }
}

export function readWaveActions(): WaveActionsJSON | null {
  try {
    const filePath = path.join(dataRoot(), 'wave-analyzer/data/wave-actions.json')
    return readJSON<WaveActionsJSON>(filePath)
  } catch { return null }
}

export function readWavePortfolio(): WavePortfolioJSON | null {
  try {
    const filePath = path.join(dataRoot(), 'wave-analyzer/data/wave-portfolio.json')
    return readJSON<WavePortfolioJSON>(filePath)
  } catch { return null }
}

export function readGovFlow(): GovFlowJSON | null {
  try {
    const filePath = path.join(dataRoot(), 'government-flow-monitor/data/govflow.json')
    return readJSON<GovFlowJSON>(filePath)
  } catch { return null }
}

export function readRisk(): RiskJSON | null {
  try {
    const filePath = path.join(dataRoot(), 'investment-analyst-agents/risk/risk.json')
    return readJSON<RiskJSON>(filePath)
  } catch { return null }
}

export function readHarvest(): HarvestJSON | null {
  try {
    const filePath = path.join(dataRoot(), 'investment-analyst-agents/tax/harvest.json')
    return readJSON<HarvestJSON>(filePath)
  } catch { return null }
}

/**
 * Net worth in USD, converting THB-native positions at the pipeline's own
 * FX rate. Positions carry their value in native currency (see the
 * 2026-07-05/06 CRWD-split + THB-summed-as-USD incidents) — never sum
 * `currentValue` directly across a mixed-currency portfolio.
 */
export function computeNetWorthUsd(sim: SimulationJSON): number {
  const usdThb = sim.usdThb ?? null
  return sim.portfolio.reduce((sum, p) => {
    if (typeof p.currentValue !== 'number') return sum
    const currency = p.currency ?? 'USD'
    if (currency === 'THB' && usdThb) return sum + p.currentValue / usdThb
    return sum + p.currentValue
  }, 0)
}
