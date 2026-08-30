import { describe, it, expect } from 'vitest'
import { classifyArticleSources, withDomain, sourcesInDomain, UNHEALTHY_CONSECUTIVE_FAILURES } from '../src/article-provenance.js'
import { classifySource, coverageIsComplete, absenceCaveat } from '../src/provenance.js'

// Article-domain coverage derived from the collector's OWN records. Every rule
// under test is the collector's documented semantics, not a threshold invented
// to make history look green:
//   failed -> unavailable · skipped -> unknown · stale_feed -> stale ·
//   by_source[id]=0 -> current (a quiet feed is healthy) ·
//   consecutive_failures >= 3 -> unhealthy (health.ts isUnhealthy default)

const NOW = new Date('2026-08-30T12:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

const REGISTRY = [
  { id: 'bbc-world', enabled: true },
  { id: 'aljazeera-english', enabled: true },
  { id: 'globaltimes-china', enabled: true },
  { id: 'reuters-world', enabled: false },     // disabled: not part of the domain
]
const base = (o: Partial<Parameters<typeof classifyArticleSources>[0]> = {}) => classifyArticleSources({
  registry: REGISTRY,
  health: {
    'bbc-world': { source_id: 'bbc-world', consecutive_failures: 0, last_success: ago(2) },
    'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
    'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) },
  },
  metrics: { last_run: ago(2), by_source: { 'bbc-world': 18, 'aljazeera-english': 25, 'globaltimes-china': 0 },
    failed_sources: [], skipped_sources: [], stale_feed_sources: [] },
  now: NOW,
  ...o,
})
const get = (s: ReturnType<typeof classifyArticleSources>, id: string) => s.find(x => x.source === id)!

// ── A. all feeds healthy ────────────────────────────────────────────────────

describe('A. healthy article domain', () => {
  it('classifies every enabled feed current', () => {
    const s = base()
    expect(s.map(x => x.availability)).toEqual(['current', 'current', 'current'])
  })

  it('excludes disabled feeds — an uncollected feed is not missing coverage', () => {
    expect(base().map(s => s.source)).not.toContain('reuters-world')
  })

  it('licenses ordinary absence messaging', () => {
    expect(coverageIsComplete(base())).toBe(true)
    expect(absenceCaveat(base())).toBeNull()
  })
})

// ── D. zero results is NOT failure — the defect this module avoids ─────────

describe('D. zero-result feed', () => {
  it('a feed present in by_source with 0 is current, not failed', () => {
    // by_source is populated only for status 'ok', so presence-with-zero is
    // positive evidence of a successful fetch.
    expect(get(base(), 'globaltimes-china').availability).toBe('current')
  })

  it('stays current even with a long run of zero days', () => {
    const s = base({ metrics: { last_run: ago(2), by_source: { 'bbc-world': 0, 'aljazeera-english': 0, 'globaltimes-china': 0 }, failed_sources: [], skipped_sources: [], stale_feed_sources: [] } })
    expect(s.every(x => x.availability === 'current')).toBe(true)
    expect(coverageIsComplete(s)).toBe(true)
  })
})

// ── B. explicit failure ────────────────────────────────────────────────────

describe('B. failed feed', () => {
  const failed = () => base({
    health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 1, last_failure: ago(2), last_failure_reason: 'fetch failed — ENOTFOUND' },
      'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
      'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) } },
    metrics: { last_run: ago(2), by_source: { 'aljazeera-english': 25, 'globaltimes-china': 0 },
      failed_sources: ['bbc-world'], skipped_sources: [], stale_feed_sources: [] },
  })

  it('is unavailable and carries the collector error as evidence', () => {
    const s = get(failed(), 'bbc-world')
    expect(s.availability).toBe('unavailable')
    expect(s.reason).toMatch(/ENOTFOUND/)
  })

  it('does not make the whole domain unusable — healthy feeds stay current', () => {
    expect(get(failed(), 'aljazeera-english').availability).toBe('current')
  })

  it('but does withdraw the licence to claim absence', () => {
    expect(coverageIsComplete(failed())).toBe(false)
    expect(absenceCaveat(failed())).toContain('bbc-world')
  })

  it('treats >= 3 consecutive failures as unavailable even without a failed_sources entry', () => {
    const s = base({
      health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: UNHEALTHY_CONSECUTIVE_FAILURES, last_failure: ago(5), last_failure_reason: 'timeout' },
        'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
        'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) } },
    })
    expect(get(s, 'bbc-world').availability).toBe('unavailable')
  })

  it('1-2 consecutive failures alone do not reach unavailable', () => {
    const s = base({
      health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 2, last_failure: ago(5), last_failure_reason: 'timeout', last_success: ago(2) },
        'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
        'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) } },
    })
    expect(get(s, 'bbc-world').availability).toBe('current')
  })
})

// ── C. stale content, distinct from transport failure ─────────────────────

describe('C. stale feed', () => {
  const stale = () => base({ metrics: { last_run: ago(2), by_source: { 'bbc-world': 18, 'aljazeera-english': 25, 'globaltimes-china': 3 },
    failed_sources: [], skipped_sources: [], stale_feed_sources: ['globaltimes-china'] } })

  it('is stale, not unavailable — the fetch worked', () => {
    const s = get(stale(), 'globaltimes-china')
    expect(s.availability).toBe('stale')
    expect(s.reason).toMatch(/more than half its items were stale/)
  })

  it('is distinguishable from a failed feed', () => {
    expect(get(stale(), 'globaltimes-china').availability).not.toBe('unavailable')
  })

  it('never masks a failure — a failed feed stays unavailable even if also listed stale', () => {
    const s = base({
      health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 1, last_failure: ago(2), last_failure_reason: 'parse error' },
        'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
        'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) } },
      metrics: { last_run: ago(2), by_source: { 'aljazeera-english': 25, 'globaltimes-china': 0 },
        failed_sources: ['bbc-world'], skipped_sources: [], stale_feed_sources: ['bbc-world'] },
    })
    expect(get(s, 'bbc-world').availability).toBe('unavailable')
  })
})

// ── E/F. missing and malformed evidence ───────────────────────────────────

describe('E/F. missing or unusable metrics', () => {
  it('no metrics record at all is unknown, never healthy', () => {
    const s = base({ metrics: null, health: {} })
    expect(s.every(x => x.availability === 'unknown')).toBe(true)
    expect(coverageIsComplete(s)).toBe(false)
  })

  it('a skipped feed is unknown — not attempted is not the same as down', () => {
    const s = base({ metrics: { last_run: ago(2), by_source: { 'bbc-world': 18, 'aljazeera-english': 25 },
      failed_sources: [], skipped_sources: ['globaltimes-china'], stale_feed_sources: [] },
      health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 0, last_success: ago(2) },
        'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
        'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0 } } })
    expect(get(s, 'globaltimes-china').availability).toBe('unknown')
  })

  it('an empty metrics object degrades to unknown rather than throwing', () => {
    const s = base({ metrics: {}, health: {} })
    expect(s.every(x => x.availability === 'unknown')).toBe(true)
  })
})

// ── G/H/I/J. domain isolation — the critical pair ─────────────────────────

describe('G-J. domains do not contaminate each other', () => {
  const articles = () => withDomain(base(), 'article_intelligence')
  const acledRestricted = { ...classifySource({ source: 'acled', lastSuccessfulFetch: ago(1), maxStalenessHours: 24,
    restriction: { kind: 'recency-embargo' as const, detail: '12-month embargo' }, now: NOW }), domain: 'structured_events' as const }
  const gdeltDown = { ...classifySource({ source: 'gdelt', lastSuccessfulFetch: ago(60), maxStalenessHours: 36,
    lastFailure: { at: ago(40), kind: 'transport' as const, detail: 'TLS certificate expired' }, now: NOW }), domain: 'structured_events' as const }

  it('G. ACLED restricted does not degrade a healthy article domain', () => {
    const all = [...articles(), acledRestricted]
    const article = sourcesInDomain(all, 'article_intelligence')
    expect(coverageIsComplete(article)).toBe(true)
    expect(absenceCaveat(article)).toBeNull()
    expect(coverageIsComplete(all)).toBe(false)      // the mixed view IS degraded
  })

  it('H. GDELT unavailable does not degrade a healthy article domain', () => {
    const article = sourcesInDomain([...articles(), gdeltDown], 'article_intelligence')
    expect(coverageIsComplete(article)).toBe(true)
    expect(absenceCaveat(article)).toBeNull()
  })

  it('I. a degraded article feed warns even when structured sources are healthy', () => {
    const degraded = withDomain(base({
      metrics: { last_run: ago(2), by_source: { 'bbc-world': 18, 'aljazeera-english': 25, 'globaltimes-china': 0 },
        failed_sources: [], skipped_sources: [], stale_feed_sources: ['bbc-world'] } }), 'article_intelligence')
    const healthyStructured = { ...classifySource({ source: 'ucdp', lastSuccessfulFetch: ago(1), maxStalenessHours: 336, now: NOW }), domain: 'structured_events' as const }
    const article = sourcesInDomain([...degraded, healthyStructured], 'article_intelligence')
    expect(coverageIsComplete(article)).toBe(false)
    expect(absenceCaveat(article)).toContain('bbc-world')
  })

  it('J. a healthy sibling cannot mask a degraded member of the same domain', () => {
    const mixed = withDomain(base({
      metrics: { last_run: ago(2), by_source: { 'aljazeera-english': 25, 'globaltimes-china': 0 },
        failed_sources: ['bbc-world'], skipped_sources: [], stale_feed_sources: [] },
      health: { 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 1, last_failure: ago(2), last_failure_reason: 'HTTP 503' },
        'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
        'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) } } }), 'article_intelligence')
    expect(coverageIsComplete(mixed)).toBe(false)
    expect(mixed.filter(s => s.availability !== 'current').map(s => s.source)).toEqual(['bbc-world'])
  })
})
