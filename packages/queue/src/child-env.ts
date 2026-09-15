// THE CANONICAL CHILD ENVIRONMENT — one builder, two callers.
//
// `processor.ts` (DAG stages) and `bin/run-stage.ts` (alerts, manual refresh)
// both spawn application code that reaches PostgreSQL. Both must hand that code
// exactly one database credential and nothing else. Implementing the filter
// twice would mean two places to forget a variable, so there is one function and
// both callers use it; a test runs the same fixture through both and compares.
//
// WHY THE ORDER IS WHAT IT IS.
//
//   1. copy baseEnv        — never mutate the caller's environment
//   2. apply specEnv       — a JobSpec's own additions
//   3. apply additions     — PATH, DATA_ROOT, run identifiers
//   4. SANITIZE            — after 2 and 3, deliberately
//   5. assign DATABASE_URL — last, from the validated credential
//
// Step 4 comes after steps 2 and 3, not before. Sanitizing first would leave a
// hole: any future caller that passed PGHOST or a *_DATABASE_URL through specEnv
// or additions would reintroduce an authority variable that nothing afterwards
// removes. Sanitizing last means it does not matter where a variable came from.
//
// Step 5 is last so no input can override the destination. A JobSpec setting
// `env: { DATABASE_URL: … }` is silently overridden rather than obeyed, which is
// the whole point: the credential is the worker's decision, not the job's.

/** Ambient PostgreSQL variables. */
const PG_VARIABLE = /^PG[A-Z0-9_]*$/

/** Any per-role credential: DATABASE_URL, DASHBOARD_DATABASE_URL, … */
const DATABASE_URL_VARIABLE = /_DATABASE_URL$/

/** Authority controls that change what a connection is allowed to do. */
const AUTHORITY_VARIABLES = ['MIGRATION_OWNER_ROLE', 'LIVE_DATABASE_NAMES']

/**
 * True if `key` must never reach a spawned stage.
 *
 * The PG rule is `^PG[A-Z0-9_]*$` rather than `^PG[A-Z]*$` because libpq has
 * variables with underscores and digits — `PGCONNECT_TIMEOUT` is the one that
 * exposed the narrower pattern. Measured against seventeen real libpq names, the
 * narrow form misses exactly that one; the broad form misses none.
 *
 * The broad form would also strip a hypothetical unrelated `PGP_KEY`. A
 * repository-wide search found no PG-prefixed non-PostgreSQL variable, and the
 * trade is deliberate: over-stripping an unrelated variable fails loudly in the
 * stage that needs it, while under-stripping a libpq variable silently
 * redirects a connection.
 */
export function isForbiddenChildVariable(key: string): boolean {
  if (key === 'DATABASE_URL') return true
  if (DATABASE_URL_VARIABLE.test(key)) return true
  if (PG_VARIABLE.test(key)) return true
  return AUTHORITY_VARIABLES.includes(key)
}

/**
 * Build the environment a spawned stage receives.
 *
 * Pure: `baseEnv`, `specEnv` and `additions` are read, never written.
 *
 * @param pipelineCredential an ALREADY-VALIDATED PIPELINE_DATABASE_URL. This
 *   function does not validate; callers obtain it from
 *   requirePipelineCredential() before any child exists.
 */
export function buildPipelineChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  specEnv: Record<string, string> | undefined,
  pipelineCredential: string,
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  for (const [k, v] of Object.entries(specEnv ?? {})) env[k] = v
  for (const [k, v] of Object.entries(additions)) env[k] = v

  for (const key of Object.keys(env)) {
    if (isForbiddenChildVariable(key)) delete env[key]
  }

  // PIPELINE_DATABASE_URL is removed by the rule above (it ends in
  // _DATABASE_URL) and is deliberately NOT re-added: no traced child reads it,
  // and one name per process keeps "which credential am I holding" answerable.
  env.DATABASE_URL = pipelineCredential

  return env
}
