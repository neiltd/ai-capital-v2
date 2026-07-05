import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import Database from 'better-sqlite3'
import { join } from 'path'
import { tmpdir } from 'os'
import { hasNewDocs } from './update.js'

describe('hasNewDocs', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = join(tmpdir(), `update-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    dbPath = join(dir, 'sqlite.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE fetch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        doc_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns false when fetch_log has no recent entries for ticker', () => {
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns true when fetch_log has recent docs for ticker', () => {
    const db = new Database(dbPath)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('ARM', 'news', now, 3, 12)
    db.close()
    expect(hasNewDocs(dir, 'ARM')).toBe(true)
  })

  it('returns false when docs are older than 1 day', () => {
    const db = new Database(dbPath)
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('ARM', 'news', old, 3, 12)
    db.close()
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns false when only wildcard ticker rows exist', () => {
    const db = new Database(dbPath)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO fetch_log (ticker, source, fetched_at, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)'
    ).run('*', 'sec_filing', now, 1, 5)
    db.close()
    expect(hasNewDocs(dir, 'ARM')).toBe(false)
  })

  it('returns false when db file does not exist', () => {
    expect(hasNewDocs('/nonexistent/path', 'ARM')).toBe(false)
  })
})
