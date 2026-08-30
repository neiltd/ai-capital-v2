import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

// The four world surfaces (/world, /today, /world/intel, /world/map) display
// ARTICLE-derived events. Their coverage notice must therefore describe the RSS
// feeds behind those events — not gdelt/acled/eia/worldbank/ucdp, which no live
// surface reads. Warning on the structured sources was a false positive; missing
// real feed degradation was the more dangerous false negative.

let root: string
const write = (rel: string, body: unknown) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'world-cov-')); process.env.DATA_ROOT = root })
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DATA_ROOT })

const NOW = new Date('2026-08-30T12:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const HUB = 'world-intelligence-data-hub-'

const registry = (extra: unknown[] = []) => write(`${HUB}/intelligence/sources/sources.json`, [
  { id: 'bbc-world', name: 'BBC World', enabled: true },
  { id: 'aljazeera-english', name: 'Al Jazeera', enabled: true },
  { id: 'globaltimes-china', name: 'Global Times', enabled: true },
  { id: 'reuters-world', name: 'Reuters', enabled: false },
  ...extra,
])
type H = Record<string, { source_id: string; consecutive_failures: number; last_success?: string; last_failure?: string; last_failure_reason?: string }>
const healthy = (): H => ({
  'bbc-world': { source_id: 'bbc-world', consecutive_failures: 0, last_success: ago(2) },
  'aljazeera-english': { source_id: 'aljazeera-english', consecutive_failures: 0, last_success: ago(2) },
  'globaltimes-china': { source_id: 'globaltimes-china', consecutive_failures: 0, last_success: ago(2) },
})
const collection = (o: Record<string, unknown> = {}) => ({
  last_run: ago(2), by_source: { 'bbc-world': 18, 'aljazeera-english': 25, 'globaltimes-china': 0 },
  failed_sources: [], skipped_sources: [], stale_feed_sources: [], ...o,
})
const scene = (health: H = healthy(), coll = collection()) => {
  registry()
  write(`${HUB}/intelligence/sources/source-health.json`, health)
  write(`${HUB}/intelligence/metrics/2026-08-30.json`, { date: '2026-08-30', collection: coll })
}
/** Structured/energy provenance — present, and deliberately irrelevant here. */
const structuredRecord = (sources: unknown[]) =>
  write(`${HUB}/quota/freshness.json`, { schemaVersion: 1, classifiedAt: ago(1), sources })

const notice = async () => {
  const { readArticleCoverage } = await import('@/lib/data')
  const { buildCoverageNotice } = await import('@/lib/coverage-notice')
  return buildCoverageNotice(readArticleCoverage(NOW))
}

// ── A. healthy article domain stays quiet ─────────────────────────────────

describe('A. all article feeds healthy', () => {
  it('produces no notice', async () => { scene(); expect(await notice()).toBeNull() })

  it('a zero-result feed does not trigger a warning', async () => {
    scene(healthy(), collection({ by_source: { 'bbc-world': 0, 'aljazeera-english': 0, 'globaltimes-china': 0 } }))
    expect(await notice()).toBeNull()
  })

  it('licenses the ordinary absence sentence', async () => {
    scene()
    const { absenceHeadline } = await import('@/lib/coverage-notice')
    expect(absenceHeadline(await notice(), 'No events recorded')).toBe('No events recorded')
  })
})

// ── G/H. THE CRITICAL PAIR: structured impairment must not leak in ────────

describe('G/H. structured and energy impairment do not touch article surfaces', () => {
  it('G. ACLED restricted + article healthy -> no warning', async () => {
    scene()
    structuredRecord([{ source: 'acled', availability: 'restricted', lastSuccessfulFetch: ago(1500),
      maxStalenessHours: 24, ageHours: 1500, reason: 'entitlement',
      restriction: { kind: 'recency-embargo', detail: '12-month embargo' } }])
    expect(await notice(), 'an ACLED restriction leaked into an article surface').toBeNull()
  })

  it('H. GDELT unavailable + article healthy -> no warning', async () => {
    scene()
    structuredRecord([{ source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: ago(60),
      maxStalenessHours: 36, ageHours: 60, reason: 'TLS expired',
      lastFailure: { at: ago(40), kind: 'transport', detail: 'certificate expired' } }])
    expect(await notice(), 'a GDELT outage leaked into an article surface').toBeNull()
  })

  it('both at once still leave the article domain quiet', async () => {
    scene()
    structuredRecord([
      { source: 'acled', availability: 'restricted', lastSuccessfulFetch: ago(1500), maxStalenessHours: 24, ageHours: 1500, reason: 'x', restriction: { kind: 'recency-embargo', detail: 'y' } },
      { source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: ago(60), maxStalenessHours: 36, ageHours: 60, reason: 'z', lastFailure: { at: ago(40), kind: 'transport', detail: 'w' } },
    ])
    expect(await notice()).toBeNull()
  })

  it('the structured surface still reports them for its own consumers', async () => {
    scene()
    structuredRecord([{ source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: ago(60),
      maxStalenessHours: 36, ageHours: 60, reason: 'TLS expired',
      lastFailure: { at: ago(40), kind: 'transport', detail: 'certificate expired' } }])
    const { readSourceFreshness } = await import('@/lib/data')
    const r = readSourceFreshness(NOW)
    expect(r.ok && r.sources[0].availability).toBe('unavailable')   // not deleted, just not shown to article pages
  })
})

// ── B/C/D/I/J. real article degradation IS surfaced ───────────────────────

describe('I/J. article degradation warns', () => {
  it('a failed feed is an error-level notice naming it', async () => {
    scene({ ...healthy(), 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 1, last_failure: ago(2), last_failure_reason: 'HTTP 503' } },
      collection({ by_source: { 'aljazeera-english': 25, 'globaltimes-china': 0 }, failed_sources: ['bbc-world'] }))
    const n = (await notice())!
    expect(n.level).toBe('error')
    expect(n.headline).toContain('bbc-world unavailable')
    expect(n.sources[0].reason).toMatch(/HTTP 503/)
  })

  it('a stale feed is a warning, distinct from a failure', async () => {
    scene(healthy(), collection({ stale_feed_sources: ['globaltimes-china'] }))
    const n = (await notice())!
    expect(n.level).toBe('warning')
    expect(n.headline).toContain('globaltimes-china stale')
  })

  it('withdraws the plain absence sentence when degraded', async () => {
    scene(healthy(), collection({ stale_feed_sources: ['globaltimes-china'] }))
    const { absenceHeadline } = await import('@/lib/coverage-notice')
    expect(absenceHeadline(await notice(), 'No events recorded')).toBe('Cannot establish whether significant events occurred')
  })

  it('J. a healthy feed cannot mask a degraded sibling', async () => {
    scene({ ...healthy(), 'bbc-world': { source_id: 'bbc-world', consecutive_failures: 1, last_failure: ago(2), last_failure_reason: 'timeout' } },
      collection({ by_source: { 'aljazeera-english': 25, 'globaltimes-china': 0 }, failed_sources: ['bbc-world'] }))
    const n = (await notice())!
    expect(n.sources.map(s => s.source)).toEqual(['bbc-world'])
  })
})

// ── E/F. missing and malformed article evidence ───────────────────────────

describe('E/F. unknown article coverage', () => {
  it('no registry at all is unknown, not healthy', async () => {
    const n = (await notice())!
    expect(n.level).toBe('error')
    expect(n.headline).toMatch(/unknown/i)
  })

  it('registry present but no metrics record -> every feed unknown', async () => {
    registry()
    write(`${HUB}/intelligence/sources/source-health.json`, {})
    const n = (await notice())!
    expect(n.sources.every(s => s.availability === 'unknown')).toBe(true)
  })

  it('malformed registry degrades to unknown rather than throwing', async () => {
    write(`${HUB}/intelligence/sources/sources.json`, '{ not json')
    expect((await notice())!.headline).toMatch(/unknown/i)
  })
})

// ── K/L/M/N. the surfaces are wired and stay read-only ────────────────────

describe('K-N. surfaces consume article coverage and remain readers', () => {
  const APP = resolve(__dirname, '..', 'src', 'app')
  const read = (p: string) => readFileSync(join(APP, p), 'utf-8')

  it.each([
    ['K', '(next)/world/page.tsx'],
    ['L', '(next)/today/page.tsx'],
    ['M', '(legacy)/world/intel/page.tsx'],
    ['N', '(legacy)/world/map/page.tsx'],
  ])('%s. %s renders the coverage callout', (_l, p) => {
    expect(read(p)).toMatch(/CoverageCallout/)
  })

  it('the callout resolves ARTICLE coverage, not structured freshness', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'components', 'next', 'coverage-notice.tsx'), 'utf-8')
    expect(src).toContain('readArticleCoverage')
    expect(src).not.toContain('readSourceFreshness')
  })

  it('the coverage surface writes nothing and fetches nothing', () => {
    for (const f of ['../src/lib/coverage-notice.ts', '../src/components/next/coverage-notice.tsx']) {
      const src = readFileSync(resolve(__dirname, f), 'utf-8')
      expect(src).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|rmSync|fetch\(|axios/)
    }
  })
})
