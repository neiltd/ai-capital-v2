import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import type { DiscoveryExportCandidate, DiscoveryPosition, DiscoveryClosedPosition, DiscoveryScenario, DiscoveryAction, DiscoveryJSON } from './types.js'

export interface ExportInput {
  candidates: DiscoveryExportCandidate[]
  discoveryPortfolio: DiscoveryPosition[]
  closedPositions: DiscoveryClosedPosition[]
  scenarios: DiscoveryScenario[]
  actions: DiscoveryAction[]
  config: {
    threshold: number
    paperBudget: number
    cashReservePct: number
    newsDays: number
  }
}

export function exportDiscovery(input: ExportInput, outPath: string): void {
  const output: DiscoveryJSON = {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    config: input.config,
    candidates: input.candidates,
    discoveryPortfolio: input.discoveryPortfolio,
    closedPositions: input.closedPositions,
    scenarios: input.scenarios,
    actions: input.actions,
  }
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8')
}
