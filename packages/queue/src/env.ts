// Shared env setup — keeps the queue's view of paths consistent with daily.sh.
//
// daily.sh exports:
//   PIPELINE_RUNS_DB="$ROOT/data/pipeline-runs.db"
//   DATA_ROOT="$ROOT/apps"
//
// Both bins (submit, worker, smoke) need the same anchoring so parent and
// child pipeline_runs rows land in the same SQLite file.

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { parse as parseDotenv } from 'dotenv'

import { requireExplicitPostgresUrl } from '@common/db/credential-url'

/** Absolute path to the monorepo root (the dir that holds pnpm-workspace.yaml). */
export function workspaceRoot(): string {
  // packages/queue/src/env.ts → ../../../ = repo root
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

/**
 * The ONLY keys the root .env may contribute to a queue process.
 *
 * Everything outside this list is ignored, which is the point. The root .env
 * carries database credentials; a queue process has no caller for any of them
 * and must not hold them merely because they share a file with two API keys.
 *
 * Stages mostly configure themselves — 11 apps ship their own .env and there are
 * 40 `dotenv/config` imports — so this list covers only what a stage cannot get
 * locally. It is deliberately short and deliberately explicit: adding a key here
 * is a decision, not a side effect of editing a file.
 */
export const APPROVED_ROOT_ENV_KEYS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'SEC_FUND_API_KEY',
])

/**
 * Copy approved root-.env keys into `target`, and nothing else.
 *
 * WHY NOT process.loadEnvFile(). It writes the WHOLE file into process.env
 * before any code can look at it, so a credential is installed first and
 * "removed" afterwards — which is not the same as never installing it. A
 * crash, a read, or a child spawned in between would see it. This reads the
 * file, parses it in memory, and assigns only allowlisted keys. No database or
 * PG* value is ever written to `target`.
 *
 * WHY dotenv's PARSER AND NOT node:util's. The repository declares
 * `engines.node: ">=20"`, and parseEnv landed in Node 20.12. Using it would
 * make a supported runtime crash at import time on a machine that satisfies the
 * declared engine. dotenv is already a direct dependency of eleven workspace
 * packages and its `parse` export is a pure string-to-object function. Only that
 * export is imported: `dotenv/config` would write straight into process.env,
 * which is the behaviour this function exists to avoid.
 *
 * FAILURE IS LOUD, NOT SILENT. A missing file is a legitimate state and a
 * no-op. A file that EXISTS but cannot be read — wrong permissions, a truncated
 * mount, an I/O error — is not: swallowing it would start a worker whose API
 * keys are silently absent, and the first symptom would be a stage failing far
 * away for an unrelated-looking reason. So every failure other than ENOENT
 * throws, naming the operation and the path and never the contents.
 *
 * The real environment still wins: a value supplied by launchd or an export is
 * never overwritten by the file.
 *
 * `target` is injected rather than assumed to be process.env so tests can prove
 * the behaviour without mutating the global environment.
 */
export function loadApprovedRootEnv(
  root: string,
  target: NodeJS.ProcessEnv,
  allowed: readonly string[] = APPROVED_ROOT_ENV_KEYS,
): void {
  const envPath = join(root, '.env')

  let contents: string
  try {
    contents = readFileSync(envPath, 'utf-8')
  } catch (e) {
    // ENOENT is the ordinary "there is no root .env here" case — for example a
    // fresh clone, or a machine where every value arrives from launchd.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(
      `@common/queue: could not read ${envPath} (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}). ` +
      'Fix the file or remove it; its contents are never reported.',
    )
  }

  let parsed: Record<string, string>
  try {
    parsed = parseDotenv(contents)
  } catch (e) {
    // The parser is lenient by design and normally returns whatever it could
    // understand. If it ever does throw, that is a real fault and must surface —
    // redacted, because the thing it failed on is the file's content.
    throw new Error(
      `@common/queue: could not parse ${envPath} (${(e as Error).name}). ` +
      'Its contents and values are never reported.',
    )
  }

  for (const key of allowed) {
    const value = parsed[key]
    if (typeof value === 'string' && target[key] === undefined) {
      target[key] = value
    }
  }
}

/**
 * Set PIPELINE_RUNS_DB and DATA_ROOT to the monorepo defaults unless the caller
 * already set them, and copy the approved root-.env keys. Called once at the top
 * of each bin entry point.
 *
 * This function deliberately does NOT validate a database credential: most bins
 * (submit, run-daily, smoke, health, reconcile) never reach PostgreSQL and must
 * not be made to hold one. Only the workers and the launcher call
 * requirePipelineCredential().
 */
export function ensurePipelineEnv(): void {
  const root = workspaceRoot()

  loadApprovedRootEnv(root, process.env)

  if (!process.env.PIPELINE_RUNS_DB) {
    process.env.PIPELINE_RUNS_DB = join(root, 'data', 'pipeline-runs.db')
  }
  if (!process.env.DATA_ROOT) {
    process.env.DATA_ROOT = join(root, 'apps')
  }
}

/**
 * Validate PIPELINE_DATABASE_URL and return the exact validated string.
 *
 * Called ONLY by the two workers and the launcher — the three entrypoints that
 * spawn PostgreSQL-touching children. It uses the same canonical validator as
 * the dashboard pool and the claim writer, so "explicit scheme, user, host and
 * database, no ambient completion, whitespace refused not trimmed" means the
 * same thing in all three places.
 *
 * The returned string is what the caller must hand onward; nothing downstream
 * re-reads the environment for it. A rotated credential therefore requires an
 * intentional worker restart rather than taking effect mid-process.
 */
export function requirePipelineCredential(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireExplicitPostgresUrl('PIPELINE_DATABASE_URL', env.PIPELINE_DATABASE_URL)
}
