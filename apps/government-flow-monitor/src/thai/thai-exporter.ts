import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { ThaiGovFlowJSON, ThaiContractorFlow } from '../types.js'
import { fetchThaiGovFlow } from './thai-procurement-fetcher.js'

function loadPrevious(path: string): ThaiGovFlowJSON | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ThaiGovFlowJSON
  } catch {
    return null   // corrupt/old-schema snapshot — treat as no baseline
  }
}

export async function buildThaiGovFlow(previous: ThaiGovFlowJSON | null): Promise<ThaiGovFlowJSON> {
  const raw = await fetchThaiGovFlow()
  const prevByTicker = new Map((previous?.contractors ?? []).map(c => [c.ticker, c]))

  const contractors: ThaiContractorFlow[] = raw.map(r => {
    const p = prevByTicker.get(r.ticker)
    // First run (or newly-added watchlist name) has no baseline → deltas = 0.
    // Clamp at 0: a total should only ever grow, but guard against re-stated data.
    return {
      ...r,
      newProjects:    p ? Math.max(0, r.totalProjects - p.totalProjects) : 0,
      newContractTHB: p ? Math.max(0, r.totalContractTHB - p.totalContractTHB) : 0,
    }
  })

  return {
    exportedAt:   new Date().toISOString(),
    asOf:         new Date().toISOString().slice(0, 10),
    source:       'ACT Ai (procurement.actai.co) — Thai e-GP procurement data',
    previousAsOf: previous?.asOf ?? null,
    contractors,
  }
}

export async function exportThaiGovFlow(outputPath: string): Promise<ThaiGovFlowJSON> {
  const previous = loadPrevious(outputPath)
  const json = await buildThaiGovFlow(previous)

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8')

  // Surface the actual "flow" — any watchlist name that won new work since last run.
  const flowing = json.contractors.filter(c => c.newProjects > 0 || c.newContractTHB > 0)
  for (const c of flowing) {
    console.log(`[thai-govflow] ⚑ NEW STATE MONEY: ${c.ticker} +${c.newProjects} proj, +฿${(c.newContractTHB / 1e9).toFixed(2)}bn since ${json.previousAsOf}`)
  }
  return json
}
