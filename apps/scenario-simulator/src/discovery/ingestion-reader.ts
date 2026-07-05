import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import type { DiscoveryCandidate } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../../../capital-intelligence-ingestion/data/sqlite.db')

export interface NewsRow {
  ticker: string
  company: string
  content: string
  publishedDate: string
}

export class IngestionReader {
  private db: Database.Database

  constructor(dbPath: string = DB_PATH) {
    if (!existsSync(dbPath)) {
      throw new Error(`Ingestion DB not found: ${dbPath}`)
    }
    this.db = new Database(dbPath, { readonly: true })
  }

  getTrackedTickers(excludeTickers: string[]): DiscoveryCandidate[] {
    let sql: string
    let params: string[]
    if (excludeTickers.length > 0) {
      const placeholders = excludeTickers.map(() => '?').join(',')
      sql = `SELECT ticker, company FROM watchlist WHERE active = 1 AND ticker NOT IN (${placeholders})`
      params = excludeTickers
    } else {
      sql = `SELECT ticker, company FROM watchlist WHERE active = 1`
      params = []
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ ticker: string; company: string }>
    return rows.map(row => ({
      ticker: row.ticker,
      company: row.company,
      source: 'companies_table' as const,
      newsSnippet: null,
    }))
  }

  getRecentNews(_daysBack: number): NewsRow[] {
    // News content is stored in LanceDB (vector store), not SQLite — return empty here;
    // discovery runs on watchlist candidates only.
    return []
  }

  close(): void {
    this.db.close()
  }
}
