// Human-facing summary of world-intel source coverage.
//
// READ-ONLY, AND NOT A SECOND FRESHNESS MODEL. Classification stays in
// @common/types (classifySource / readProvenance); this only decides what a
// person should be told about the verdicts that already exist. The dashboard
// never writes provenance, never retries a source, and never infers
// availability from the absence of events.
//
// THE INVARIANT IT SERVES: "no events found" and "we cannot establish whether
// events occurred" are different statements, and only complete coverage
// licenses the first.
//
// DOMAIN-CORRECT: this reports on the ARTICLE feeds these pages actually read,
// not on gdelt/acled/eia/worldbank/ucdp. Reporting the structured and energy
// sources here warned about evidence the pages never use, while real RSS feed
// degradation stayed invisible. Structured-event and energy provenance remain
// available via readSourceFreshness() for their own consumers.
import type { ArticleCoverageResult } from './data'
import type { SourceProvenance } from '@common/types'

export interface CoverageNotice {
  /** unavailable/restricted/unknown read as errors; stale alone is a warning. */
  level: 'warning' | 'error'
  headline: string
  detail: string
  sources: SourceProvenance[]
  /** True when an empty event list must NOT be presented as evidence of calm. */
  absenceUnsafe: true
}

const LABEL: Record<string, string> = {
  stale: 'stale', unavailable: 'unavailable', restricted: 'restricted', unknown: 'unknown',
}

/**
 * Returns null when every source is current — materiality: a healthy day shows
 * no banner at all. Any degraded source produces a compact notice naming the
 * source, its state, and why.
 */
export function buildCoverageNotice(result: ArticleCoverageResult): CoverageNotice | null {
  if (!result.ok) {
    return {
      level: 'error',
      headline: 'Article coverage is unknown',
      detail: `Feed health could not be read, so it is unknown whether the news sources behind these events are current. This is not the same as all feeds being healthy. (${result.error})`,
      sources: [],
      absenceUnsafe: true,
    }
  }

  const degraded = result.sources.filter(s => s.availability !== 'current')
  if (degraded.length === 0) return null

  const worst = degraded.some(s => s.availability !== 'stale') ? 'error' : 'warning'
  const named = degraded.map(s => `${s.source} ${LABEL[s.availability] ?? s.availability}`).join(', ')

  return {
    level: worst,
    headline: worst === 'warning'
      ? `News feed coverage is stale — ${named}`
      : `News feed coverage is incomplete — ${named}`,
    detail:
      'Events below may be MISSING rather than absent. Do not read a short or empty list as evidence that little happened.',
    sources: degraded,
    absenceUnsafe: true,
  }
}

/**
 * The sentence a page may use where it would otherwise assert absence.
 * `whenComplete` is only reachable when coverage is complete.
 */
export function absenceHeadline(notice: CoverageNotice | null, whenComplete: string): string {
  return notice ? 'Cannot establish whether significant events occurred' : whenComplete
}
