import { AsyncLocalStorage } from 'node:async_hooks'
import { databaseNameOf, liveDatabaseNames } from './pool.js'

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

const store = new AsyncLocalStorage<WriteIntent>()

/** The intent in force for the current async call chain, if any. */
export function currentWriteIntent(): WriteIntent | undefined {
  return store.getStore()
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
  return store.run(intent, fn)
}

/** True when this connection string names a database we protect. */
export function isProtectedDestination(connectionString: string): boolean {
  const name = databaseNameOf(connectionString)
  return !!name && liveDatabaseNames().includes(name)
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
export function assertProductionWriteAuthorized(connectionString: string, operation: WriteOperation): void {
  if (!isProtectedDestination(connectionString)) return

  const intent = currentWriteIntent()
  if (!intent) throw new ProductionWriteRefused(databaseNameOf(connectionString)!, operation)

  if (intent.operation !== operation) {
    throw new ProductionWriteRefused(databaseNameOf(connectionString)!, operation)
  }
}
