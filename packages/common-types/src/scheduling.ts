// Scheduling intent — orthogonal to source availability.
//
// WHY IT IS SEPARATE. Availability answers "can we read this source right now?"
// and has exactly five states: current | stale | unavailable | restricted |
// unknown. Whether we CHOOSE to poll a source on a schedule is a different
// question, and folding it in as a sixth availability state would corrupt the
// vocabulary: a dormant source is not unavailable, and it is certainly not
// current. So dormancy never rewrites an availability verdict — it sits beside
// one, and the last-known verdict stays exactly as the evidence left it.
//
// This lives in common-types rather than in the queue package so the scheduler
// and the operator surfaces can agree on one flag without the dashboard taking
// a dependency on the queue.

/** Whether scheduled collection is configured to run for a source. */
export type SourceScheduling = 'scheduled' | 'dormant'

/**
 * Structured-event (GDELT/ACLED/UCDP) and energy/macro (EIA/WorldBank)
 * ingestion is DORMANT unless this is explicitly set to 'true'.
 *
 * The flag governs SUBMISSION only. It is not sufficient on its own: the
 * dedicated structured worker must be installed and verified first, or enabling
 * this enqueues jobs that nothing drains. The source contract is
 * DORMANT / ACTIVATION-READY, not one-flag-operational.
 *
 * Bare SCREAMING_SNAKE matches the repository's existing convention
 * (FORCE_SUNDAY, PIPELINE_RUNS_DB, REDIS_URL) — no new prefix, no feature-flag
 * framework.
 */
export const STRUCTURED_INGESTION_SCHEDULE_ENV = 'SCHEDULE_STRUCTURED_INGESTION'

/** The sources whose scheduled collection this flag governs. */
export const STRUCTURED_INGESTION_SOURCES = ['gdelt', 'acled', 'ucdp', 'eia', 'worldbank'] as const

/**
 * Dormant unless explicitly enabled. Opt-in, so a missing env is never "on".
 * The environment is passed in rather than read here: this package carries no
 * Node types, and an injected env is what makes the flag testable.
 */
export function structuredIngestionScheduled(
  env: Record<string, string | undefined>,
): boolean {
  return env[STRUCTURED_INGESTION_SCHEDULE_ENV]?.toLowerCase() === 'true'
}

/** Scheduling intent for one source name, given the current configuration. */
export function schedulingFor(
  source: string,
  env: Record<string, string | undefined>,
): SourceScheduling {
  const governed = (STRUCTURED_INGESTION_SOURCES as readonly string[]).includes(source)
  if (!governed) return 'scheduled'          // article feeds are unaffected
  return structuredIngestionScheduled(env) ? 'scheduled' : 'dormant'
}
