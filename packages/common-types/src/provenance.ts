// Source availability — whether a consumer may treat world-intel input as
// complete current coverage.
//
// WHY THIS EXISTS. The 2026-08-29 investigation found ACLED had contributed one
// event since May and GDELT none since 2026-08-21, while every consumer read the
// resulting event list as if it were the world. The export already carried
// `meta.sourceVersions` and a `staleSourcesPresent` flag — and nothing read
// either. This is not a second freshness system; it is the classification layer
// over the provenance that was already being written.
//
// THE INVARIANT: absence of events under incomplete coverage must never become
// evidence of no events.

export const PROVENANCE_SCHEMA_VERSION = 1

/**
 * Deliberately five states, not a boolean.
 *
 *  current      — refreshed inside its freshness bound.
 *  stale        — past its bound, CAUSE NOT DIAGNOSED. A producer that has not
 *                 been scheduled looks exactly like an upstream failure from
 *                 here, and conflating them is how a frozen scheduler gets
 *                 misread as a dead feed (and vice versa).
 *  unavailable  — an observed transport/reachability failure. Requires evidence.
 *  restricted   — the upstream answers successfully but withholds the data we
 *                 need, by entitlement. DECLARED, never inferred: no amount of
 *                 retrying changes it, so it must not look like `unavailable`.
 *  unknown      — no basis for a claim. The honest default.
 */
export type SourceAvailability = 'current' | 'stale' | 'unavailable' | 'restricted' | 'unknown'

/** A standing entitlement limit. Declared in config against evidence. */
export interface SourceRestriction {
  kind: 'recency-embargo' | 'geography' | 'volume' | 'other'
  detail: string
  /** What the upstream itself said, so the claim is auditable later. */
  evidence?: string
  /** Data at least this old is still reachable, when that is the shape of it. */
  accessibleOlderThanDays?: number
}

/** An observed failure. Presence of this is what licenses `unavailable`. */
export interface SourceFailure {
  at: string
  kind: 'transport' | 'auth' | 'quota' | 'parse' | 'other'
  detail: string
}

export interface SourceProvenance {
  source: string
  /** Which evidence domain this source belongs to. Consumers must only be told
   *  about the domain they actually read — see article-provenance.ts. */
  domain?: 'article_intelligence' | 'structured_events' | 'energy_macro'
  /** Whether scheduled collection is configured for this source. ORTHOGONAL to
   *  availability: dormancy is not a sixth state and never rewrites a verdict.
   *  See scheduling.ts. */
  scheduling?: 'scheduled' | 'dormant'
  availability: SourceAvailability
  lastSuccessfulFetch: string | null
  maxStalenessHours: number
  ageHours: number | null
  /** Why this classification, in words a briefing can quote. */
  reason: string
  restriction?: SourceRestriction
  lastFailure?: SourceFailure
}

export interface ProvenanceRecord {
  schemaVersion: number
  /** When the classification was computed — NOT when it is read. */
  classifiedAt: string
  sources: SourceProvenance[]
}

export interface ClassifyInput {
  source: string
  lastSuccessfulFetch: string | null
  maxStalenessHours: number
  restriction?: SourceRestriction
  lastFailure?: SourceFailure
  /** Injected. Never `Date.now()` inside — the whole record must share one clock. */
  now: Date
}

/**
 * One clock, passed in. The previous freshness exporter computed `ageHours` from
 * an injected `now` while taking `stale` from a helper that read `Date.now()`
 * internally, so a record could contradict itself ("1h ago, past the 2h bound").
 */
export function classifySource(input: ClassifyInput): SourceProvenance {
  const { source, lastSuccessfulFetch, maxStalenessHours, restriction, lastFailure, now } = input
  const ageHours = lastSuccessfulFetch
    ? Math.round(((now.getTime() - new Date(lastSuccessfulFetch).getTime()) / 3_600_000) * 10) / 10
    : null

  const base = { source, lastSuccessfulFetch, maxStalenessHours, ageHours, restriction, lastFailure }

  // Order matters. A restriction outranks everything: the upstream is answering
  // fine, so calling it unavailable or stale would imply a retry might help.
  if (restriction) {
    return { ...base, availability: 'restricted', reason: `restricted by entitlement — ${restriction.detail}` }
  }
  if (lastFailure) {
    return { ...base, availability: 'unavailable', reason: `${lastFailure.kind} failure at ${lastFailure.at} — ${lastFailure.detail}` }
  }
  if (lastSuccessfulFetch === null || ageHours === null) {
    return { ...base, availability: 'unknown', reason: 'no successful fetch has ever been recorded' }
  }
  if (ageHours <= maxStalenessHours) {
    return { ...base, availability: 'current', reason: `refreshed ${ageHours}h ago, inside the ${maxStalenessHours}h bound` }
  }
  // NOT diagnosed as failure. We cannot tell "producer never ran" from "upstream
  // broke" with only a last-success timestamp, and guessing is how a frozen
  // scheduler gets reported as a dead feed.
  return {
    ...base,
    availability: 'stale',
    reason: `last success ${ageHours}h ago, past the ${maxStalenessHours}h bound — cause not diagnosed (the producer may simply not have run)`,
  }
}

export interface ReadProvenanceResult {
  sources: SourceProvenance[]
  /** Age of the CLASSIFICATION itself at read time. */
  recordAgeHours: number | null
  /** True when the record is too old for its verdicts to be asserted as current. */
  recordStale: boolean
  /** Any source not `current` — the set that makes coverage incomplete. */
  degraded: SourceProvenance[]
  /** Safe one-line summary for a consumer to quote. */
  summary: string
}

/**
 * Read-time evaluation. **Every time-dependent verdict is RECOMPUTED here.**
 *
 * The first version compared only the RECORD's age against one global grace
 * period and, if it was under it, passed the producer's verdicts through
 * verbatim. So a record classified at T0 kept asserting `current` for a source
 * whose own bound had since elapsed: a 29h-old record reported GDELT `current`
 * with `ageHours: 1` while the true age was 30h against a 2h bound, and
 * `coverageIsComplete` returned true. That is the normal case rather than an
 * edge case — the daily pipeline can never satisfy a 2h bound — and it renders
 * the exact "coverage complete" sentence this module exists to prevent.
 *
 * Now each source is re-derived from the evidence the record already carries:
 * `now - lastSuccessfulFetch` against **that source's own** `maxStalenessHours`.
 * No second global grace period.
 *
 *  - `restriction` is a STANDING fact about the account, not an observation, so
 *    it survives record aging and keeps outranking everything.
 *  - `lastFailure` keeps its self-expiring semantics: it applies until the
 *    source succeeds more recently than the failure was observed.
 *
 * `recordAgeHours` / `recordStale` remain reported, but as a SEPARATE signal —
 * they say whether the observational facts in the record (a declared failure,
 * say) may themselves be obsolete. They no longer gate the classification.
 */
export function readProvenance(
  record: ProvenanceRecord | null,
  now: Date,
  maxRecordAgeHours: number,
): ReadProvenanceResult {
  if (!record || !Array.isArray(record.sources)) {
    return { sources: [], recordAgeHours: null, recordStale: true, degraded: [],
      summary: 'world-intel coverage unknown: no provenance record available' }
  }

  const recordAgeHours = record.classifiedAt
    ? Math.round(((now.getTime() - new Date(record.classifiedAt).getTime()) / 3_600_000) * 10) / 10
    : null
  const recordStale = recordAgeHours === null || recordAgeHours > maxRecordAgeHours

  const sources = record.sources.map(s => {
    // Self-expiring: a declared failure stops applying once the source has
    // succeeded more recently than the failure was observed.
    const failureStillApplies = s.lastFailure && (
      !s.lastSuccessfulFetch ||
      new Date(s.lastSuccessfulFetch).getTime() <= new Date(s.lastFailure.at).getTime()
    )
    return classifySource({
      source: s.source,
      lastSuccessfulFetch: s.lastSuccessfulFetch,
      maxStalenessHours: s.maxStalenessHours,
      restriction: s.restriction,
      lastFailure: failureStillApplies ? s.lastFailure : undefined,
      now,
    })
  })

  const degraded = sources.filter(s => s.availability !== 'current')
  const summary = degraded.length === 0
    ? 'world-intel coverage complete'
    : `world-intel coverage degraded: ${degraded.map(s => `${s.source} ${s.availability}`).join(', ')}`

  return { sources, recordAgeHours, recordStale, degraded, summary }
}

/**
 * The load-bearing question for any consumer: may an empty result be reported as
 * "nothing happened"? Only when every source is `current`.
 */
export function coverageIsComplete(sources: SourceProvenance[]): boolean {
  return sources.length > 0 && sources.every(s => s.availability === 'current')
}

/**
 * The sentence a consumer should use in place of "no events found" when coverage
 * is incomplete. Returns null when it is safe to speak plainly.
 */
export function absenceCaveat(sources: SourceProvenance[]): string | null {
  if (coverageIsComplete(sources)) return null
  const degraded = sources.filter(s => s.availability !== 'current')
  if (degraded.length === 0) return 'source coverage could not be established'
  return `events may be MISSING rather than absent — ${degraded.map(s => `${s.source}: ${s.reason}`).join('; ')}`
}
