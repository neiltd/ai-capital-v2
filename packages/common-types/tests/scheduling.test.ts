import { describe, it, expect } from 'vitest'
import {
  STRUCTURED_INGESTION_SCHEDULE_ENV, STRUCTURED_INGESTION_SOURCES,
  structuredIngestionScheduled, schedulingFor,
} from '../src/scheduling.js'
import { classifySource, type SourceProvenance } from '../src/provenance.js'

// Scheduling intent is ORTHOGONAL to availability. Availability answers "can we
// read this source?"; scheduling answers "do we choose to poll it?". Folding
// dormancy in as a sixth availability state would corrupt the vocabulary — a
// dormant source is not unavailable, and it is certainly not current.

const NOW = new Date('2026-08-30T12:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

describe('15. dormancy is not a sixth availability state', () => {
  it('the availability vocabulary is unchanged', () => {
    const states = new Set<SourceProvenance['availability']>()
    states.add(classifySource({ source: 'a', lastSuccessfulFetch: ago(1), maxStalenessHours: 36, now: NOW }).availability)
    states.add(classifySource({ source: 'b', lastSuccessfulFetch: ago(99), maxStalenessHours: 36, now: NOW }).availability)
    states.add(classifySource({ source: 'c', lastSuccessfulFetch: null, maxStalenessHours: 36, now: NOW }).availability)
    states.add(classifySource({ source: 'd', lastSuccessfulFetch: ago(1), maxStalenessHours: 36, now: NOW,
      lastFailure: { at: ago(2), kind: 'transport', detail: 'x' } }).availability)
    states.add(classifySource({ source: 'e', lastSuccessfulFetch: ago(1), maxStalenessHours: 36, now: NOW,
      restriction: { kind: 'volume', detail: 'x' } }).availability)
    expect([...states].sort()).toEqual(['current', 'restricted', 'stale', 'unavailable', 'unknown'])
    expect([...states]).not.toContain('dormant' as never)
  })

  it('scheduling lives in its own field with its own two values', () => {
    expect(schedulingFor('gdelt', {})).toBe('dormant')
    expect(schedulingFor('gdelt', { [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' })).toBe('scheduled')
  })
})

describe('17. dormancy never rewrites the last-known availability', () => {
  it('a dormant source keeps the verdict its evidence supports', () => {
    const restricted = classifySource({ source: 'acled', lastSuccessfulFetch: ago(1500), maxStalenessHours: 24, now: NOW,
      restriction: { kind: 'recency-embargo', detail: '12-month embargo' } })
    const down = classifySource({ source: 'gdelt', lastSuccessfulFetch: ago(60), maxStalenessHours: 36, now: NOW,
      lastFailure: { at: ago(40), kind: 'transport', detail: 'TLS expired' } })

    const stamped = [restricted, down].map(s => ({ ...s, scheduling: schedulingFor(s.source, {}) }))
    expect(stamped.map(s => s.scheduling)).toEqual(['dormant', 'dormant'])
    // ...and the historical verdicts are untouched.
    expect(stamped[0].availability).toBe('restricted')
    expect(stamped[1].availability).toBe('unavailable')
    expect(stamped[1].reason).toMatch(/TLS expired/)
  })

  it('dormancy does not claim health either', () => {
    const stale = classifySource({ source: 'eia', lastSuccessfulFetch: ago(99), maxStalenessHours: 36, now: NOW })
    const stamped = { ...stale, scheduling: schedulingFor('eia', {}) }
    expect(stamped.scheduling).toBe('dormant')
    expect(stamped.availability).toBe('stale')     // not rewritten to current
  })
})

describe('the flag is opt-in and scoped to structured/energy sources', () => {
  it('governs exactly the five structured + energy sources', () => {
    expect([...STRUCTURED_INGESTION_SOURCES].sort()).toEqual(['acled', 'eia', 'gdelt', 'ucdp', 'worldbank'])
  })

  it('18. article feeds are never marked dormant by it', () => {
    for (const feed of ['bbc-world', 'aljazeera-english', 'globaltimes-china']) {
      expect(schedulingFor(feed, {})).toBe('scheduled')
      expect(schedulingFor(feed, { [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' })).toBe('scheduled')
    }
  })

  it('a missing or non-"true" value is dormant', () => {
    for (const v of [undefined, '', 'false', '1', 'yes']) {
      expect(structuredIngestionScheduled({ [STRUCTURED_INGESTION_SCHEDULE_ENV]: v as string })).toBe(false)
    }
    expect(structuredIngestionScheduled({ [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'TRUE' })).toBe(true)
  })
})
