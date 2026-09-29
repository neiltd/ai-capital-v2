// READING THIS STORE MEANS READING ITS WAL.
//
// THE DEFECT THIS PINS, MEASURED ON THE PRODUCTION DATABASE. A verification of one
// scheduled-run row opened `data/pipeline-runs.db` with SQLite's `immutable=1`.
// That flag tells SQLite the file cannot change and to IGNORE the `-wal` sidecar
// entirely, so the read saw only the main file:
//
//   immutable=1   2232 rows, latest logical_date 2026-09-06, target row ABSENT
//   read-only     2245 rows, latest logical_date 2026-09-28, target row PRESENT
//
// The row had been committed for hours; the `-wal` sidecar was 436752 bytes. On the
// strength of the first reading the row was reported missing and a milestone was
// halted. `immutable=1` is not a stricter read — it is a different question, and it
// is the wrong one for a live WAL database.
//
// So the store's read-only handle must be WAL-aware, and this proves it against a
// row that exists ONLY in the WAL: the schema is checkpointed into the main file
// first, the row is committed afterwards, and the writer stays open so nothing
// folds it in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDbReadOnly } from '../src/store.js'

const ROW = '2191e266-78a1-4951-9807-bf4260563463'

let dir: string
let writer: Database.Database | null = null

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pr-wal-')) })
afterEach(() => {
  if (writer !== null) { try { writer.close() } catch { /* already closed */ } }
  writer = null
  rmSync(dir, { recursive: true, force: true })
})

/** A WAL database whose target row lives only in the WAL. */
function storeWithRowOnlyInWal(): string {
  const path = join(dir, 'pipeline-runs.db')
  writer = new Database(path)
  writer.pragma('journal_mode = WAL')
  writer.exec(`CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT, source TEXT, status TEXT,
    logical_date TEXT, superseded_at TEXT, metadata_json TEXT)`)
  // Fold the schema into the main file, so what follows is the ONLY thing in the WAL.
  writer.pragma('wal_checkpoint(TRUNCATE)')
  writer.prepare(
    `INSERT INTO pipeline_runs (id, stage, source, status, logical_date)
     VALUES (?, 'daily-pipeline', 'queue', 'failed', '2026-09-28')`).run(ROW)
  return path
}

describe('a row committed through an active WAL', () => {
  it('is visible to the store\'s read-only handle', () => {
    const path = storeWithRowOnlyInWal()
    // Non-vacuity: there really is an active, non-empty WAL.
    expect(statSync(`${path}-wal`).size, 'the WAL carries the row').toBeGreaterThan(0)

    const db = openDbReadOnly(path)
    try {
      const found = db.prepare('SELECT id, status, logical_date FROM pipeline_runs WHERE id = ?')
        .get(ROW) as { id: string; status: string; logical_date: string } | undefined
      expect(found, 'the WAL-aware handle sees it').toBeDefined()
      expect(found?.status).toBe('failed')
      expect(found?.logical_date).toBe('2026-09-28')
      expect(db.prepare('SELECT count(*) AS n FROM pipeline_runs').get())
        .toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('is INVISIBLE to immutable=1 — which is why that flag may not be used', () => {
    const path = storeWithRowOnlyInWal()
    // THROUGH THE `sqlite3` CLI, DELIBERATELY. better-sqlite3 accepts no URI
    // filename, and this is also the exact tool whose `immutable=1` open produced
    // the original false negative — so the non-vacuity of the case above is
    // demonstrated against the thing that actually got it wrong.
    const q = (uri: string): string =>
      execFileSync('/usr/bin/sqlite3', [uri, 'SELECT count(*) FROM pipeline_runs;'],
        { encoding: 'utf-8' }).trim()
    expect(q(`file:${path}?immutable=1`), 'immutable=1 reports a stale census').toBe('0')
    // …and the ordinary read-only URI, against the same pathname, does see it.
    expect(q(`file:${path}?mode=ro`), 'a WAL-aware open sees the row').toBe('1')
  })
})

describe('the store never opens its reader with immutable', () => {
  it('openDbReadOnly uses a plain read-only open', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/store.ts', import.meta.url)), 'utf-8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toMatch(/readonly:\s*true/)
    expect(code).not.toContain('immutable')
  })
})
