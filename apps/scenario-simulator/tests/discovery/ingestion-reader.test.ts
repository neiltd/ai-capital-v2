import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { IngestionReader } from '../../src/discovery/ingestion-reader.js'

// We create a real temp SQLite file so IngestionReader can open it
function createTempDb(): { dbPath: string; db: Database.Database } {
  const dir = path.join(os.tmpdir(), `ingestion-reader-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'capital_intelligence.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE companies (
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

  afterEach(() => {
    reader?.close()
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
        INSERT INTO companies VALUES ('AAPL', 'Apple', 1);
        INSERT INTO companies VALUES ('NVDA', 'NVIDIA', 1);
        INSERT INTO companies VALUES ('OLD', 'Old Corp', 0);
      `)
      reader = new IngestionReader(dbPath)
    })

    it('returns active companies as DiscoveryCandidates', () => {
      const result = reader.getTrackedTickers([])
      expect(result).toHaveLength(2)
      expect(result[0].source).toBe('companies_table')
      expect(result[0].newsSnippet).toBeNull()
      const tickers = result.map(r => r.ticker)
      expect(tickers).toContain('AAPL')
      expect(tickers).toContain('NVDA')
    })

    it('excludes inactive companies (active = 0)', () => {
      const result = reader.getTrackedTickers([])
      const tickers = result.map(r => r.ticker)
      expect(tickers).not.toContain('OLD')
    })

    it('excludes tickers in the exclude list', () => {
      const result = reader.getTrackedTickers(['AAPL'])
      const tickers = result.map(r => r.ticker)
      expect(tickers).not.toContain('AAPL')
      expect(tickers).toContain('NVDA')
    })

    it('returns empty array when all tickers are excluded', () => {
      const result = reader.getTrackedTickers(['AAPL', 'NVDA'])
      expect(result).toHaveLength(0)
    })

    it('handles empty exclude list', () => {
      const result = reader.getTrackedTickers([])
      expect(result).toHaveLength(2)
    })
  })

  describe('getRecentNews', () => {
    beforeEach(() => {
      db.exec(`
        INSERT INTO raw_documents (ticker, company, source, content, published_date)
        VALUES
          ('NVDA', 'NVIDIA', 'news', 'Recent news about NVIDIA chips', date('now', '-1 days')),
          ('AAPL', 'Apple', 'news', 'Apple earnings beat', date('now', '-3 days')),
          ('OLD', 'OldCo', 'news', 'Very old news', date('now', '-30 days')),
          ('MSFT', 'Microsoft', 'filing', 'Filing content', date('now', '-1 days'));
      `)
      reader = new IngestionReader(dbPath)
    })

    it('returns only news source documents within date range', () => {
      const result = reader.getRecentNews(7)
      const tickers = result.map(r => r.ticker)
      expect(tickers).toContain('NVDA')
      expect(tickers).toContain('AAPL')
      expect(tickers).not.toContain('OLD')  // too old
      expect(tickers).not.toContain('MSFT') // wrong source type
    })

    it('truncates content to 500 characters', () => {
      const longContent = 'x'.repeat(1000)
      db.exec(`INSERT INTO raw_documents (ticker, company, source, content, published_date) VALUES ('TEST', 'Test', 'news', '${longContent}', date('now'))`)
      const result = reader.getRecentNews(1)
      const testRow = result.find(r => r.ticker === 'TEST')
      expect(testRow).toBeDefined()
      expect(testRow!.content.length).toBeLessThanOrEqual(500)
    })

    it('returns rows with expected fields', () => {
      const result = reader.getRecentNews(7)
      expect(result.length).toBeGreaterThan(0)
      const row = result[0]
      expect(row).toHaveProperty('ticker')
      expect(row).toHaveProperty('company')
      expect(row).toHaveProperty('content')
      expect(row).toHaveProperty('publishedDate')
    })

    it('returns empty array when no news in range', () => {
      const result = reader.getRecentNews(0)
      expect(result).toHaveLength(0)
    })
  })
})
