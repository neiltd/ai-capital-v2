// Parsing and validation of an explicitly supplied business logical date.
//
// WHY THIS EXISTS. The scheduler evaluates eligibility for a specific logical
// date and then invoked daily-queue.sh without passing it, so run-daily.ts
// recomputed `logicalRunDate(new Date())`. A submission approved at 23:59:50
// Los Angeles and enqueued at 00:00:05 was approved for one business date and
// structurally claimed the next — the uniqueness rule then protected the wrong
// day, and the approved day stayed unclaimed.
//
// The approved date now travels as an explicit argument. It is never
// recomputed once supplied.

/** Exactly YYYY-MM-DD, and a real calendar date. */
// Imported and re-exported, not reimplemented: one definition of what a logical
// date is, shared with the assessment seam that consumes it.
import { isValidLogicalDate } from '@common/pipeline-runs'
export { isValidLogicalDate }

export type LogicalDateArg =
  | { ok: true; logicalDate: string; supplied: boolean }
  | { ok: false; error: string }

/**
 * Resolve the logical date for a submission.
 *
 * `--logical-date <YYYY-MM-DD>` wins and is never second-guessed. Absent, the
 * caller's default applies, which preserves direct/manual invocation of
 * run-daily.ts. A present-but-missing or malformed value is an ERROR, never a
 * silent fallback: falling back would reintroduce exactly the recomputation
 * this argument exists to remove.
 */
export function resolveLogicalDateArg(argv: string[], fallback: () => string): LogicalDateArg {
  const i = argv.indexOf('--logical-date')
  if (i === -1) return { ok: true, logicalDate: fallback(), supplied: false }

  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    return { ok: false, error: '--logical-date requires a YYYY-MM-DD value' }
  }
  if (!isValidLogicalDate(value)) {
    return { ok: false, error: `--logical-date must be an exact calendar date in YYYY-MM-DD form, got "${value}"` }
  }
  return { ok: true, logicalDate: value, supplied: true }
}
