import { describe } from 'vitest'

// WHICH SIDE OF LOCKDOWN IS THIS DATABASE ON?
//
// INTEGRATION SUPPORT — USED ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// THE PROBLEM THIS SOLVES. Some facts are only true BEFORE
// ops/bootstrap/090_post_migration_lockdown.sql runs — the migrator still holds
// its role memberships and CREATE, and a further migration still applies. The
// rest are only true AFTER — no LOGIN role owns anything, the memberships are
// gone, and a migration attempt is refused. A single suite that asserted both
// would be asserting a contradiction, and the only way to make it pass would be
// to weaken one half until it said nothing.
//
// So the tenancy suite is run TWICE against the same database, with
// TENANCY_PHASE naming where in the lifecycle it is:
//
//   1. bootstrap roles + database, run migrations
//   2. TENANCY_PHASE=pre-lockdown  pnpm --filter @common/investment-ledger test:tenancy
//   3. run 090_post_migration_lockdown.sql
//   4. TENANCY_PHASE=post-lockdown pnpm --filter @common/investment-ledger test:tenancy
//
// Files declare their phase and are SKIPPED in the other one. Skipping rather
// than failing is deliberate: step 2 legitimately cannot run the post-lockdown
// assertions, and a red run there would train the operator to ignore red runs.
//
// There is deliberately NO default. A suite that guessed would report
// "post-lockdown passed" on a database where lockdown had never been applied,
// which is the single most consequential thing this whole directory exists to
// detect.

export type Phase = 'pre-lockdown' | 'post-lockdown'

export const PHASES: readonly Phase[] = ['pre-lockdown', 'post-lockdown']

export function currentPhase(): Phase {
  const value = process.env.TENANCY_PHASE?.trim()
  if (!value) {
    throw new Error(
      'TENANCY_PHASE is required and has no default. Set it to "pre-lockdown" for the ' +
      'run before ops/bootstrap/090_post_migration_lockdown.sql, and "post-lockdown" ' +
      'for the run after it. Guessing would let a post-lockdown suite report success ' +
      'on a database that was never locked down.',
    )
  }
  if (!(PHASES as readonly string[]).includes(value)) {
    throw new Error(`TENANCY_PHASE must be one of ${PHASES.join(', ')}; got "${value}"`)
  }
  return value as Phase
}

export function isPhase(phase: Phase): boolean {
  return currentPhase() === phase
}

/**
 * `describe` that runs only in the named phase.
 *
 * Implemented with `describe.skipIf` rather than a `beforeAll` that calls
 * `context.skip()`: the shape of the object passed to `beforeAll` differs
 * between vitest majors, and a guard that silently stopped working would let a
 * pre-lockdown file run its assertions against a locked-down database and fail
 * for reasons that have nothing to do with the code under test.
 *
 * `currentPhase()` throws when TENANCY_PHASE is unset, and it throws HERE — at
 * collection time, before any connection is opened. That is the intended
 * behaviour: an unset phase is a setup error, not a reason to pick one.
 */
export function describeInPhase(
  phase: Phase, name: string, body: () => void,
): void {
  describe.skipIf(!isPhase(phase))(`[${phase}] ${name}`, body)
}
