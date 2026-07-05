import fs from 'fs'
import path from 'path'
import type { AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON, DiscoveryJSON, MacroJSON, WavesJSON, WaveActionsJSON, WavePortfolioJSON, GovFlowJSON } from '@/types'

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
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

export function readProfile(): string {
  const p = path.join(dataRoot(), 'investment-analyst-agents/knowledge/profile.md')
  if (!fs.existsSync(p)) return ''
  return fs.readFileSync(p, 'utf-8')
}

export function qaArchivePath(): string {
  return path.join(dataRoot(), 'investment-analyst-agents/archive/qa.jsonl')
}

export function readDiscovery(): DiscoveryJSON | null {
  const filePath = path.join(dataRoot(), 'scenario-simulator', 'data', 'discovery.json')
  try {
    return readJSON<DiscoveryJSON>(filePath)
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
