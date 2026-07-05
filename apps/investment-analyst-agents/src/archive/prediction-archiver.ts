import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { getPool, usePostgres } from '@common/db'
import type { PredictionEntry } from '../types.js'

/**
 * Archives one briefing's prediction. Backend switched by env:
 *   DATABASE_URL set  → INSERT INTO briefing.predictions (ON CONFLICT date DO UPDATE)
 *   otherwise         → append-line to JSONL at archivePath (legacy path)
 *
 * The JSONL path is preserved as the function arg even when Postgres is
 * active, so callers don't have to branch — they just call this and the
 * right thing happens.
 */
export async function archivePrediction(entry: PredictionEntry, archivePath: string): Promise<void> {
  if (usePostgres()) {
    await getPool().query(
      `INSERT INTO briefing.predictions (date, regime, confidence, scenarios, actions)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date) DO UPDATE SET
         regime     = EXCLUDED.regime,
         confidence = EXCLUDED.confidence,
         scenarios  = EXCLUDED.scenarios,
         actions    = EXCLUDED.actions`,
      [entry.date, entry.regime, entry.confidence, JSON.stringify(entry.scenarios), JSON.stringify(entry.actions)],
    )
    return
  }

  mkdirSync(dirname(archivePath), { recursive: true })

  if (existsSync(archivePath)) {
    const lines = readFileSync(archivePath, 'utf-8').split('\n').filter(l => l.trim() !== '')
    let replaced = false
    const updated = lines.map(line => {
      try {
        const parsed = JSON.parse(line) as PredictionEntry
        if (parsed.date === entry.date) {
          replaced = true
          return JSON.stringify(entry)
        }
        return line
      } catch {
        return line
      }
    })
    if (replaced) {
      writeFileSync(archivePath, updated.join('\n') + '\n', 'utf-8')
      return
    }
  }

  appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')
}
