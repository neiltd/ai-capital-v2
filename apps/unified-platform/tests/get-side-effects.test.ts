import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * THE INVARIANT:
 *
 *   Rendering any dashboard/status GET path leaves persistent operational state
 *   unchanged.
 *
 * WHY THIS IS TESTED AT THE REQUEST PATH. `/admin/pipeline` called
 * `reapOrphans()` — a genuine writer — from a server-component render, so
 * loading a page issued an UPDATE. The earlier work classified FUNCTIONS as
 * read or write and missed it, because the write sat several frames below
 * something that looked like a renderer. Function-level classification cannot
 * see that. So these tests invoke the actual page component and route handler.
 *
 * WHAT IS ASSERTED. Database ROWS AND STATE — not file bytes. A read-only
 * SQLite open builds the WAL shared-memory index and cannot remove it on close,
 * so `-shm`/`-wal` legitimately change during a pure read. Asserting byte
 * identity would fail for the wrong reason and teach the next person to weaken
 * the test rather than fix a bug.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT)`

let dir: string
let dbPath: string

/** The exact shape that used to be rewritten: running, older than the 6h SLA. */
const STALE_ID = 'evidence-row-stuck-running'

function seed() {
  const db = new Database(dbPath)
  db.exec(SCHEMA)
  const ins = db.prepare(
    `INSERT INTO pipeline_runs (id, stage, started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?)`)
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  ins.run(STALE_ID, 'daily-pipeline', hoursAgo(30), null, 'running')     // 30h — well past 6h
  ins.run('recent-running', 'capital-ingestion', hoursAgo(1), null, 'running')
  ins.run('done', 'morning-status', hoursAgo(48), hoursAgo(47), 'success')
  ins.run('bad', 'world-intel-pipeline', hoursAgo(50), hoursAgo(49), 'failed')
  db.close()
}

/** Persistent operational state: every row, every column that a repair would touch. */
function snapshot(): string {
  if (!existsSync(dbPath)) return 'NO-DB'
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const rows = db.prepare(
    `SELECT id, stage, started_at, ended_at, duration_ms, status, error_message
       FROM pipeline_runs ORDER BY id`).all()
  db.close()
  return JSON.stringify(rows)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'get-side-effects-'))
  dbPath = join(dir, 'pipeline-runs.db')
  process.env.PIPELINE_RUNS_DB = dbPath
  seed()
})
afterEach(() => {
  delete process.env.PIPELINE_RUNS_DB
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Invoke a render/handler and report whether persistent state moved.
 *
 * A thrown error is not a pass. The page may fail to produce JSX under vitest
 * (no Next request context), but the data-loading code runs BEFORE the JSX
 * return — which is exactly where the write used to live. So the invariant is
 * still exercised, and we assert on state either way.
 */
async function invoke(fn: () => unknown | Promise<unknown>): Promise<void> {
  try { await fn() } catch { /* render may fail; the side effect, if any, already happened */ }
}

describe('GET paths do not mutate persistent operational state', () => {
  it('/admin/pipeline — the render that used to call reapOrphans', async () => {
    const before = snapshot()
    const page = (await import('@/app/(legacy)/admin/pipeline/page')).default
    await invoke(() => page())
    expect(snapshot(), 'rendering /admin/pipeline changed pipeline_runs').toBe(before)
  })

  it('/admin/pipeline — the stale row is still `running`, not reaped to `timeout`', async () => {
    const page = (await import('@/app/(legacy)/admin/pipeline/page')).default
    await invoke(() => page())
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT status, ended_at, error_message FROM pipeline_runs WHERE id = ?')
      .get(STALE_ID) as { status: string; ended_at: string | null; error_message: string | null }
    db.close()
    expect(row.status).toBe('running')
    expect(row.ended_at).toBeNull()
    expect(row.error_message).toBeNull()
  })

  it('/admin/pipeline — REPEATED renders stay observational', async () => {
    const page = (await import('@/app/(legacy)/admin/pipeline/page')).default
    const before = snapshot()
    for (let i = 0; i < 5; i++) await invoke(() => page())
    expect(snapshot()).toBe(before)
  })

  it('/system/pipeline — the second dashboard', async () => {
    const before = snapshot()
    const { loadPipeline } = await import('@/app/(next)/system/pipeline/data')
    await invoke(() => loadPipeline())
    expect(snapshot()).toBe(before)
  })

  it('GET /api/status', async () => {
    const before = snapshot()
    const { GET } = await import('@/app/api/status/route')
    await invoke(() => GET())
    expect(snapshot()).toBe(before)
  })

  it('a GET against an ABSENT store creates no database', async () => {
    // openDb used to create it silently, and an empty store reads as healthy.
    rmSync(dbPath, { force: true })
    const page = (await import('@/app/(legacy)/admin/pipeline/page')).default
    await invoke(() => page())
    const { GET } = await import('@/app/api/status/route')
    await invoke(() => GET())
    expect(existsSync(dbPath), 'a GET fabricated a run store').toBe(false)
  })
})

describe('no replacement reaper was introduced', () => {
  it('no page or route imports reapOrphans', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e)) continue
        // Match an IMPORT or a CALL, not a mention. The page's own comment
        // explains why reapOrphans was removed; a bare substring match flags
        // that explanation and teaches the next person to delete the comment
        // rather than fix a bug. Same false-positive shape as matching
        // `import type pg` when hunting for pg constructors.
        const src = readFileSync(p, 'utf-8')
        const imports = /import\s+\{[^}]*\breapOrphans\b[^}]*\}/.test(src)
        const calls   = /(?<!\/\/[^\n]*)\breapOrphans\s*\(/.test(
          src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n'))
        if (imports || calls) offenders.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders, `these still reference reapOrphans: ${offenders.join(', ')}`).toEqual([])
  })
})
