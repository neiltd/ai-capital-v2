import { writeFileSync } from 'fs'
import type { AnalysisStore } from '../store/sqlite.js'
import type { CompanyHealth, AnalysisJSON } from '../types.js'

export function exportAnalysis(
  store: AnalysisStore,
  health: CompanyHealth[],
  outputPath: string,
): AnalysisJSON {
  const latestRegime = store.getLatestRegime()
  if (!latestRegime) throw new Error('No regime found — run npm run analyze first')

  const latestSignals = store.getSignalsByDate(latestRegime.date)

  const result: AnalysisJSON = {
    schemaVersion: '1.0',
    exportedAt:   new Date().toISOString(),
    latestRegime,
    latestSignals,
    companySummaries: health.map(h => ({
      ticker:        h.ticker,
      company:       h.company,
      healthScore:   h.healthScore,
      thesisSummary: h.thesisSummary,
    })),
  }

  writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8')
  return result
}
