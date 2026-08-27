import { randomUUID } from 'crypto'
import { openDb, openDbReadOnly, runStoreExists } from './store.js'
import type {
  PipelineRun,
  RecordStartInput,
  RecordEndInput,
  DashboardSummary,
  StageSummary,
} from './types.js'

interface Row {
  id:              string
  parent_run_id:   string | null
  stage:           string
  source:          string | null
  started_at:      string
  ended_at:        string | null
  duration_ms:     number | null
  status:          string
  doc_count:       number | null
  chunk_count:     number | null
  ticker_count:    number | null
  error_message:   string | null
  error_stack:     string | null
  metadata_json:   string | null
}

function rowToRun(r: Row): PipelineRun {
  return {
    id:           r.id,
    parentRunId:  r.parent_run_id,
    stage:        r.stage,
    source:       r.source,
    startedAt:    r.started_at,
    endedAt:      r.ended_at,
    durationMs:   r.duration_ms,
    status:       r.status as PipelineRun['status'],
    docCount:     r.doc_count,
    chunkCount:   r.chunk_count,
    tickerCount:  r.ticker_count,
    errorMessage: r.error_message,
    errorStack:   r.error_stack,
    metadata:     r.metadata_json ? JSON.parse(r.metadata_json) as Record<string, unknown> : null,
  }
}

/** Insert a new in-flight run row. Returns the generated runId. */
export function recordStart(input: RecordStartInput, dbPath?: string): string {
  const db = openDb(dbPath)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO pipeline_runs
      (id, parent_run_id, stage, source, started_at, status, metadata_json)
    VALUES
      (?,  ?,             ?,     ?,      ?,          'running', ?)
  `).run(
    id,
    input.parentRunId ?? null,
    input.stage,
    input.source ?? null,
    new Date().toISOString(),
    input.metadata ? JSON.stringify(input.metadata) : null,
  )
  return id
}

/** Mark a run complete (success / failed / killed / timeout). */
export function recordEnd(runId: string, input: RecordEndInput, dbPath?: string): void {
  const db = openDb(dbPath)
  const existing = db.prepare(
    'SELECT started_at FROM pipeline_runs WHERE id = ?'
  ).get(runId) as { started_at: string } | undefined
  if (!existing) {
    // Loud, but don't throw — observability that crashes its host is worse than missing data.
    console.warn(`[pipeline-runs] recordEnd called with unknown runId: ${runId}`)
    return
  }
  const endedAt = new Date()
  const durationMs = endedAt.getTime() - new Date(existing.started_at).getTime()

  const errMessage = input.error?.message ?? null
  const errStack   = input.error && 'stack' in input.error ? (input.error.stack ?? null) : null

  db.prepare(`
    UPDATE pipeline_runs
       SET ended_at      = ?,
           duration_ms   = ?,
           status        = ?,
           doc_count     = COALESCE(?, doc_count),
           chunk_count   = COALESCE(?, chunk_count),
           ticker_count  = COALESCE(?, ticker_count),
           error_message = ?,
           error_stack   = ?,
           metadata_json = COALESCE(?, metadata_json)
     WHERE id = ?
  `).run(
    endedAt.toISOString(),
    durationMs,
    input.status,
    input.docCount  ?? null,
    input.chunkCount ?? null,
    input.tickerCount ?? null,
    errMessage,
    errStack,
    input.metadata ? JSON.stringify(input.metadata) : null,
    runId,
  )
}

/** Wrap a callable. Records start + automatic end (status inferred from throw). */
export async function withRun<T>(
  input: RecordStartInput,
  fn: (runId: string) => Promise<T>,
  dbPath?: string,
): Promise<T> {
  const runId = recordStart(input, dbPath)
  try {
    const result = await fn(runId)
    recordEnd(runId, { status: 'success' }, dbPath)
    return result
  } catch (err) {
    recordEnd(
      runId,
      { status: 'failed', error: err instanceof Error ? err : { message: String(err) } },
      dbPath,
    )
    throw err
  }
}

/**
 * An absent run store means "nothing has run yet", not an error.
 *
 * Before the read paths moved to the read-only opener, `openDb` silently
 * CREATED the database, so no caller ever met this case — which is exactly the
 * decoy-database defect: a freshly created empty store reads as "no pipeline
 * problems". Returning an explicit empty summary keeps the dashboard honest on
 * a fresh clone instead of either crashing or inventing a healthy answer.
 */
const EMPTY_SUMMARY: DashboardSummary = { generatedAt: new Date(0).toISOString(), stages: [], inFlight: [] }

/**
 * READ PATH — uses the read-only opener deliberately.
 *
 * These three functions are the only ones here that issue no INSERT/UPDATE/
 * DELETE. `recordStart`, `recordEnd` and `reapOrphans` genuinely write and keep
 * `openDb`; switching those would break them.
 *
 * The reason this matters is not tidiness. `openDb` runs `mkdirSync`, creates
 * the file if absent, sets `journal_mode = WAL` and executes the schema. An
 * unauthenticated `GET /api/status` and the ungated `/system/pipeline` page
 * both reached this code, so a read request could take a write lock on the
 * production run database — and manufacture an empty one if the real file were
 * missing, which reads as "no pipeline problems" rather than as an error.
 *
 * Authentication decides WHO may call these. The opener decides what calling
 * them DOES. They are independent controls and both are needed.
 */
export function getRecentRuns(stage: string, limit: number, dbPath?: string): PipelineRun[] {
  if (!runStoreExists(dbPath)) return []
  const db = openDbReadOnly(dbPath)
  const rows = db.prepare(`
    SELECT * FROM pipeline_runs
     WHERE stage = ?
     ORDER BY started_at DESC
     LIMIT ?
  `).all(stage, limit) as Row[]
  return rows.map(rowToRun)
}

export function getInFlightRuns(dbPath?: string): PipelineRun[] {
  if (!runStoreExists(dbPath)) return []
  const db = openDbReadOnly(dbPath)
  const rows = db.prepare(`
    SELECT * FROM pipeline_runs
     WHERE status = 'running'
     ORDER BY started_at ASC
  `).all() as Row[]
  return rows.map(rowToRun)
}

export function getDashboardSummary(dbPath?: string): DashboardSummary {
  if (!runStoreExists(dbPath)) return EMPTY_SUMMARY
  const db = openDbReadOnly(dbPath)

  const stageNames = db.prepare(`
    SELECT DISTINCT stage FROM pipeline_runs ORDER BY stage
  `).all() as Array<{ stage: string }>

  const stages: StageSummary[] = stageNames.map(({ stage }) => ({
    stage,
    latestRuns: getRecentRuns(stage, 7, dbPath),
  }))

  return {
    generatedAt: new Date().toISOString(),
    stages,
    inFlight:    getInFlightRuns(dbPath),
  }
}

/**
 * Reap runs that have been 'running' longer than `maxAgeMs`. Marks them as
 * 'timeout' so the dashboard shows a recognisable failure mode instead of a
 * forever-spinning row. Returns the IDs that were swept.
 */
export function reapOrphans(maxAgeMs: number, dbPath?: string): string[] {
  const db = openDb(dbPath)
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  const stale = db.prepare(`
    SELECT id, started_at FROM pipeline_runs
     WHERE status = 'running' AND started_at < ?
  `).all(cutoff) as Array<{ id: string; started_at: string }>

  if (stale.length === 0) return []

  const update = db.prepare(`
    UPDATE pipeline_runs
       SET status = 'timeout',
           ended_at = ?,
           duration_ms = ?,
           error_message = 'reaped: still running after maxAgeMs threshold'
     WHERE id = ?
  `)
  const now = new Date()
  for (const r of stale) {
    update.run(
      now.toISOString(),
      now.getTime() - new Date(r.started_at).getTime(),
      r.id,
    )
  }
  return stale.map(r => r.id)
}
