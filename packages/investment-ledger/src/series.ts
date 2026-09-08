/**
 * Archive series identity.
 *
 * THE DEFECT THIS CLOSES. Publication used to supersede "the most recent
 * archive_csv batch", whatever file it came from. A 6-row fixture, a partial
 * broker export or an unrelated CSV therefore became the successor of the
 * 621-row master archive and removed every one of its transactions from
 * `current_transactions`. That was observed live, not hypothesised.
 *
 * A series is the stable identity of a DATASET across its revisions. Two
 * imports belong to the same series when the later one is a new revision of
 * the same underlying export. Supersession, exact-rerun identity and the
 * current projection are all scoped to it, so series never interfere.
 */

/** The historical master archive: the full transaction history, all brokers. */
export const MASTER_ARCHIVE_SERIES = 'archive:master'

/** namespace:name — lowercase, no whitespace, no ambiguity. */
const SERIES_KEY = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*$/

/** Marks rows imported before series identity existed. Never a publish target. */
export const LEGACY_SERIES = 'legacy:unclassified'

/**
 * Fail closed on ambiguous or missing series identity. There is deliberately no
 * default: guessing a series is exactly how the master archive was lost.
 */
export function assertSeriesKey(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') {
    throw new Error(
      'a series key is required and has no default: name the dataset this import belongs to ' +
      `(e.g. ${MASTER_ARCHIVE_SERIES})`,
    )
  }
  const key = value.trim()
  if (!SERIES_KEY.test(key)) {
    throw new Error(
      `invalid series key '${key}': expected namespace:name in lowercase, ` +
      "e.g. 'archive:master' or 'broker:innovestx-2026q3'",
    )
  }
  if (key === LEGACY_SERIES) {
    throw new Error(
      `'${LEGACY_SERIES}' labels rows imported before series identity existed and is not a publish target`,
    )
  }
  return key
}
