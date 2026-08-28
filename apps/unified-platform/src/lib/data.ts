import fs from 'fs'
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

export function readThresholdAlerts(): ThresholdAlertRecord[] {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', 'threshold-alerts.json')
  try {
    const file = readJSON<{ alerts?: ThresholdAlertRecord[] }>(filePath)
    if (!file?.alerts) return []
    // Newest first; active before resolved so what is live reads first.
    return [...file.alerts].sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
      b.last_observed_at.localeCompare(a.last_observed_at))
  } catch {
    return []
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
