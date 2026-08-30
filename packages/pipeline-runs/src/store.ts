import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              TEXT PRIMARY KEY,
  parent_run_id   TEXT,
  stage           TEXT NOT NULL,
  source          TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  status          TEXT NOT NULL,
  doc_count       INTEGER,
  chunk_count     INTEGER,
  ticker_count    INTEGER,
  error_message   TEXT,
  error_stack     TEXT,
  metadata_json   TEXT,
  -- Scheduled-run identity. NULL for manual/ad hoc runs and for every historical
  -- row, which is what keeps this additive: only rows that CLAIM a business
  -- logical date participate in the uniqueness rule below.
  logical_date    TEXT,
  superseded_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_stage_started
  ON pipeline_runs(stage, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_parent
  ON pipeline_runs(parent_run_id);


CREATE INDEX IF NOT EXISTS idx_pipeline_runs_inflight
  ON pipeline_runs(status, started_at) WHERE status = 'running';
`

/**
 * Resolve the SQLite path. Priority:
 *   1. explicit `dbPath` argument
 *   2. PIPELINE_RUNS_DB env var (set by daily.sh)
 *   3. ${DATA_ROOT}/../data/pipeline-runs.db
 *   4. ${process.cwd()}/data/pipeline-runs.db  (workspace-root fallback)
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit)                    return explicit
  if (process.env.PIPELINE_RUNS_DB) return process.env.PIPELINE_RUNS_DB
  if (process.env.DATA_ROOT)       return join(process.env.DATA_ROOT, '..', 'data', 'pipeline-runs.db')
  return join(process.cwd(), 'data', 'pipeline-runs.db')
}

let _cached: Database.Database | null = null

export function openDb(explicit?: string): Database.Database {
  const path = resolveDbPath(explicit)
  if (_cached && _cached.name === path) return _cached
  if (_cached) { _cached.close(); _cached = null }
  // INSPECT BEFORE TOUCHING ANYTHING.
  //
  // Compatibility is decided on a READ-ONLY handle, opened before the directory
  // is created and before any pragma is issued. The earlier version set
  // `journal_mode = WAL` first, and that is itself a permanent mutation: it
  // rewrites the database header and creates `-wal`/`-shm` sidecars. So the
  // "refusing to write to a store whose schema this build does not understand"
  // path had already converted the operator's file to WAL before printing the
  // refusal — on the production run store, before any migration was authorized.
  //
  // A read-only open of a non-WAL database creates nothing, so a rejected open
  // now leaves the file byte-for-byte identical.
  if (existsSync(path)) {
    const probe = new Database(path, { readonly: true, fileMustExist: true })
    let compatible: boolean
    try {
      const tableExists = probe.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_runs'`,
      ).get() !== undefined
      // A file with no table yet is not "legacy" — it is empty, and SCHEMA will
      // create the current shape below.
      compatible = !tableExists || hasScheduledIdentity(probe)
    } finally {
      probe.close()
    }
    if (!compatible) {
      // FAIL CLOSED. Migrating the authoritative run history is an explicit,
      // authorized operation — never a side effect of the first process that
      // happens to want to write a row.
      //
      // This also fixes a real breakage: the partial unique index used to live
      // in SCHEMA, so `db.exec(SCHEMA)` on a legacy table threw
      // "no such column: logical_date" and no writer could open production.
      throw new Error(
        `[pipeline-runs] run store at ${path} predates scheduled-run identity and needs migration.\n` +
        '  Missing column(s): logical_date / superseded_at.\n' +
        '  Inspect : npx tsx packages/pipeline-runs/bin/migrate-run-store.ts\n' +
        '  Apply   : npx tsx packages/pipeline-runs/bin/migrate-run-store.ts --apply\n' +
        '  Refusing to write to a store whose schema this build does not understand.',
      )
    }
  }

  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  // A NEW database gets the complete current schema, including logical_date and
  // superseded_at. An existing, already-migrated table is unaffected.
  db.exec(SCHEMA)

  // Columns are present, so the partial index is safe to declare here. It is
  // idempotent and cheap; keeping it out of SCHEMA is what makes legacy opens
  // fail with a diagnostic instead of a raw SQL error.
  db.exec(SCHEDULED_IDENTITY_INDEX)

  _cached = db
  return db
}

/** The partial unique index, applied only once its columns exist. */
export const SCHEDULED_IDENTITY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scheduled_logical_date
  ON pipeline_runs(logical_date)
  WHERE stage = 'daily-pipeline' AND logical_date IS NOT NULL AND superseded_at IS NULL;`

/** Whether a store already carries the scheduled-run identity columns. */
export function hasScheduledIdentity(db: Database.Database): boolean {
  const cols = new Set(
    (db.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all() as Array<{ name: string }>)
      .map(c => c.name),
  )
  return cols.has('logical_date') && cols.has('superseded_at')
}

export interface MigrationReport {
  alreadyMigrated: boolean
  columnsAdded: string[]
  indexCreated: boolean
}

/**
 * Additive, idempotent migration for scheduled-run identity.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database created before these columns needs them added. SQLite's
 * `ALTER TABLE ADD COLUMN` errors if the column is already there, so presence
 * is checked first — running this repeatedly is a no-op, and no existing row is
 * read, rewritten, or deleted.
 *
 * Both columns are nullable with no default, so every historical row remains
 * valid and stays outside the partial unique index.
 */
export function migrateScheduledRunIdentity(db: Database.Database): MigrationReport {
  if (hasScheduledIdentity(db)) {
    // Idempotent: the index is still ensured, but nothing is altered.
    db.exec(SCHEDULED_IDENTITY_INDEX)
    return { alreadyMigrated: true, columnsAdded: [], indexCreated: false }
  }

  const columns = new Set(
    (db.prepare(`SELECT name FROM pragma_table_info('pipeline_runs')`).all() as Array<{ name: string }>)
      .map(c => c.name),
  )
  const added: string[] = []

  // Transactional and ADDITIVE: columns first, index second — the index
  // references those columns, so the reverse order is what broke openDb. No
  // existing row is read, rewritten or deleted; both columns are nullable with
  // no default, so historical rows stay valid and outside the partial index.
  db.transaction(() => {
    if (!columns.has('logical_date'))  { db.exec(`ALTER TABLE pipeline_runs ADD COLUMN logical_date TEXT`);  added.push('logical_date') }
    if (!columns.has('superseded_at')) { db.exec(`ALTER TABLE pipeline_runs ADD COLUMN superseded_at TEXT`); added.push('superseded_at') }
    db.exec(SCHEDULED_IDENTITY_INDEX)
  })()

  return { alreadyMigrated: false, columnsAdded: added, indexCreated: true }
}


/**
 * Open the run database READ-ONLY for diagnostics.
 *
 * WHY THIS EXISTS SEPARATELY. `openDb` creates the file, creates its directory,
 * sets journal_mode=WAL and runs the schema. That is correct for a writer and
 * catastrophic for a diagnostic: `bin/reconcile.ts` and `bin/queue-health.ts`
 * run from an arbitrary cwd, and `resolveDbPath` falls back to
 * `${cwd}/data/pipeline-runs.db`. Warden ran the documented command from a
 * clean shell and it CREATED AN EMPTY DATABASE and reported a clean bill of
 * health — the same decoy-database defect that put a stray file into commit
 * 8e40054.
 *
 * So a diagnostic opener must:
 *   - refuse when the database does not already exist (a fresh file is a decoy,
 *     never an answer);
 *   - open read-only, so no schema is applied and no rows can be written;
 *   - never create a directory.
 *
 * WHAT READ-ONLY DOES **NOT** GIVE YOU — corrected 2026-08-28. An earlier
 * version of this comment claimed a read-only open "creates no WAL/SHM
 * sidecars". **That is false, and the truth is inverted.** Measured on a copy
 * of a real WAL database:
 *
 *     sqlite3 <file>                  -> no sidecars remain
 *     sqlite3 "file:<file>?mode=ro"   -> -wal and -shm REMAIN
 *
 * A read-only connection must still build the WAL shared-memory index in order
 * to read a WAL database, and then lacks the write permission required to
 * remove it on close. A read-WRITE open cleans up after itself; the read-only
 * one cannot. So the safest-looking invocation is the one that leaves traces.
 *
 * This matters twice over. It is why stray `-wal`/`-shm` pairs appear in
 * directories where nobody ran a writer. And it is why a matching file hash
 * proves no CONTENT changed but does not prove nothing WROTE — the distinction
 * that made this opener look safer than it is during the 2026-08-28 evidence
 * handling.
 *
 * "Read-only" here means: no schema application, no row writes, no file
 * creation. It does NOT mean zero filesystem effect.
 */
export function runStoreExists(explicit?: string): boolean {
  return existsSync(resolveDbPath(explicit))
}

export function openDbReadOnly(explicit?: string): Database.Database {
  const path = resolveDbPath(explicit)
  if (!existsSync(path)) {
    throw new Error(
      `[pipeline-runs] refusing to open a database that does not exist: ${path}\n` +
      '  A diagnostic must never CREATE the store it is diagnosing — an empty\n' +
      '  database reads as "healthy" and is a decoy, not an answer.\n' +
      '  Set PIPELINE_RUNS_DB explicitly, or run from the repository root.',
    )
  }
  return new Database(path, { readonly: true, fileMustExist: true })
}

/** Close the cached connection. Used by tests and graceful shutdown. */
export function closeDb(): void {
  if (_cached) { _cached.close(); _cached = null }
}
