import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { STRUCTURED_INGESTION_SCHEDULE_ENV } from '@common/types'

// Structured/energy ingestion is dormant by default. A source we have chosen to
// stop polling will age out of its freshness bound, and counting that as an
// operational problem would recreate the permanently-true warning that made
// `staleSourcesPresent` meaningless. Its last-known verdict is still shown.

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dormancy-')); process.env.DATA_ROOT = root })
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.DATA_ROOT
  delete process.env[STRUCTURED_INGESTION_SCHEDULE_ENV]
})

const NOW = new Date('2026-08-30T12:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const write = (rel: string, body: unknown) => {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(body), 'utf-8')
}
const record = () => write('world-intelligence-data-hub-/quota/freshness.json', {
  schemaVersion: 1, classifiedAt: ago(1),
  sources: [
    { source: 'gdelt', availability: 'unavailable', lastSuccessfulFetch: ago(60), maxStalenessHours: 36, ageHours: 60,
      reason: 'TLS expired', lastFailure: { at: ago(40), kind: 'transport', detail: 'certificate expired' } },
    { source: 'acled', availability: 'restricted', lastSuccessfulFetch: ago(1500), maxStalenessHours: 24, ageHours: 1500,
      reason: 'entitlement', restriction: { kind: 'recency-embargo', detail: '12-month embargo' } },
    { source: 'eia', availability: 'stale', lastSuccessfulFetch: ago(99), maxStalenessHours: 36, ageHours: 99, reason: 'aged out' },
  ],
})
const read = async () => {
  const { readSourceFreshness } = await import('@/lib/data')
  return readSourceFreshness(NOW)
}

describe('16/17. dormant structured sources on the operator surface', () => {
  it('are marked dormant while dormancy is the default', async () => {
    record()
    const r = await read()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sources.every(s => s.scheduling === 'dormant')).toBe(true)
  })

  it('keep their last-known availability — dormancy rewrites nothing', async () => {
    record()
    const r = await read()
    if (r.ok) {
      const by = Object.fromEntries(r.sources.map(s => [s.source, s.availability]))
      expect(by).toEqual({ gdelt: 'unavailable', acled: 'restricted', eia: 'stale' })
    }
  })

  it('flip to scheduled with the single setting, without touching availability', async () => {
    record()
    process.env[STRUCTURED_INGESTION_SCHEDULE_ENV] = 'true'
    const r = await read()
    if (r.ok) {
      expect(r.sources.every(s => s.scheduling === 'scheduled')).toBe(true)
      expect(r.sources.find(s => s.source === 'gdelt')?.availability).toBe('unavailable')
    }
  })

  it('the degraded count excludes dormant sources, derived once in the reader', () => {
    const lib = readFileSync(resolve(__dirname, '..', 'src', 'lib', 'data.ts'), 'utf-8')
    expect(lib).toContain("s.availability !== 'current' && s.scheduling !== 'dormant'")
    const page = readFileSync(resolve(__dirname, '..', 'src', 'app', '(next)', 'system', 'source-freshness.tsx'), 'utf-8')
    expect(page).toContain('const { activeDegraded: degraded, dormant } = result')
  })
})

describe('10. the scheduling-aware summary agrees with the degraded count', () => {
  it('dormant non-current sources are not described as active degradation', async () => {
    record()
    const r = await read()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // All three fixture sources are dormant and non-current.
    expect(r.activeDegraded).toHaveLength(0)
    expect(r.dormant).toHaveLength(3)
    expect(r.summary).toMatch(/complete for scheduled sources/)
    expect(r.summary).toMatch(/3 dormant/)
    // The string must not list them as degraded — that was the incoherence.
    expect(r.summary).not.toMatch(/degraded: .*gdelt/)
  })

  it('a scheduled non-current source IS active degradation, and appears in both', async () => {
    record()
    process.env[STRUCTURED_INGESTION_SCHEDULE_ENV] = 'true'
    const r = await read()
    if (!r.ok) return
    expect(r.dormant).toHaveLength(0)
    expect(r.activeDegraded.map(s => s.source).sort()).toEqual(['acled', 'eia', 'gdelt'])
    expect(r.summary).toMatch(/coverage degraded: /)
    expect(r.summary).toContain('gdelt unavailable')
  })

  it('summary and the set it describes can never disagree — both come from one derivation', async () => {
    record()
    const r = await read()
    if (!r.ok) return
    const named = r.summary.match(/degraded: ([^;]*)/)?.[1] ?? ''
    for (const s of r.activeDegraded) expect(named).toContain(s.source)
    for (const s of r.dormant) expect(named).not.toContain(s.source)
  })
})

describe('9. /system does not claim authoritative scheduler runtime state', () => {
  const raw = readFileSync(resolve(__dirname, '..', 'src', 'app', '(next)', 'system', 'source-freshness.tsx'), 'utf-8')
  // Assert on what a reader SEES: strip comments (which legitimately discuss the
  // wording we forbid on screen) and collapse JSX line wrapping.
  const page = raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')

  it('labels scheduling as this process\'s configuration, not observed state', () => {
    expect(page).toContain('Scheduling (configured here)')
  })

  it('says plainly that scheduler runtime state is not verified from here', () => {
    expect(page).toMatch(/not independently verified/)
    expect(page).toMatch(/configuration visible to the dashboard only/)
  })

  it('never asserts the scheduler itself is off', () => {
    expect(page).not.toMatch(/scheduler is (off|disabled|dormant)/i)
  })

  it('reuses the reader\'s scheduling-aware sets rather than re-deriving them', () => {
    // Re-deriving in the component is how the count and the summary drifted apart.
    expect(raw).toContain('const { activeDegraded: degraded, dormant } = result')
  })
})

// 19. Nothing about this workstream removes an integration or its artifacts.
describe('19. compatibility preserved', () => {
  const hub = resolve(__dirname, '..', '..', 'world-intelligence-data-hub-')

  it.each([
    ['collector/normalizer', 'ingestion/pipelines/pipeline.ts'],
    ['quota + freshness store', 'quota/quota-tracker.ts'],
    ['provenance producer', 'quota/freshness.ts'],
    ['structured export', 'exports/exporter.ts'],
    ['worldmap import schemas', '../unified-platform/src/worldmap/data/schemas/imports.ts'],
  ])('%s is intact', (_label, rel) => {
    expect(existsSync(join(hub, rel))).toBe(true)
  })

  it.each([
    'exports/world-map/events.json',
    'exports/oil-project/oil-events.json',
    'exports/oil-project/energy-indicators.json',
    'exports/stock-project/macro-indicators.json',
  ])('compatibility export %s still present', (rel) => {
    expect(existsSync(join(hub, rel))).toBe(true)
  })

  it('the manual structured entrypoint is unchanged', () => {
    const pkg = JSON.parse(readFileSync(join(hub, 'package.json'), 'utf-8'))
    expect(pkg.scripts.pipeline).toBe('tsx run.ts')
  })
})
