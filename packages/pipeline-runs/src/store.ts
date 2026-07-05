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

/** Close the cached connection. Used by tests and graceful shutdown. */
export function closeDb(): void {
  if (_cached) { _cached.close(); _cached = null }
}
