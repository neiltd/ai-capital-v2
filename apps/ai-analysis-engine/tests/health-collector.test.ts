import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { collectHealth } from '../src/collector/health-collector.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMP_THESIS_DB = join(__dirname, 'temp-thesis.db')

function createTempThesisDb() {
  const db = new Database(TEMP_THESIS_DB)
  db.exec(`
    CREATE TABLE IF NOT EXISTS theses (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL, type TEXT NOT NULL,
      position_size TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assumptions (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, last_evidence_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narratives (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, content TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL
    );
  `)
  return db
}

describe('collectHealth', () => {
  let db: Database.Database

  beforeEach(() => { db = createTempThesisDb() })
  afterEach(() => {
    db.close()
    if (existsSync(TEMP_THESIS_DB)) unlinkSync(TEMP_THESIS_DB)
  })

  it('returns insufficient_data when no thesis exists', async () => {
    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results).toHaveLength(1)
    expect(results[0].healthScore).toBe('insufficient_data')
    expect(results[0].assumptions).toEqual([])
    expect(results[0].recentChunks).toEqual([])
  })

  it('returns positive when all assumptions are stable or strengthening', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t1', 'NVDA', 'company', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n1', 't1', 'NVDA is the GPU leader', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a1', 't1', 'GPU demand stays strong', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a2', 't1', 'TSMC capacity available', 'strengthening', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('positive')
    expect(results[0].thesisSummary).toBe('NVDA is the GPU leader')
    expect(results[0].assumptions).toHaveLength(2)
    expect(results[0].assumptions[0]).toEqual({ text: 'GPU demand stays strong', status: 'stable' })
  })

  it('returns negative when any assumption is broken', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t2', 'AMD', 'company', 'satellite', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n2', 't2', 'AMD thesis', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a3', 't2', 'Market share gains', 'broken', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a4', 't2', 'TSMC yields', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'AMD', company: 'AMD' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('negative')
  })

  it('returns neutral when assumptions include weakening but not broken', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t3', 'TSM', 'company', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO narratives VALUES (?, ?, ?, ?, ?)').run('n3', 't3', 'TSM thesis', 1, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a5', 't3', 'Advanced node demand', 'stable', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO assumptions VALUES (?, ?, ?, ?, ?, ?, ?)').run('a6', 't3', 'Customer concentration', 'weakening', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'TSM', company: 'TSMC' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('neutral')
  })

  it('skips theme theses — only reads company type', async () => {
    db.prepare('INSERT INTO theses VALUES (?, ?, ?, ?, ?, ?)').run('t4', 'NVDA', 'theme', 'core', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

    const results = await collectHealth(
      [{ ticker: 'NVDA', company: 'NVIDIA' }],
      { thesisDbPath: TEMP_THESIS_DB, lanceDbPath: '/nonexistent' },
    )
    expect(results[0].healthScore).toBe('insufficient_data')
  })
})
