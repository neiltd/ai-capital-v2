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
  metadata_json   TEXT
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
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA)
  _cached = db
  return db
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
