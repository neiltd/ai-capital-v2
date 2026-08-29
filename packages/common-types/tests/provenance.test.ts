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

// D2: a persisted `current` verdict must not be trusted indefinitely. The first
// version compared only the RECORD's age against one global grace period and,
// under it, passed producer verdicts through verbatim — so a 29h-old record kept
// reporting GDELT `current` with ageHours 1 while its true age was 30h against a
// 2h bound. Each source is now re-derived against ITS OWN bound at read time.
describe('time-dependent verdicts are recomputed at read time', () => {
  const T0 = new Date('2026-08-29T00:00:00Z')
  const at = (h: number) => new Date(T0.getTime() + h * 3_600_000)
  const fetchedAt = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString()

  // One record, classified at T0, holding sources with very different bounds.
  const record = (): ProvenanceRecord => ({
    schemaVersion: 1, classifiedAt: T0.toISOString(),
    sources: [
      classifySource({ source: 'gdelt',     lastSuccessfulFetch: fetchedAt(0.5), maxStalenessHours: 2,   now: T0 }),
      classifySource({ source: 'worldbank', lastSuccessfulFetch: fetchedAt(0.5), maxStalenessHours: 336, now: T0 }),
      classifySource({ source: 'acled',     lastSuccessfulFetch: fetchedAt(1538), maxStalenessHours: 24, restriction: EMBARGO, now: T0 }),
    ],
  })
  const src = (r: ReturnType<typeof readProvenance>, name: string) => r.sources.find(s => s.source === name)!

  it('gdelt classified current is still current when read 1h later', () => {
    const r = readProvenance(record(), at(1), 30)
    expect(src(r, 'gdelt').availability).toBe('current')
  })

  it('the SAME record read 3h later reports gdelt stale — its 2h bound elapsed', () => {
    const r = readProvenance(record(), at(3), 30)
    expect(src(r, 'gdelt').availability).toBe('stale')
    expect(src(r, 'gdelt').ageHours).toBeGreaterThan(2)
    expect(coverageIsComplete(r.sources)).toBe(false)
    expect(absenceCaveat(r.sources)).toMatch(/may be MISSING rather than absent/)
  })

  it('world bank with its 336h bound is still current at +3h, from that same record', () => {
    const r = readProvenance(record(), at(3), 30)
    expect(src(r, 'worldbank').availability).toBe('current')
  })

  it('different bounds are evaluated independently from one record', () => {
    const r = readProvenance(record(), at(3), 30)
    expect(r.sources.map(s => [s.source, s.availability])).toEqual([
      ['gdelt', 'stale'], ['worldbank', 'current'], ['acled', 'restricted'],
    ])
  })

  it('the record staying young does NOT protect an elapsed source bound', () => {
    const r = readProvenance(record(), at(29), 30)   // record 29h old, inside the 30h grace
    expect(r.recordStale).toBe(false)
    expect(src(r, 'gdelt').availability).toBe('stale')   // but its own 2h bound is long gone
    expect(src(r, 'gdelt').reason).toMatch(/past the 2h bound/)
  })

  it('a standing restriction survives record aging', () => {
    expect(src(readProvenance(record(), at(500), 30), 'acled').availability).toBe('restricted')
  })

  it('an observed failure still self-expires on a later success', () => {
    const rec: ProvenanceRecord = { schemaVersion: 1, classifiedAt: T0.toISOString(), sources: [
      { source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: fetchedAt(-1), // succeeded AFTER the failure
        maxStalenessHours: 2, ageHours: 0, reason: 'x', lastFailure: CERT },
    ]}
    expect(readProvenance(rec, at(0.5), 30).sources[0].availability).not.toBe('unavailable')
  })

  it('an observed failure still applies when no later success exists', () => {
    const rec: ProvenanceRecord = { schemaVersion: 1, classifiedAt: T0.toISOString(), sources: [
      { source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: fetchedAt(50),
        maxStalenessHours: 2, ageHours: 50, reason: 'x', lastFailure: CERT },
    ]}
    expect(readProvenance(rec, at(1), 30).sources[0].availability).toBe('unavailable')
  })

  it('a missing record is unknown coverage, never healthy', () => {
    const r = readProvenance(null, at(0), 30)
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
