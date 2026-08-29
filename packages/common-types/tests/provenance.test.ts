import { describe, it, expect } from 'vitest'
import {
  classifySource, readProvenance, coverageIsComplete, absenceCaveat,
  type ProvenanceRecord, type SourceRestriction, type SourceFailure,
} from '../src/provenance.js'

const NOW = new Date('2026-08-29T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

const EMBARGO: SourceRestriction = {
  kind: 'recency-embargo', detail: 'account may only read events at least 12 months old',
  evidence: 'date_recency = 12 Months', accessibleOlderThanDays: 365,
}
const CERT: SourceFailure = { at: hoursAgo(16), kind: 'transport', detail: 'TLS certificate expired' }

describe('source availability is five states, not a boolean', () => {
  it('inside its bound is current', () => {
    const r = classifySource({ source: 'eia', lastSuccessfulFetch: hoursAgo(3), maxStalenessHours: 36, now: NOW })
    expect(r.availability).toBe('current')
  })

  // The distinction that keeps a frozen scheduler from being reported as a dead
  // feed, and vice versa.
  it('past its bound is stale with the cause explicitly NOT diagnosed', () => {
    const r = classifySource({ source: 'eia', lastSuccessfulFetch: hoursAgo(40), maxStalenessHours: 36, now: NOW })
    expect(r.availability).toBe('stale')
    expect(r.reason).toMatch(/cause not diagnosed/)
    expect(r.reason).toMatch(/may simply not have run/)
    expect(r.reason).not.toMatch(/fail|broken|down/i)
  })

  it('an observed transport failure is unavailable, and carries its evidence', () => {
    const r = classifySource({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), maxStalenessHours: 2, lastFailure: CERT, now: NOW })
    expect(r.availability).toBe('unavailable')
    expect(r.reason).toMatch(/TLS certificate expired/)
  })

  // ACLED must never look retryable: no query change can fix an entitlement.
  it('an entitlement limit is restricted, outranking staleness', () => {
    const r = classifySource({ source: 'acled', lastSuccessfulFetch: hoursAgo(1538), maxStalenessHours: 24, restriction: EMBARGO, now: NOW })
    expect(r.availability).toBe('restricted')
    expect(r.availability).not.toBe('stale')
    expect(r.availability).not.toBe('unavailable')
    expect(r.reason).toMatch(/entitlement/)
  })

  it('restricted outranks an observed failure too', () => {
    const r = classifySource({ source: 'acled', lastSuccessfulFetch: hoursAgo(10), maxStalenessHours: 24, restriction: EMBARGO, lastFailure: CERT, now: NOW })
    expect(r.availability).toBe('restricted')
  })

  it('never fetched is unknown, not stale', () => {
    const r = classifySource({ source: 'new', lastSuccessfulFetch: null, maxStalenessHours: 24, now: NOW })
    expect(r.availability).toBe('unknown')
    expect(r.ageHours).toBeNull()
  })

  it('uses only the injected clock', () => {
    const a = classifySource({ source: 'x', lastSuccessfulFetch: hoursAgo(10), maxStalenessHours: 24, now: NOW })
    const b = classifySource({ source: 'x', lastSuccessfulFetch: hoursAgo(10), maxStalenessHours: 24, now: NOW })
    expect(a).toEqual(b)
    expect(a.ageHours).toBe(10)
    // age and verdict must agree — they were computed from different clocks before
    expect(a.availability).toBe('current')
  })
})

describe('a classification is itself an observation with an age', () => {
  const rec = (classifiedAt: string): ProvenanceRecord => ({
    schemaVersion: 1, classifiedAt,
    sources: [
      classifySource({ source: 'eia', lastSuccessfulFetch: hoursAgo(3), maxStalenessHours: 36, now: NOW }),
      classifySource({ source: 'acled', lastSuccessfulFetch: hoursAgo(1538), maxStalenessHours: 24, restriction: EMBARGO, now: NOW }),
    ],
  })

  it('a fresh record keeps its verdicts', () => {
    const r = readProvenance(rec(hoursAgo(2)), NOW, 30)
    expect(r.recordStale).toBe(false)
    expect(r.sources.find(s => s.source === 'eia')!.availability).toBe('current')
  })

  // B1: an old export must not assert "current" — nobody has checked since.
  it('a STALE record cannot assert that anything is current', () => {
    const r = readProvenance(rec(hoursAgo(200)), NOW, 30)
    expect(r.recordStale).toBe(true)
    expect(r.sources.find(s => s.source === 'eia')!.availability).toBe('unknown')
    expect(r.sources.find(s => s.source === 'eia')!.reason).toMatch(/provenance record is/)
  })

  it('but a restriction survives, because it is a standing fact not an observation', () => {
    const r = readProvenance(rec(hoursAgo(200)), NOW, 30)
    expect(r.sources.find(s => s.source === 'acled')!.availability).toBe('restricted')
  })

  it('a missing record is unknown coverage, never healthy', () => {
    const r = readProvenance(null, NOW, 30)
    expect(r.recordStale).toBe(true)
    expect(coverageIsComplete(r.sources)).toBe(false)
    expect(r.summary).toMatch(/unknown/)
  })
})

describe('absence may only be reported as absence under complete coverage', () => {
  const current = classifySource({ source: 'eia', lastSuccessfulFetch: hoursAgo(1), maxStalenessHours: 36, now: NOW })
  const restricted = classifySource({ source: 'acled', lastSuccessfulFetch: null, maxStalenessHours: 24, restriction: EMBARGO, now: NOW })

  it('complete coverage licenses a plain statement', () => {
    expect(coverageIsComplete([current])).toBe(true)
    expect(absenceCaveat([current])).toBeNull()
  })

  it('any degraded source withdraws that licence', () => {
    expect(coverageIsComplete([current, restricted])).toBe(false)
    expect(absenceCaveat([current, restricted])).toMatch(/may be MISSING rather than absent/)
    expect(absenceCaveat([current, restricted])).toContain('acled')
  })

  it('an empty source list is never complete coverage', () => {
    expect(coverageIsComplete([])).toBe(false)
  })
})
