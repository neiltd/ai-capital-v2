// Article-intelligence coverage, derived from records the collector ALREADY
// writes. No new collection, no API calls, no second classifier.
//
// WHY THIS EXISTS. The provenance model covered gdelt/acled/ucdp/eia/worldbank —
// the structured and energy domains — while every live consumer (/world,
// /today, /world/intel, /world/map, the briefing and the regime analyzer) reads
// article-derived intelligence from 12 RSS feeds. So the warnings described
// sources those pages do not use, and real feed degradation was invisible.
//
// SEMANTICS ARE THE COLLECTOR'S, NOT INVENTED. Every rule below is read off
// intelligence/sources/collector.ts, health.ts and metrics-store.ts:
//
//   status 'failed'   -> OBSERVED FAILURE   (carries an error message)
//   status 'skipped'  -> NOT ATTEMPTED      (never contacted)
//   stale_feed        -> STALE CONTENT      (">50% of feed items were stale")
//   by_source[id] = 0 -> ZERO RESULTS       (status ok; a quiet feed is healthy)
//   consecutive_failures >= 3 -> unhealthy  (health.ts isUnhealthy default)
//   absent from every record  -> UNKNOWN
//
// A feed returning zero new articles is NOT a failure: by_source is populated
// only for status 'ok' (collect-articles.ts), so presence-with-zero is positive
// evidence of a successful fetch. globaltimes-china sat at 0 on 33 of 50 days
// while healthy; treating that as failure would have been the mirror of the bug
// this module fixes.
import { classifySource, type SourceProvenance, type SourceFailure } from './provenance.js'

export type EvidenceDomain = 'article_intelligence' | 'structured_events' | 'energy_macro'

/** health.ts: `isUnhealthy(sourceId, threshold = 3)`. Reused, not chosen here. */
export const UNHEALTHY_CONSECUTIVE_FAILURES = 3

/** Shapes as written by the collector. Only the fields we read are declared. */
export interface FeedHealthEntry {
  source_id: string
  total_fetches?: number
  consecutive_failures?: number
  last_success?: string | null
  last_failure?: string | null
  last_failure_reason?: string | null
}
export interface CollectionMetrics {
  last_run?: string
  by_source?: Record<string, number>
  failed_sources?: string[]
  skipped_sources?: string[]
  stale_feed_sources?: string[]
}
export interface FeedRegistryEntry { id: string; enabled?: boolean }

export interface ClassifyArticleInput {
  registry: FeedRegistryEntry[]
  health: Record<string, FeedHealthEntry>
  metrics: CollectionMetrics | null
  now: Date
  /** Matches the daily DAG cadence, same reasoning as the gdelt bound. */
  maxStalenessHours?: number
}

/**
 * One SourceProvenance per ENABLED feed, in the existing five states. Disabled
 * registry entries are excluded — a feed nobody collects is not missing
 * coverage, it is not part of the domain.
 */
export function classifyArticleSources(input: ClassifyArticleInput): SourceProvenance[] {
  const { registry, health, metrics, now, maxStalenessHours = 36 } = input
  const failed = new Set(metrics?.failed_sources ?? [])
  const skipped = new Set(metrics?.skipped_sources ?? [])
  const staleFeeds = new Set(metrics?.stale_feed_sources ?? [])
  const bySource = metrics?.by_source ?? {}

  return registry.filter(f => f.enabled !== false).map(f => {
    const h = health[f.id]
    const consecutive = h?.consecutive_failures ?? 0
    const collected = Object.prototype.hasOwnProperty.call(bySource, f.id)

    // An observed failure needs evidence. Two independent triggers, both the
    // collector's own: this run reported the feed failed, or health says it has
    // failed at least `threshold` times running.
    const failure: SourceFailure | undefined =
      (failed.has(f.id) || consecutive >= UNHEALTHY_CONSECUTIVE_FAILURES) && (h?.last_failure)
        ? { at: h.last_failure, kind: 'transport',
            detail: h.last_failure_reason
              ?? (failed.has(f.id) ? 'feed reported failed on the last collection run'
                                   : `${consecutive} consecutive failures`) }
        : undefined

    // Skipped means never contacted — that is unknown, not healthy and not down.
    const lastSuccess = skipped.has(f.id) && !collected
      ? null
      : h?.last_success ?? (collected ? metrics?.last_run ?? null : null)

    const base = classifySource({
      source: f.id, lastSuccessfulFetch: lastSuccess, maxStalenessHours,
      lastFailure: failure, now,
    })

    // Content staleness is a separate axis from fetch staleness: the fetch
    // succeeded, but >50% of what came back was old. Only downgrades `current`
    // — it must never mask a failure.
    if (base.availability === 'current' && staleFeeds.has(f.id)) {
      return { ...base, availability: 'stale',
        reason: 'feed fetched successfully but more than half its items were stale (collector stale_feed)' }
    }
    return base
  })
}

/** Domain-scoped view over a mixed source list. */
export function sourcesInDomain(sources: SourceProvenance[], domain: EvidenceDomain): SourceProvenance[] {
  return sources.filter(s => s.domain === domain)
}

/** Tag a classified set with the domain it belongs to. */
export function withDomain(sources: SourceProvenance[], domain: EvidenceDomain): SourceProvenance[] {
  return sources.map(s => ({ ...s, domain }))
}
