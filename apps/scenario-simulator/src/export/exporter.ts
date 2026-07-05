import { writeFileSync } from 'fs'
import type { SimulationStore } from '../store/sqlite.js'
import type { PortfolioStore } from '../portfolio/portfolio-store.js'
import type { SimulationJSON } from '../types.js'
import { fetchPricesAndFx } from '../portfolio/price-fetcher.js'

export async function exportSimulation(
  simStore: SimulationStore,
  portfolioStore: PortfolioStore,
  outputPath: string,
): Promise<SimulationJSON> {
  const run = simStore.getLatestRun()
  if (!run) throw new Error('No simulation found — run npm run simulate first')

  const scenarios = simStore.getScenariosByRunId(run.id)
  const actions   = simStore.getActionsByRunId(run.id)
  const portfolio = await portfolioStore.getPositions()

  // Include USD/THB FX rate when any THB-denominated asset is held.
  let usdThb: number | null = null
  const hasThb = portfolio.some(p => p.currency === 'THB')
  if (hasThb) {
    const fx = await fetchPricesAndFx([], { includeFx: true })
    usdThb = fx.usdThb
  }

  const json: SimulationJSON = {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    portfolio,
    scenarios,
    actions,
    usdThb,
  }

  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8')
  return json
}
