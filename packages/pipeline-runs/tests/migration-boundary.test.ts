import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, openDbReadOnly, closeDb, hasScheduledIdentity, migrateScheduledRunIdentity } from '../src/store.js'
import { recordStart } from '../src/api.js'

// FINDING 1 — the migration boundary.
//
// `openDb()` executed the full SCHEMA, which included an index over
// `logical_date`, BEFORE `migrateScheduledRunIdentity()` ever added that column.
// Against the REAL production schema — 14 columns, no logical_date — the very
// first open therefore died with:
//
//     OPEN_FAILED: no such column: logical_date
//
// which takes down every stage at once, since they all open the run store. The
// bug was invisible because every test built its fixture from the NEW schema.
// These tests build the LEGACY one and drive the REAL `openDb()`.
//
// SAFETY: every database here lives in a fresh temp directory. `data/pipeline-runs.db`
// is never opened, and the migration CLI is only ever pointed at temp paths.

const PKG = resolve(__dirname, '..')
const MIGRATE = join(PKG, 'bin', 'migrate-run-store.ts')
const TSX = resolve(PKG, '..', '..', 'node_modules', '.bin', 'tsx')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-store-migration-')) })
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })

/** The production schema as it actually exists on disk today: 14 columns. */
const LEGACY_COLUMNS = [
  'id', 'parent_run_id', 'stage', 'source', 'started_at', 'ended_at', 'duration_ms',
  'status', 'doc_count', 'chunk_count', 'ticker_count', 'error_message', 'error_stack',
  'metadata_json',
]

function legacyStore(name = 'legacy.db'): string {
  const path = join(dir, name)
  const db = new Database(path)
  db.exec(`CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
    doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
    error_message TEXT, error_stack TEXT, metadata_json TEXT)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_started ON pipeline_runs(started_at)`)
  const ins = db.prepare(`INSERT INTO pipeline_runs (id, stage, started_at, status) VALUES (?,?,?,?)`)
  ins.run('hist-1', 'daily-pipeline', '2026-08-01T14:00:00.000Z', 'success')
  ins.run('hist-2', 'capital-ingestion', '2026-08-01T14:05:00.000Z', 'success')
  ins.run('hist-3', 'daily-pipeline', '2026-08-02T14:00:00.000Z', 'failed')
  db.close()
  return path
}

const cols = (path: string) => {
  const db = new Database(path, { readonly: true })
  const out = db.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all().map((r: any) => r.name)
  db.close()
  return out as string[]
}
const rowCount = (path: string) => {
  const db = new Database(path, { readonly: true })
  const n = (db.prepare(`SELECT COUNT(*) c FROM pipeline_runs`).get() as any).c
  db.close()
  return n as number
}
const indexes = (path: string) => {
  const db = new Database(path, { readonly: true })
  const out = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r: any) => r.name)
  db.close()
  return out as string[]
}
const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
/** Read the journal mode WITHOUT changing it: a query, never an assignment. */
const journalMode = (path: string) => {
  const db = new Database(path, { readonly: true })
  const m = (db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0].journal_mode
  db.close()
  return m
}
/** Which SQLite sidecars exist beside the database. */
const sidecars = (path: string) =>
  ['-wal', '-shm', '-journal'].filter(sfx => existsSync(`${path}${sfx}`)).sort()

const migrate = (path: string, ...args: string[]) =>
  execFileSync(TSX, [MIGRATE, '--db', path, ...args], { encoding: 'utf-8', timeout: 90_000 })

// ── The fixture must really be the broken shape ────────────────────────────

describe('the legacy fixture is genuinely pre-migration', () => {
  it('has exactly the 14 production columns and neither new one', () => {
    const c = cols(legacyStore())
    expect(c).toEqual(LEGACY_COLUMNS)
    expect(c).not.toContain('logical_date')
    expect(c).not.toContain('superseded_at')
  })
})

// ── Fail closed, with a diagnostic ─────────────────────────────────────────

describe('openDb() against a legacy store', () => {
  it('does NOT reproduce "no such column: logical_date"', () => {
    // The original defect. Failing differently is the fix; failing this way is
    // the regression.
    const path = legacyStore()
    let msg = ''
    try { openDb(path) } catch (e) { msg = (e as Error).message }
    expect(msg).not.toMatch(/no such column/i)
  })

  it('refuses to open, naming the missing columns and both CLI steps', () => {
    const path = legacyStore()
    expect(() => openDb(path)).toThrow(/needs migration/i)
    let msg = ''
    try { openDb(path) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('logical_date')
    expect(msg).toContain('superseded_at')
    expect(msg).toMatch(/migrate-run-store\.ts/)          // inspect
    expect(msg).toMatch(/--apply/)                        // apply
    expect(msg).toContain(path)
  })

  it('the refusal leaves the FILE byte-for-byte identical', () => {
    // The strongest form of the claim, and the one the previous version failed:
    // `journal_mode = WAL` ran before the compatibility check, rewriting the
    // header and creating sidecars on the operator's production store before
    // announcing that it refused to touch it.
    const path = legacyStore()
    const before = {
      hash: hashFile(path),
      journal: journalMode(path),
      sidecars: sidecars(path),
      cols: cols(path), idx: indexes(path), rows: rowCount(path),
    }
    expect(before.journal, 'the fixture must start in the legacy journal mode').toBe('delete')
    expect(before.sidecars, 'the fixture must start with no sidecars').toEqual([])

    expect(() => openDb(path)).toThrow(/needs migration/i)

    expect(hashFile(path), 'the rejected open modified the file').toBe(before.hash)
    expect(journalMode(path), 'the rejected open converted the store to WAL').toBe(before.journal)
    expect(sidecars(path), 'the rejected open created sidecar files').toEqual(before.sidecars)
    expect(cols(path)).toEqual(before.cols)
    expect(indexes(path)).toEqual(before.idx)
    expect(rowCount(path)).toBe(before.rows)
  })

  it('the refusal writes NOTHING — no columns, no index, no rows', () => {
    const path = legacyStore()
    const before = { c: cols(path), i: indexes(path), n: rowCount(path) }
    expect(() => openDb(path)).toThrow()
    expect(cols(path)).toEqual(before.c)
    expect(indexes(path)).toEqual(before.i)
    expect(rowCount(path)).toBe(before.n)
  })

  it('the writer path used by every stage fails closed too, not mid-write', () => {
    const path = legacyStore()
    expect(() => recordStart({ stage: 'daily-pipeline' } as never, path)).toThrow(/needs migration/i)
    expect(rowCount(path)).toBe(3)                        // no partial row landed
  })
})

// ── A NEW store still works end to end ─────────────────────────────────────

describe('openDb() against a fresh store', () => {
  it('creates the full schema, the identity columns and the index in one open', () => {
    const path = join(dir, 'fresh.db')
    const db = openDb(path)
    expect(hasScheduledIdentity(db)).toBe(true)
    db.close()
    expect(cols(path)).toContain('logical_date')
    expect(cols(path)).toContain('superseded_at')
    expect(indexes(path)).toContain('idx_daily_scheduled_logical_date')
  })

  it('NON-VACUOUS: an ACCEPTED open really does convert the file to WAL', () => {
    // The contrast that gives the rejection test its meaning. If opening never
    // changed the journal mode, "the rejected open left it alone" would be true
    // of any code at all.
    const path = legacyStore('accepted.db')
    const db = new Database(path)
    migrateScheduledRunIdentity(db)
    db.close()
    expect(journalMode(path)).toBe('delete')
    openDb(path)                                  // now compatible, so it proceeds
    expect(journalMode(path), 'openDb no longer sets WAL — the contrast is gone').toBe('wal')
  })

  it('is idempotent — opening twice is not an error', () => {
    const path = join(dir, 'fresh2.db')
    openDb(path).close()
    expect(() => openDb(path).close()).not.toThrow()
  })
})

// ── Read-only status must not be collateral damage ─────────────────────────

describe('read-only access to a legacy store', () => {
  it('opens (status tooling still works) but reports no scheduled identity', () => {
    const path = legacyStore()
    const db = openDbReadOnly(path)
    expect(hasScheduledIdentity(db)).toBe(false)
    db.close()
  })

  it('cannot mutate — the read-only guarantee is real, not advisory', () => {
    const db = openDbReadOnly(legacyStore())
    expect(() => db.exec(`INSERT INTO pipeline_runs (id,stage,started_at,status)
                          VALUES ('x','s','2026-08-01T00:00:00Z','success')`)).toThrow()
    expect(() => db.exec(`ALTER TABLE pipeline_runs ADD COLUMN logical_date TEXT`)).toThrow()
    db.close()
  })
})

// ── The migration itself ───────────────────────────────────────────────────

describe('migrateScheduledRunIdentity()', () => {
  it('adds the columns BEFORE the index — the ordering the defect inverted', () => {
    const path = legacyStore()
    const db = new Database(path)
    const report = migrateScheduledRunIdentity(db)
    db.close()
    expect(report.alreadyMigrated).toBe(false)
    expect(report.columnsAdded).toEqual(['logical_date', 'superseded_at'])
    expect(report.indexCreated, 'the index must be created in the same transaction').toBe(true)
    expect(cols(path)).toEqual([...LEGACY_COLUMNS, 'logical_date', 'superseded_at'])
    expect(indexes(path)).toContain('idx_daily_scheduled_logical_date')
  })

  it('preserves every historical row, with logical_date NULL rather than guessed', () => {
    const path = legacyStore()
    const db = new Database(path)
    migrateScheduledRunIdentity(db)
    const rows = db.prepare(`SELECT id, logical_date, superseded_at FROM pipeline_runs ORDER BY id`).all() as any[]
    db.close()
    expect(rows.map(r => r.id)).toEqual(['hist-1', 'hist-2', 'hist-3'])
    // Backfilling a logical date onto history would invent scheduling facts that
    // were never recorded. NULL is the honest value.
    expect(rows.every(r => r.logical_date === null)).toBe(true)
    expect(rows.every(r => r.superseded_at === null)).toBe(true)
  })

  it('a second run is a no-op, not a duplicate-column error', () => {
    const path = legacyStore()
    const db = new Database(path)
    migrateScheduledRunIdentity(db)
    const second = migrateScheduledRunIdentity(db)
    db.close()
    expect(second.alreadyMigrated).toBe(true)
    expect(second.columnsAdded).toEqual([])
  })

  it('the writer can open the store afterwards — the boundary is actually cleared', () => {
    const path = legacyStore()
    const db = new Database(path)
    migrateScheduledRunIdentity(db)
    db.close()
    expect(() => openDb(path).close()).not.toThrow()
    expect(rowCount(path)).toBe(3)
  })
})

// ── The CLI: inspection is the default, --apply is deliberate ──────────────

describe('migrate-run-store CLI', () => {
  it('inspects by default and changes NOTHING', () => {
    const path = legacyStore()
    const before = { c: cols(path), i: indexes(path), n: rowCount(path), m: statSync(path).mtimeMs }
    const out = migrate(path)
    expect(out).toMatch(/INSPECT/)
    expect(out).toMatch(/--apply/)
    expect(out).toMatch(/legacy/i)
    expect(cols(path)).toEqual(before.c)
    expect(indexes(path)).toEqual(before.i)
    expect(rowCount(path)).toBe(before.n)
  })

  it('--apply migrates, and reports the row count on both sides', () => {
    const path = legacyStore()
    const out = migrate(path, '--apply')
    expect(out).toMatch(/rows before\/after: 3\/3/)
    expect(out).toMatch(/preserved/)
    expect(cols(path)).toContain('logical_date')
  })

  it('--apply twice is a no-op the second time', () => {
    const path = legacyStore()
    migrate(path, '--apply')
    expect(migrate(path, '--apply')).toMatch(/already migrated|no change/i)
    expect(rowCount(path)).toBe(3)
  })

  it('refuses a path that does not exist rather than conjuring an empty store', () => {
    const missing = join(dir, 'nope.db')
    let out = ''
    try { migrate(missing, '--apply') } catch (e: any) { out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    expect(out).toMatch(/does not exist|not found/i)
    // The dangerous outcome is a brand-new empty database that then reads as a
    // perfectly healthy store with zero runs.
    expect(existsSync(missing), 'the CLI created the database it was asked to migrate').toBe(false)
  })
}, 120_000)

// ── C. malformed arguments must never resolve to a MORE dangerous target ───

describe('migrate-run-store argument parsing', () => {
  /** Run the CLI with an exact argv, never a shell string. */
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync(TSX, [MIGRATE, ...args],
        { encoding: 'utf-8', timeout: 90_000, env: { ...process.env, ...env } })
      return { code: 0, out: stdout }
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  it('CRITICAL: `--apply --db` never falls back to PIPELINE_RUNS_DB', () => {
    // The defect in full. `--db` lost its value (a forgotten argument, or an
    // empty shell variable), the parser fell through to resolveDbPath(), and
    // `--apply` then migrated whatever that pointed at — in production, the real
    // run store, unmigrated and unauthorized.
    const decoy = join(dir, 'decoy.db')
    const before = { hash: hashFile(legacyStore('decoy.db')), cols: cols(decoy), rows: rowCount(decoy) }

    const r = cli(['--apply', '--db'], { PIPELINE_RUNS_DB: decoy })

    expect(r.code, 'a malformed command must not succeed').toBe(2)
    expect(r.out).toMatch(/--db requires a path/)
    // The database PIPELINE_RUNS_DB pointed at is untouched, byte for byte.
    expect(hashFile(decoy), 'the fallback target was modified').toBe(before.hash)
    expect(cols(decoy), 'the fallback target was migrated').toEqual(before.cols)
    expect(rowCount(decoy)).toBe(before.rows)
    expect(cols(decoy)).not.toContain('logical_date')
  })

  it('rejects `--db` followed by another flag rather than treating it as a path', () => {
    const decoy = join(dir, 'decoy2.db')
    const before = hashFile(legacyStore('decoy2.db'))
    const r = cli(['--db', '--apply'], { PIPELINE_RUNS_DB: decoy })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/got the flag '--apply'/)
    expect(hashFile(decoy)).toBe(before)
  })

  it('rejects a duplicated --db instead of silently preferring one', () => {
    const a = legacyStore('a.db'), b = legacyStore('b.db')
    const before = [hashFile(a), hashFile(b)]
    const r = cli(['--db', a, '--db', b, '--apply'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/--db given more than once/)
    expect([hashFile(a), hashFile(b)], 'a rejected command migrated one of them').toEqual(before)
  })

  it('rejects unknown arguments', () => {
    const r = cli(['--force'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/unknown argument '--force'/)
    expect(r.out).toMatch(/usage:/)
  })

  it('documents what it does accept', () => {
    const r = cli(['--help'])
    expect(r.code).toBe(0)
    for (const flag of ['--db', '--apply', '--help']) expect(r.out).toContain(flag)
  })

  it('NON-VACUOUS: a WELL-FORMED --apply on the same fixture does migrate it', () => {
    // Without this, every assertion above would also hold for a CLI that never
    // worked at all.
    const good = legacyStore('good.db')
    const r = cli(['--db', good, '--apply'])
    expect(r.code).toBe(0)
    expect(cols(good)).toContain('logical_date')
  })
}, 120_000)

// ── D. inspection must not touch a WAL-mode store ─────────────────────────
//
// The CLI opened the target with `new Database(path)` — a WRITE-CAPABLE
// connection — BEFORE branching on `--apply`, while printing
// "INSPECT (no writes — pass --apply to migrate)". Against the production run
// store, which is in WAL mode, that statement was false: the open rewrote the
// `-wal` sidecar and the `-shm` sidecar. A read-only connection is no fix
// either — it still materialises `-shm`, and closing the last connection
// checkpoints the WAL into the main file and deletes both sidecars.
//
// The previous test for this contract used a NON-WAL fixture and compared only
// schema, rows and the main file's timestamp, so it could not observe any of
// that. These tests fingerprint all three files.

describe('D. WAL-mode inspection is genuinely read-only', () => {
  /**
   * A legacy store whose committed rows live in the WAL, exactly like the
   * production one: some rows checkpointed into the main file, the rest still
   * WAL-resident. Built by a child process that is killed before it can close
   * and thereby checkpoint — which is also how a crashed writer leaves one.
   */
  function walFixture(name: string): { path: string; mainRows: number; walRows: number } {
    const dbPath = join(dir, name)
    const helper = join(dir, `mkwal-${name}.ts`)
    writeFileSync(helper, `
import Database from 'better-sqlite3'
import { writeFileSync } from 'fs'
const p = process.argv[2]
const d = new Database(p)
d.pragma('journal_mode = WAL')
d.pragma('wal_autocheckpoint = 0')
d.exec(\`CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, parent_run_id TEXT, stage TEXT NOT NULL, source TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, status TEXT NOT NULL,
  doc_count INTEGER, chunk_count INTEGER, ticker_count INTEGER,
  error_message TEXT, error_stack TEXT, metadata_json TEXT)\`)
const ins = d.prepare("INSERT INTO pipeline_runs (id,stage,started_at,status) VALUES (?,'daily-pipeline',?,'success')")
for (let i = 0; i < 20; i++) ins.run('main-' + i, '2026-08-01T00:00:00Z')
d.exec('PRAGMA wal_checkpoint(TRUNCATE)')      // these 20 reach the MAIN file
for (let i = 0; i < 36; i++) ins.run('wal-' + i, '2026-08-02T00:00:00Z')   // these stay in the WAL
writeFileSync(p + '.ready', 'y')
setTimeout(() => {}, 120000)
`, 'utf-8')
    // Kill -9 before close: closing would checkpoint and delete the sidecars.
    const r = spawnSync('/bin/bash', ['-c',
      `"${TSX}" "${helper}" "${dbPath}" >/dev/null 2>&1 & c=$!; ` +
      `for i in $(seq 1 300); do [ -f "${dbPath}.ready" ] && break; sleep 0.1; done; ` +
      `kill -9 $c 2>/dev/null; wait $c 2>/dev/null; true`], { encoding: 'utf-8', timeout: 120_000 })
    expect(r.status, `fixture builder failed: ${r.stderr}`).toBe(0)
    expect(existsSync(dbPath), 'fixture database was not created').toBe(true)
    return { path: dbPath, mainRows: 20, walRows: 36 }
  }

  /** Existence, content hash, size and mtime for the database and both sidecars. */
  const stamp = (dbPath: string) => ['', '-wal', '-shm'].map(sfx => {
    const f = `${dbPath}${sfx}`
    if (!existsSync(f)) return `${sfx || 'db'}:absent`
    const st = statSync(f)
    return `${sfx || 'db'}:${hashFile(f)}:${st.size}:${st.mtimeMs}`
  })

  it('the fixture really is WAL-resident — the main file alone is short', () => {
    // Non-vacuous by construction: if everything were checkpointed, "the WAL was
    // not read" would cost nothing and the tests below would prove nothing.
    const { path } = walFixture('wal-shape.db')
    expect(existsSync(`${path}-wal`), 'no WAL sidecar — fixture is not WAL-resident').toBe(true)
    expect(existsSync(`${path}-shm`)).toBe(true)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
    const out = migrate(path)
    expect(out).toMatch(/20 in the main file/)     // main-file view
    expect(out).not.toMatch(/rows *: 56/)          // never the effective count
  })

  it('default inspection leaves the database, WAL and SHM byte-for-byte identical', () => {
    const { path } = walFixture('wal-inspect.db')
    const before = stamp(path)
    const out = migrate(path)                      // no --apply
    const after = stamp(path)
    expect(after, `inspection mutated: ${before.filter((b, i) => b !== after[i]).join(', ')}`).toEqual(before)
    expect(out).toMatch(/INSPECT/)
    expect(out).toMatch(/not touched/)
  })

  it('NON-VACUOUS: the previous implementation is detected by this fixture', () => {
    // `new Database(path)` — literally what the CLI used to do before branching
    // on --apply. If this ever stops changing the sidecars, the test above is
    // no longer evidence of anything.
    const { path } = walFixture('wal-old-impl.db')
    const before = stamp(path)
    const db = new Database(path)                  // write-capable, as before
    db.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get()
    db.close()
    const after = stamp(path)
    const changed = before.map((b, i) => (b === after[i] ? null : b.split(':')[0])).filter(Boolean)
    expect(changed.length, 'the old open no longer disturbs the store').toBeGreaterThan(0)
    expect(changed).toContain('-shm')
  })

  it('does not report the main-file count as the database count', () => {
    const { path } = walFixture('wal-count.db')
    const out = migrate(path)
    expect(out).toMatch(/rows *: UNAVAILABLE/)
    expect(out).toMatch(/WAL is present/)
    expect(out).toMatch(/uncheckpointed schema changes would also be invisible/)
  })

  it('a store with NO WAL still reports a plain, exact row count', () => {
    // The caveat appears only where it is warranted.
    const path = legacyStore('no-wal.db')          // rollback-journal fixture, 3 rows
    const out = migrate(path)
    expect(out).toMatch(/rows *: 3/)
    expect(out).not.toMatch(/UNAVAILABLE/)
  })

  it('--apply still migrates a WAL store correctly, on an isolated fixture', () => {
    const { path } = walFixture('wal-apply.db')
    expect(cols(path)).not.toContain('logical_date')
    const out = migrate(path, '--apply')
    expect(out).toMatch(/mode *: APPLY/)
    // APPLY opens the store properly, so it sees every committed row.
    expect(out).toMatch(/rows before\/after: 56\/56/)
    expect(out).toMatch(/preserved/)
    const after = cols(path)
    expect(after).toContain('logical_date')
    expect(after).toContain('superseded_at')
    expect(indexes(path)).toContain('idx_daily_scheduled_logical_date')
  })

  it('--apply on a WAL store is still idempotent and row-preserving', () => {
    const { path } = walFixture('wal-apply-twice.db')
    migrate(path, '--apply')
    const out = migrate(path, '--apply')
    expect(out).toMatch(/already migrated/)
    expect(rowCount(path)).toBe(56)
  })

  it('refuses a non-SQLite or empty file cleanly, instead of a native crash', () => {
    for (const [name, body] of [['empty.db', ''], ['garbage.db', 'not a database\n']] as const) {
      const f = join(dir, name)
      writeFileSync(f, body)
      let out = '', code = 0
      try { execFileSync(TSX, [MIGRATE, '--db', f], { encoding: 'utf-8', timeout: 90_000 }) }
      catch (e: any) { code = e.status; out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
      expect(code, `${name} did not fail closed`).toBe(1)
      expect(out).toMatch(/not a SQLite database/)
      expect(out).not.toMatch(/wrappers\.js|at Database/)     // no raw native stack
    }
  })

  it('refuses a SQLite database that is not a run store', () => {
    const f = join(dir, 'other.db')
    const d = new Database(f)
    d.exec('CREATE TABLE something_else (x TEXT)')
    d.close()
    let out = '', code = 0
    try { execFileSync(TSX, [MIGRATE, '--db', f], { encoding: 'utf-8', timeout: 90_000 }) }
    catch (e: any) { code = e.status; out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    expect(code).toBe(1)
    expect(out).toMatch(/not a run store/)
  })

  it('inspection opens no connection to the source at all', () => {
    const src = readFileSync(resolve(__dirname, '..', 'bin', 'migrate-run-store.ts'), 'utf-8')
    const inspectBlock = src.slice(src.indexOf('function inspectWithoutTouching'), src.indexOf('// ── APPLY'))
    // The only Database in the inspection path is the in-memory copy.
    expect(inspectBlock).toMatch(/new Database\(copy\)/)
    expect(inspectBlock).not.toMatch(/new Database\(\s*(db)?[Pp]ath/)
    expect(inspectBlock).not.toMatch(/readonly:\s*true/)   // not needed: no file connection exists
  })
}, 180_000)
