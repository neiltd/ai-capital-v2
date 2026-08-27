/**
 * ── Queue integration-test isolation ───────────────────────────────────────
 *
 * THE RULE: a queue integration test must have an isolated destination on ALL
 * THREE dimensions, or it must refuse to run.
 *
 *   database    PIPELINE_RUNS_DB      — where run rows go
 *   redis       REDIS_URL             — which queue is touched
 *   filesystem  AI_CAPITAL_ROOT       — where logs, locks and markers land
 *
 * WHY FAIL CLOSED. On 2026-08-27 the scheduler harness isolated the database
 * and nothing else. It wrote a FAKE `state=success logical=2026-08-27` into the
 * production scheduler log, and that line later misled an auditor into
 * suspecting a wrong-database production run. A harness that isolates two of
 * three dimensions is MORE dangerous than one that isolates none, because its
 * output looks genuine and is trusted.
 *
 * The production Redis is the sharpest of the three: a test that connects to it
 * can enqueue, consume or destroy real pipeline work — including the 228 parked
 * jobs being preserved as incident evidence.
 */

/** Redis destinations that are never acceptable from a test runtime. */
const PRODUCTION_REDIS = [
  'redis://localhost:6379',
  'redis://127.0.0.1:6379',
  'redis://[::1]:6379',
]

/** The real repository root — output must not land here from a test. */
const PRODUCTION_ROOT = '/Users/thanapold/Desktop/Projects.nosync'

export class IsolationError extends Error {
  constructor(dimension: string, detail: string) {
    super(
      `[queue-isolation] REFUSING to run: the ${dimension} destination is not isolated.\n` +
      `  ${detail}\n` +
      '\n' +
      'A queue integration test must isolate ALL THREE of:\n' +
      '  PIPELINE_RUNS_DB   an isolated SQLite path\n' +
      '  REDIS_URL          an isolated Redis instance (NOT :6379)\n' +
      '  AI_CAPITAL_ROOT    an isolated filesystem root\n' +
      '\n' +
      'Isolating some but not all is worse than isolating none: the output looks\n' +
      'genuine and gets trusted. See the 2026-08-27 fake-success-log incident.',
    )
    this.name = 'IsolationError'
  }
}

export interface IsolatedDestinations {
  redisUrl: string
  pipelineRunsDb: string
  root: string
}

/**
 * Assert all three dimensions are isolated, or throw.
 *
 * Deliberately checks the RESOLVED destination rather than trusting that a
 * variable was set — `REDIS_URL=redis://localhost:6379` is "set" and is exactly
 * the thing that must be refused.
 */
export function requireIsolation(env: NodeJS.ProcessEnv = process.env): IsolatedDestinations {
  const redisUrl = env.REDIS_URL
  if (!redisUrl) {
    throw new IsolationError('redis', 'REDIS_URL is unset, so the default redis://localhost:6379 would be used — that is production.')
  }
  const normalised = redisUrl.trim().replace(/\/+$/, '').toLowerCase()
  if (PRODUCTION_REDIS.includes(normalised)) {
    throw new IsolationError('redis', `REDIS_URL points at the production queue (${redisUrl}).`)
  }
  // Any :6379 on a loopback host is production here, however it is spelled.
  if (/^redis:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:6379)?(\/|$)/.test(normalised)) {
    throw new IsolationError('redis', `REDIS_URL resolves to the production queue port (${redisUrl}).`)
  }

  const pipelineRunsDb = env.PIPELINE_RUNS_DB
  if (!pipelineRunsDb) {
    throw new IsolationError('database', 'PIPELINE_RUNS_DB is unset, so the production run database would be used.')
  }
  if (pipelineRunsDb.startsWith(`${PRODUCTION_ROOT}/data/`)) {
    throw new IsolationError('database', `PIPELINE_RUNS_DB points inside the production data directory (${pipelineRunsDb}).`)
  }

  const root = env.AI_CAPITAL_ROOT
  if (!root) {
    throw new IsolationError('filesystem', 'AI_CAPITAL_ROOT is unset, so logs, locks and markers would land in production paths.')
  }
  if (root === PRODUCTION_ROOT || root.startsWith(`${PRODUCTION_ROOT}/`)) {
    throw new IsolationError('filesystem', `AI_CAPITAL_ROOT is the production repository (${root}).`)
  }

  return { redisUrl, pipelineRunsDb, root }
}
