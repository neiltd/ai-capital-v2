import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { IngestionReader } from '../../src/discovery/ingestion-reader.js'

// We create a real temp SQLite file so IngestionReader can open it. Schema
// matches capital-intelligence-ingestion's actual `watchlist` table (see
// sqlite-store.ts) — this fixture previously used a `companies` table name
// that no longer exists in production, so every getTrackedTickers test
// errored with "no such table: watchlist" regardless of the assertions below.
function createTempDb(): { dbPath: string; db: Database.Database } {
  const dir = path.join(os.tmpdir(), `ingestion-reader-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'capital_intelligence.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE watchlist (
      ticker TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE raw_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT,
      company TEXT,
      source TEXT,
      content TEXT,
      published_date TEXT
    );
  `)
  return { dbPath, db }
}

describe('IngestionReader', () => {
  let dbPath: string
  let db: Database.Database
  let reader: IngestionReader

  beforeEach(() => {
    const temp = createTempDb()
    dbPath = temp.dbPath
    db = temp.db
  })

  afterEach(async () => {
    await reader?.close()
    db.close()
    rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('throws if DB file does not exist', () => {
      expect(() => new IngestionReader('/nonexistent/path/db.sqlite')).toThrow('Ingestion DB not found')
    })

    it('opens successfully with a valid DB path', () => {
      reader = new IngestionReader(dbPath)
      expect(reader).toBeDefined()
    })
  })

  describe('getTrackedTickers', () => {
    beforeEach(() => {
      db.exec(`
        INSERT INTO watchlist VALUES ('AAPL', 'Apple', 1);
        INSERT INTO watchlist VALUES ('NVDA', 'NVIDIA', 1);
        INSERT INTO watchlist VALUES ('OLD', 'Old Corp', 0);
      `)
      reader = new IngestionReader(dbPath)
    })

    it('returns active companies as DiscoveryCandidates', async () => {
      const result = await reader.getTrackedTickers([])
      expect(result).toHaveLength(2)
      expect(result[0].source).toBe('companies_table')
      expect(result[0].newsSnippet).toBeNull()
      const tickers = result.map(r => r.ticker)
      expect(tickers).toContain('AAPL')
      expect(tickers).toContain('NVDA')
    })

    it('excludes inactive companies (active = 0)', async () => {
      const result = await reader.getTrackedTickers([])
      const tickers = result.map(r => r.ticker)
      expect(tickers).not.toContain('OLD')
    })

    it('excludes tickers in the exclude list', async () => {
      const result = await reader.getTrackedTickers(['AAPL'])
      const tickers = result.map(r => r.ticker)
      expect(tickers).not.toContain('AAPL')
      expect(tickers).toContain('NVDA')
    })

    it('returns empty array when all tickers are excluded', async () => {
      const result = await reader.getTrackedTickers(['AAPL', 'NVDA'])
      expect(result).toHaveLength(0)
    })

    it('handles empty exclude list', async () => {
      const result = await reader.getTrackedTickers([])
      expect(result).toHaveLength(2)
    })
  })

  // getRecentNews is intentionally a no-op stub — news content lives in
  // LanceDB/pgvector, not the relational store (see the comment on
  // IngestionReader.getRecentNews). These tests assert that documented
  // behavior instead of a real-DB-query capability the code doesn't have.
  describe('getRecentNews', () => {
    beforeEach(() => {
      db.exec(`
        INSERT INTO raw_documents (ticker, company, source, content, published_date)
        VALUES ('NVDA', 'NVIDIA', 'news', 'Recent news about NVIDIA chips', date('now', '-1 days'));
      `)
      reader = new IngestionReader(dbPath)
    })

    it('always returns an empty array regardless of daysBack', () => {
      expect(reader.getRecentNews(7)).toEqual([])
      expect(reader.getRecentNews(0)).toEqual([])
    })
  })
})
