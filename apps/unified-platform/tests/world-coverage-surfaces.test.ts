import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

// The three human-facing world surfaces (/world, /today, legacy /world/intel)
// could present an empty event feed with no provenance at all. The analytical
// layer already refuses to read absence under incomplete coverage as calm; these
// pages did not. "No events found" and "we cannot establish whether events
// occurred" are different statements, and only complete coverage licenses the
// first.
//
// Classification is NOT re-implemented here — these exercise the real
// readSourceFreshness() -> @common/types pipeline against fixture records.

let root: string
const write = (rel: string, body: string) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf-8')
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'world-cov-')); process.env.DATA_ROOT = root })
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DATA_ROOT })

const NOW = new Date('2026-08-30T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

const source = (o: Record<string, unknown>) => ({
  source: 'gdelt', availability: 'current', lastSuccessfulFetch: hoursAgo(1),
  maxStalenessHours: 36, ageHours: 1, reason: 'refreshed 1h ago', ...o,
})
const record = (sources: unknown[]) =>
  write('world-intelligence-data-hub-/quota/freshness.json',
    JSON.stringify({ schemaVersion: 1, classifiedAt: hoursAgo(1), sources }))

const notice = async () => {
  const { readSourceFreshness } = await import('@/lib/data')
  const { buildCoverageNotice } = await import('@/lib/coverage-notice')
  return buildCoverageNotice(readSourceFreshness(NOW))
}

// ── A. all current: stay quiet, and absence may be stated plainly ───────────

describe('A. complete coverage', () => {
  it('produces no notice at all', async () => {
    record([source({ source: 'gdelt' }), source({ source: 'acled' }), source({ source: 'eia' })])
    expect(await notice()).toBeNull()
  })

  it('licenses the ordinary absence sentence', async () => {
    record([source({})])
    const { absenceHeadline } = await import('@/lib/coverage-notice')
    expect(absenceHeadline(await notice(), 'No events recorded')).toBe('No events recorded')
  })
})

// ── B. unavailable: zero events is NOT evidence of absence ─────────────────

describe('B. GDELT unavailable', () => {
  const down = () => record([
    source({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), ageHours: 40,
      lastFailure: { at: hoursAgo(20), kind: 'transport', detail: 'TLS certificate expired' } }),
    source({ source: 'eia' }),
  ])

  it('raises an error-level notice naming the source', async () => {
    down()
    const n = (await notice())!
    expect(n).not.toBeNull()
    expect(n.level).toBe('error')
    expect(n.headline).toContain('gdelt unavailable')
  })

  it('marks absence unsafe and refuses the plain no-events sentence', async () => {
    down()
    const n = await notice()
    expect(n!.absenceUnsafe).toBe(true)
    const { absenceHeadline } = await import('@/lib/coverage-notice')
    expect(absenceHeadline(n, 'No events recorded')).toBe('Cannot establish whether significant events occurred')
  })

  it('says events may be missing rather than absent', async () => {
    down()
    expect((await notice())!.detail).toMatch(/MISSING rather than absent/)
  })

  it('is distinct from stale — an unreachable feed is not merely old', async () => {
    down()
    const unavailable = (await notice())!
    record([source({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), ageHours: 40 })])
    const stale = (await notice())!
    expect(unavailable.level).toBe('error')
    expect(stale.level).toBe('warning')
    expect(unavailable.headline).not.toBe(stale.headline)
  })
})

// ── C. restricted: the recent window cannot be provided ───────────────────

describe('C. ACLED restricted', () => {
  it('surfaces the entitlement limit, not staleness', async () => {
    record([source({
      source: 'acled', lastSuccessfulFetch: hoursAgo(1), ageHours: 1, maxStalenessHours: 24,
      restriction: { kind: 'recency-embargo', detail: 'account may only read events at least 12 months old', accessibleOlderThanDays: 365 },
    })])
    const n = (await notice())!
    expect(n.level).toBe('error')
    expect(n.headline).toContain('acled restricted')
    expect(n.sources[0].reason).toMatch(/restricted by entitlement/)
    expect(n.sources[0].reason).toMatch(/12 months old/)
  })

  it('stays restricted however recently it was fetched', async () => {
    record([source({
      source: 'acled', lastSuccessfulFetch: hoursAgo(0.01), ageHours: 0.01, maxStalenessHours: 24,
      restriction: { kind: 'recency-embargo', detail: 'recent window unavailable' },
    })])
    expect((await notice())!.headline).toContain('acled restricted')
  })
})

// ── D. stale: still show data, but say so ────────────────────────────────

describe('D. stale coverage', () => {
  it('is a warning, not an error — events may still render', async () => {
    record([source({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), ageHours: 40 })])
    const n = (await notice())!
    expect(n.level).toBe('warning')
    expect(n.headline).toContain('stale')
  })

  it('still withdraws the licence to state absence plainly', async () => {
    record([source({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), ageHours: 40 })])
    expect((await notice())!.absenceUnsafe).toBe(true)
  })
})

// ── E. unknown: uncertainty, never silent completeness ───────────────────

describe('E. unknown coverage', () => {
  it('a missing provenance record reads as unknown, not healthy', async () => {
    const n = (await notice())!
    expect(n.level).toBe('error')
    expect(n.headline).toMatch(/unknown/i)
    expect(n.detail).toMatch(/not the same as all feeds being healthy/)
  })

  it('a malformed record reads as unknown too', async () => {
    write('world-intelligence-data-hub-/quota/freshness.json', '{ "schemaVersion": 1, "sources": "nope" }')
    expect((await notice())!.headline).toMatch(/unknown/i)
  })

  it('a never-fetched source is unknown, not current', async () => {
    record([source({ source: 'gdelt', lastSuccessfulFetch: null, ageHours: null })])
    const n = (await notice())!
    expect(n.headline).toContain('gdelt unknown')
  })
})

// ── F. mixed: a healthy source cannot mask a broken one ──────────────────

describe('F. mixed coverage', () => {
  it('one current source does not hide an unavailable one', async () => {
    record([
      source({ source: 'eia' }),
      source({ source: 'gdelt', lastSuccessfulFetch: hoursAgo(40), ageHours: 40,
        lastFailure: { at: hoursAgo(20), kind: 'transport', detail: 'TLS expired' } }),
    ])
    const n = (await notice())!
    expect(n.headline).toContain('gdelt')
    expect(n.sources.map(s => s.source)).not.toContain('eia')   // only the degraded are listed
  })

  it('escalates to error when any source is worse than stale', async () => {
    record([
      source({ source: 'eia', lastSuccessfulFetch: hoursAgo(40), ageHours: 40 }),       // stale
      source({ source: 'acled', maxStalenessHours: 24, restriction: { kind: 'volume', detail: 'capped' } }),
    ])
    const n = (await notice())!
    expect(n.level).toBe('error')
    expect(n.sources).toHaveLength(2)
  })
})

// ── The three surfaces actually consume it, and stay read-only ───────────

describe('the surfaces are wired and remain readers', () => {
  const APP = resolve(__dirname, '..', 'src', 'app')
  const read = (p: string) => readFileSync(join(APP, p), 'utf-8')

  it.each([
    ['(next)/world/page.tsx'],
    ['(next)/today/page.tsx'],
    ['(legacy)/world/intel/page.tsx'],
  ])('%s renders the coverage callout', (p) => {
    expect(read(p)).toMatch(/CoverageCallout/)
  })

  it('/today no longer drops the world section when the feed is empty', () => {
    const src = read('(next)/today/page.tsx')
    expect(src).toContain('b.worldTop.length > 0 || worldNotice')
    expect(src).toMatch(/Cannot establish whether significant events occurred/)
  })

  it('legacy /world/intel no longer asserts "No events recorded" under degraded coverage', () => {
    const src = read('(legacy)/world/intel/page.tsx')
    expect(src).toMatch(/coverage \? 'Cannot establish whether events occurred' : 'No events recorded'/)
  })

  it('the coverage surface writes nothing and triggers no fetch', () => {
    for (const f of ['../src/lib/coverage-notice.ts', '../src/components/next/coverage-notice.tsx']) {
      const src = readFileSync(resolve(__dirname, f), 'utf-8')
      expect(src).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|rmSync|fetch\(|axios/)
    }
  })
})
