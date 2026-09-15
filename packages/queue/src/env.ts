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

import { readCredentialFile } from './credential-file.js'

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

/** The one role a pipeline credential may name. */
export const PIPELINE_ROLE = 'ai_capital_pipeline'

/** Direct-value mode: the credential itself, for tests and manual runs. */
export const PIPELINE_URL_VAR = 'PIPELINE_DATABASE_URL'

/** File mode: the absolute path of a file holding the credential. */
export const PIPELINE_FILE_VAR = 'PIPELINE_CREDENTIAL_FILE'

/**
 * Obtain and validate the pipeline credential.
 *
 * CALLED BY EXACTLY THREE ENTRYPOINTS — bin/worker.ts, bin/structured-worker.ts
 * and bin/run-stage.ts — and deliberately NOT by ensurePipelineEnv(). That
 * distinction is the whole boundary: ensurePipelineEnv() runs in ten bins, five
 * of which (submit, run-daily, smoke, queue-health, reconcile) never reach
 * PostgreSQL and must not be made to hold a production write credential merely
 * because they share a startup helper. Putting the file read there would have
 * recreated, through a different door, exactly the root-.env defect this slice
 * removed.
 *
 * TWO EXPLICIT SOURCES, AND EXACTLY ONE OF THEM. This is SOURCE SELECTION, not
 * fallback:
 *
 *   PIPELINE_DATABASE_URL     the credential itself — tests, deliberate manual runs
 *   PIPELINE_CREDENTIAL_FILE  an ABSOLUTE path to a file holding it — the plists
 *
 * Both set is a refusal, not a precedence rule: two sources of truth means an
 * operator can rotate one and keep running on the other without noticing. Neither
 * set is a refusal. There is NO implicit default path and no HOME-derived
 * location — nothing in this function guesses where a credential might live, so
 * a misconfigured job fails loudly instead of quietly finding something.
 *
 * THE FILE-LOADED VALUE NEVER TOUCHES process.env. It is returned as a local
 * string and handed explicitly to processJob() and buildPipelineChildEnv(). A
 * value in process.env is visible to every later reader, inherited by any child
 * created without an explicit environment, and captured by crash dumps; a local
 * is not. This also keeps the existing guarantee — nothing downstream re-reads
 * the environment for the credential — literally true.
 *
 * Validation is the canonical one, extended with the exact role: a credential
 * for a broader role satisfies every syntactic check and is still an escalation.
 * Errors name the variable and never the value.
 */
export function requirePipelineCredential(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = readCredentialFile,
): string {
  const direct = env[PIPELINE_URL_VAR]
  const file = env[PIPELINE_FILE_VAR]
  const directSet = direct !== undefined
  const fileSet = file !== undefined

  if (directSet && fileSet) {
    throw new Error(
      `@common/queue: both ${PIPELINE_URL_VAR} and ${PIPELINE_FILE_VAR} are set. ` +
      'Exactly one credential source must be chosen; there is no precedence rule ' +
      'between them, because two sources of truth let a rotation of one go unnoticed ' +
      'while the process keeps running on the other.',
    )
  }
  if (!directSet && !fileSet) {
    throw new Error(
      `@common/queue: neither ${PIPELINE_URL_VAR} nor ${PIPELINE_FILE_VAR} is set. ` +
      'This credential has no fallback and no default location — it never borrows ' +
      'DATABASE_URL, a PG* variable, or a path derived from HOME.',
    )
  }

  if (directSet) {
    return requireExplicitPostgresUrl(PIPELINE_URL_VAR, direct, { user: PIPELINE_ROLE })
  }
  // File mode. The loader returns bytes; every rule about what a credential may
  // look like still belongs to the canonical validator below.
  return requireExplicitPostgresUrl(PIPELINE_FILE_VAR, readFile(file as string), { user: PIPELINE_ROLE })
}
