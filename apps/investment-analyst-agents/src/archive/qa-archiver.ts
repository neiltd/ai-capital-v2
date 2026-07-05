import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { getPool, usePostgres } from '@common/db'
import type { QAEntry } from '../types.js'

/**
 * Archives one Q&A session. Backend switched by env:
 *   DATABASE_URL set  → INSERT INTO briefing.qa
 *   otherwise         → append-line to JSONL at archivePath (legacy path)
 */
export async function archiveQA(entry: QAEntry, archivePath: string): Promise<void> {
  if (usePostgres()) {
    await getPool().query(
      `INSERT INTO briefing.qa (date, asked_at, mode, exchanges)
       VALUES ($1, $2, $3, $4)`,
      [entry.date, entry.timestamp, entry.mode, JSON.stringify(entry.exchanges)],
    )
    return
  }

  mkdirSync(dirname(archivePath), { recursive: true })
  appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')
}
