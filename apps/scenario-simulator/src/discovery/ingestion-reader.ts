import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { usePostgres, getPool, closePool } from '@common/db'
import type { DiscoveryCandidate } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../../../capital-intelligence-ingestion/data/sqlite.db')

export interface NewsRow {
  ticker: string
  company: string
  content: string
  publishedDate: string
}

// Watchlist lives in Postgres (capital.watchlist) once DATABASE_URL is set —
// same usePostgres()-gated pattern as risk-runner.ts et al. The SQLite path
// below is the local-dev fallback only; it previously always read the frozen
// capital-intelligence-ingestion/data/sqlite.db regardless of which store was
// actually live.
export class IngestionReader {
  private db: Database.Database | null = null
  private usingPg: boolean

  constructor(dbPath: string = DB_PATH) {
    this.usingPg = usePostgres()
    if (this.usingPg) return
    if (!existsSync(dbPath)) {
      throw new Error(`Ingestion DB not found: ${dbPath}`)
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true })
  }

  async getTrackedTickers(excludeTickers: string[]): Promise<DiscoveryCandidate[]> {
    if (this.usingPg) {
      const pool = getPool()
      const { rows } = excludeTickers.length > 0
        ? await pool.query<{ ticker: string; company: string }>(
            'SELECT ticker, company FROM capital.watchlist WHERE active = TRUE AND ticker != ALL($1)',
            [excludeTickers],
          )
        : await pool.query<{ ticker: string; company: string }>(
            'SELECT ticker, company FROM capital.watchlist WHERE active = TRUE',
          )
      return rows.map(row => ({
        ticker: row.ticker,
        company: row.company,
        source: 'companies_table' as const,
        newsSnippet: null,
      }))
    }

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
    const rows = this.db!.prepare(sql).all(...params) as Array<{ ticker: string; company: string }>
    return rows.map(row => ({
      ticker: row.ticker,
      company: row.company,
      source: 'companies_table' as const,
      newsSnippet: null,
    }))
  }

  getRecentNews(_daysBack: number): NewsRow[] {
    // News content is stored in LanceDB/pgvector, not the relational store; return
    // empty here — discovery runs on watchlist candidates only.
    return []
  }

  async close(): Promise<void> {
    if (this.usingPg) {
      // Shared pool — closed centrally by the CLI's main() via closePool(), not here.
      return
    }
    this.db!.close()
  }
}

export { closePool }
