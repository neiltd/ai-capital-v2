import {
  resolveRedisEndpoint, canonicalPath, isInsideProductionRepo, DestinationError, PRODUCTION_REPO,
} from './destinations.js'

/**
 * ── All-or-nothing isolation ───────────────────────────────────────────────
 *
 * THE INVARIANT:
 *
 *   An environment is either FULLY isolated — database, Redis, filesystem AND
 *   notifications — or it is production. There is no third mode.
 *
 * WHY PARTIAL ISOLATION IS FORBIDDEN RATHER THAN DISCOURAGED. The previous
 * design isolated the filesystem while leaving credentials and submitters
 * pointed at production, and labelled the result `[TEST]`. Warden showed what
 * that buys: running the watchdog under `AI_CAPITAL_ROOT=/tmp/x` looked for the
 * LINE mute at `/tmp/x/data/line-notifications-muted` (absent), loaded the REAL
 * token from the real repo, and sent a real push to a real phone. Filesystem
 * isolation DISARMED the kill switch. The `[TEST]` prefix labelled the log line;
 * it did not label the message.
 *
 * So a label is not a safety mechanism. The mode is, and it is all four
 * dimensions together or nothing.
 */

export type IsolationMode = 'production' | 'isolated'

export interface IsolationDecision {
  mode: IsolationMode
  redisUrl: string
  redisAddresses: string[]
  pipelineRunsDb: string
  root: string
  /** In isolated mode, real notification delivery must be impossible. */
  notificationsDisabled: boolean
  reasons: string[]
}

export class PartialIsolationError extends Error {
  constructor(public readonly dimensions: string[], detail: string) {
    super(
      '[isolation] REFUSING TO RUN — the environment is PARTIALLY isolated.\n\n' +
      `  isolated : ${dimensions.filter(d => d.startsWith('+')).map(d => d.slice(1)).join(', ') || '(none)'}\n` +
      `  production: ${dimensions.filter(d => d.startsWith('-')).map(d => d.slice(1)).join(', ') || '(none)'}\n\n` +
      `  ${detail}\n\n` +
      'Partial isolation is FORBIDDEN, not merely discouraged. On 2026-08-27 a\n' +
      'filesystem-only isolated watchdog looked for the LINE mute under the\n' +
      'isolated root, did not find it, loaded the real token from the real repo,\n' +
      'and would have sent a real message. Isolating some dimensions disarms the\n' +
      'safety mechanisms that live in the others.\n\n' +
      'Set ALL of these to isolated values, or none:\n' +
      '  REDIS_URL          a non-production Redis endpoint\n' +
      '  PIPELINE_RUNS_DB   a path outside the production repository\n' +
      '  AI_CAPITAL_ROOT    a directory outside the production repository',
    )
    this.name = 'PartialIsolationError'
  }
}

/**
 * Decide the mode, or refuse.
 *
 * Every judgement is made on the CANONICAL destination — the resolved Redis
 * endpoint and the realpath'd filesystem targets — never on the spelling.
 */
export async function decideIsolation(env: NodeJS.ProcessEnv = process.env): Promise<IsolationDecision> {
  const reasons: string[] = []
  const dims: string[] = []

  // ── Redis ────────────────────────────────────────────────────────────────
  const redisUrl = env.REDIS_URL?.trim() || 'redis://localhost:6379'
  let redisIsolated: boolean
  let redisAddresses: string[] = []
  try {
    const ep = await resolveRedisEndpoint(redisUrl)
    redisAddresses = ep.addresses
    redisIsolated = !ep.isProduction
    reasons.push(`redis ${redisUrl} -> ${ep.socketPath ?? `${ep.addresses.join(',')}:${ep.port}`} ` +
                 `(${ep.isProduction ? 'PRODUCTION' : 'isolated'})`)
  } catch (e) {
    // Unresolvable is refused outright — never silently treated as isolated.
    throw new DestinationError(
      `[isolation] cannot determine the Redis destination: ${(e as Error).message}`)
  }
  dims.push(`${redisIsolated ? '+' : '-'}redis`)

  // ── Database ─────────────────────────────────────────────────────────────
  // No env var means the run database resolves relative to cwd, which IS
  // production when cwd is the repo. Absent counts as production, not isolated.
  const dbRaw = env.PIPELINE_RUNS_DB
  const pipelineRunsDb = dbRaw ? canonicalPath(dbRaw) : canonicalPath(`${PRODUCTION_REPO}/data/pipeline-runs.db`)
  const dbIsolated = dbRaw !== undefined && dbRaw.trim() !== '' && !isInsideProductionRepo(dbRaw)
  reasons.push(`db ${dbRaw ?? '(unset)'} -> ${pipelineRunsDb} (${dbIsolated ? 'isolated' : 'PRODUCTION'})`)
  dims.push(`${dbIsolated ? '+' : '-'}database`)

  // ── Filesystem ───────────────────────────────────────────────────────────
  const rootRaw = env.AI_CAPITAL_ROOT
  const root = rootRaw ? canonicalPath(rootRaw) : canonicalPath(PRODUCTION_REPO)
  const fsIsolated = rootRaw !== undefined && rootRaw.trim() !== '' && !isInsideProductionRepo(rootRaw)
  reasons.push(`root ${rootRaw ?? '(unset)'} -> ${root} (${fsIsolated ? 'isolated' : 'PRODUCTION'})`)
  dims.push(`${fsIsolated ? '+' : '-'}filesystem`)

  const isolatedCount = [redisIsolated, dbIsolated, fsIsolated].filter(Boolean).length

  if (isolatedCount === 3) {
    return {
      mode: 'isolated', redisUrl, redisAddresses, pipelineRunsDb, root,
      notificationsDisabled: true, reasons,
    }
  }
  if (isolatedCount === 0) {
    return {
      mode: 'production', redisUrl, redisAddresses, pipelineRunsDb, root,
      notificationsDisabled: false, reasons,
    }
  }
  throw new PartialIsolationError(dims, reasons.join('\n  '))
}

/** Assert full isolation, or throw. For test/dry-run entry points. */
export async function requireIsolation(env: NodeJS.ProcessEnv = process.env): Promise<IsolationDecision> {
  const d = await decideIsolation(env)
  if (d.mode !== 'isolated') {
    throw new PartialIsolationError(
      ['-redis', '-database', '-filesystem'],
      'this entry point requires a fully isolated environment and found production:\n  ' + d.reasons.join('\n  '))
  }
  return d
}

/**
 * The single canonical notification policy.
 *
 * Structurally safe: in isolated mode delivery is impossible REGARDLESS of
 * whether a mute file exists, and a production token is refused outright rather
 * than loaded-then-not-used. The mute file is only ever consulted against the
 * PRODUCTION repo, so an isolated root cannot make it disappear.
 */

