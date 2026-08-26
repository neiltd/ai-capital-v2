import { AsyncLocalStorage } from 'node:async_hooks'
import { liveDatabaseNames, resolveDestination, destinationOf } from './pool.js'

/**
 * ── Production-write intent ────────────────────────────────────────────────
 *
 * THE INVARIANT:
 *
 *   Possessing a production write credential is not itself sufficient to
 *   perform a production write. Production mutation requires explicit
 *   production intent.
 *
 * WHY THIS EXISTS. Every guard built during the 2026-08-25/26 incident
 * response keyed on `inTestRuntime()` — i.e. on `process.env.VITEST`. Warden
 * pointed out the obvious consequence: OUTSIDE vitest nothing was guarded at
 * all. `.env` carries CLAIM_WRITER_DATABASE_URL, so any ad-hoc `tsx` run that
 * sourced it and reached a persistence function would write straight to the
 * real book — the identical shape of the ad-hoc-CLI hazard that lost the CRWD
 * 4:1 split adjustment on 2026-07-05.
 *
 * WHY IT IS A CALL SCOPE AND NOT AN ENVIRONMENT VARIABLE. This is the whole
 * design. An env var is exactly the wrong instrument here:
 *
 *   - it can be set once in `.env` and then be permanently, invisibly true;
 *   - it is inherited by every child process for free;
 *   - it grants authority by AMBIENT PRESENCE, which is the property that
 *     caused the incident in the first place.
 *
 * A `withProductionWrite()` scope has none of those properties. It cannot be
 * granted by a file, cannot be inherited across a process boundary, and exists
 * only for the duration of a call that names its operation and states a
 * reason in the source. That makes every authorization site greppable and
 * reviewable, and makes accidental authorization essentially impossible: you
 * do not enter this scope by accident, you enter it by typing it.
 *
 * WHAT THIS IS NOT. This is defence in depth ABOVE the PostgreSQL roles, not a
 * replacement for them. The database remains the final authority: the agent
 * role holds SELECT and nothing else, the test-runtime role cannot CONNECT to
 * production at all, and the claim writer is scoped to two tables. If this
 * layer is ever bypassed, those still hold.
 */

/** Operation classes. A closed set — an unrecognised string will not type-check. */
export type WriteOperation =
  | 'claim-persistence'   // desk.agent_claims / desk.agent_runs
  | 'pipeline-write'      // a DAG stage persisting its own output
  | 'migration'           // schema change via db-migrate
  | 'admin-repair'        // a deliberate, disclosed operator correction

/**
 * Which kind of runtime opened the scope. Recorded rather than trusted: it
 * annotates the authorization for later audit, it does not grant it.
 */
export type WriteContext = 'pipeline' | 'migration' | 'admin'

export interface WriteIntent {
  operation: WriteOperation
  context: WriteContext
  /** Free text, REQUIRED and non-empty. Shows up in errors and audit output. */
  reason: string
}

interface IntentBox { intent: WriteIntent; open: boolean }

const store = new AsyncLocalStorage<IntentBox>()

/**
 * The intent in force for the current async call chain, if any.
 *
 * The `open` flag is load-bearing. AsyncLocalStorage propagates to every async
 * resource CREATED inside a scope, and those resources keep the context after
 * the scope returns. Warden demonstrated four live escapes: a floating promise
 * awaited outside, a `setTimeout` scheduled inside, `process.nextTick`, and an
 * explicit `AsyncResource.bind` capture-and-replay. Each of them authorized a
 * production write after the authorization had supposedly ended.
 *
 * The dangerous real-world shape is a missing `await`:
 *   withProductionWrite(..., async () => { void ingestAgentOutput(...) })
 * which authorizes a write that lands at an arbitrary later time — or a
 * setInterval flusher started inside a scope, which would hold production
 * authority for the lifetime of the process.
 *
 * Closing the box on the way out makes the authorization expire with the call
 * rather than with the async context.
 */
export function currentWriteIntent(): WriteIntent | undefined {
  const box = store.getStore()
  return box?.open ? box.intent : undefined
}

/**
 * Declare explicit production-write intent for the duration of `fn`.
 *
 * Deliberately verbose at the call site. A reader scanning for "what in this
 * repository is allowed to mutate the real book" should find every such site
 * with one grep, and each one should say why.
 */
export function withProductionWrite<T>(intent: WriteIntent, fn: () => Promise<T>): Promise<T> {
  if (!intent.reason?.trim()) {
    throw new Error(
      '@common/db: withProductionWrite requires a non-empty `reason`. ' +
      'An authorization nobody can explain later is not an authorization.',
    )
  }
  // NOTE: this deliberately does NOT refuse inside a test runtime, and it has
  // no environment-variable exemption. An earlier draft of mine added
  // ALLOW_TEST_PRODUCTION_INTENT so the unit tests could open a scope — which
  // is exactly the "env var that quietly ends up permanent in .env" this whole
  // mechanism exists to avoid. It is unnecessary: authorization and isolation
  // are independent layers. A test may declare intent all it likes and still
  // cannot reach production, because the connection factory refuses a
  // protected destination under vitest and ai_capital_test_runtime has no
  // CONNECT privilege there. Keeping the two concerns separate is what lets
  // this layer be tested honestly rather than through a backdoor.
  const box: IntentBox = { intent, open: true }
  return store.run(box, async () => {
    try { return await fn() } finally { box.open = false }
  })
}

/**
 * True when this connection string names a database we protect.
 *
 * Resolves the way pg does — a path-less URL still reaches PGDATABASE. The
 * first version read only the connection string and Warden walked straight
 * through it with `postgres://user@host:5432` + `PGDATABASE=ai_capital`.
 */
export function isProtectedDestination(connectionString: string): boolean {
  const name = resolveDestination(connectionString)
  return !!name && liveDatabaseNames().includes(name)
}

/** Raised when a destination cannot be determined at all. */
export class UndeterminableDestination extends Error {
  constructor(operation: WriteOperation) {
    super(
      `@common/db: REFUSED a ${operation} write — the destination database could not be\n` +
      'determined from the connection string, PGDATABASE, or the environment.\n' +
      '\n' +
      'Cannot prove safe must never mean allowed. Every other guard in this\n' +
      'package fails closed on an undeterminable destination; this one does too.\n' +
      'Name the database explicitly.',
    )
    this.name = 'UndeterminableDestination'
  }
}

export class ProductionWriteRefused extends Error {
  readonly destination: string
  readonly operation: WriteOperation
  constructor(destination: string, operation: WriteOperation) {
    super(
      `@common/db: REFUSED a ${operation} write before issuing any SQL.\n` +
      `  protected destination : ${destination}\n` +
      `  operation class       : ${operation}\n` +
      `  authorization         : ABSENT — no withProductionWrite() scope is active\n` +
      '\n' +
      'Possessing a production credential is not authorization to use it. This\n' +
      'process holds a credential for a protected database but never declared\n' +
      'production intent, which is what an accidental ad-hoc run looks like.\n' +
      '\n' +
      'If the write is genuinely intended, wrap the call:\n' +
      "  await withProductionWrite({ operation: '" + operation + "', context: 'admin',\n" +
      "                              reason: 'why this run may touch the real book' },\n" +
      '                            () => ...)\n' +
      '\n' +
      'Nothing was written, and nothing was silently redirected to a test\n' +
      'database — a silent fallback would make the caller believe it had\n' +
      'persisted when it had not.',
    )
    this.name = 'ProductionWriteRefused'
    this.destination = destination
    this.operation = operation
  }
}

/**
 * Fail closed BEFORE any SQL is issued.
 *
 * Only protected destinations are gated. Writing to a throwaway or test
 * database needs no ceremony, which is what keeps the whole test suite
 * untouched by this layer.
 */
export function assertProductionWriteAuthorized(
  connectionString: string | undefined,
  operation: WriteOperation,
): void {
  // FAIL CLOSED. The first version treated "cannot determine" as "not
  // protected" — a polarity inversion, and the root of every bypass Warden
  // found. An absent or unresolvable destination is refused, not waved through.
  if (connectionString !== undefined && connectionString.trim() === '') {
    throw new UndeterminableDestination(operation)
  }
  const name = connectionString === undefined
    ? resolveDestination(undefined)
    : resolveDestination(connectionString)
  if (!name) throw new UndeterminableDestination(operation)

  if (!liveDatabaseNames().includes(name)) return   // throwaway target: no ceremony

  const intent = currentWriteIntent()
  if (!intent || intent.operation !== operation) throw new ProductionWriteRefused(name, operation)
}

/**
 * Authorize against the destination a POOL was actually built with, not against
 * whatever the environment says right now.
 *
 * This is the TOCTOU fix: `getPool()` caches, so the environment can change
 * after the pool is warm. Falls back to environment resolution only for a pool
 * that carries no recorded destination, and even then fails closed.
 */
export function assertPoolWriteAuthorized(pool: unknown, operation: WriteOperation): void {
  const recorded = destinationOf(pool)
  if (recorded) {
    if (!liveDatabaseNames().includes(recorded)) return
    const intent = currentWriteIntent()
    if (!intent || intent.operation !== operation) throw new ProductionWriteRefused(recorded, operation)
    return
  }
  throw new UndeterminableDestination(operation)
}
