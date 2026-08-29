import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// Read surfaces for the two records that replaced LINE. Both must distinguish
// "nothing to report" from "we cannot tell you", because saying the second is
// the first is the class of lie the whole retirement removed.

let root: string
const write = (rel: string, body: string) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf-8')
}
const load = async () => {
  const mod = await import('@/lib/data')
  return mod
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'surfaces-')); process.env.DATA_ROOT = root })
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DATA_ROOT })

const alertsFile = 'scenario-simulator/data/threshold-alerts.json'
const alert = (o: Record<string, unknown>) => ({
  alert_id: 'a1', rule_id: 'price_drop', instrument: 'LLY', direction: 'down',
  severity: 'warning', observed_value: -0.07, threshold: -0.05,
  detected_at: '2026-08-28T17:00:00.000Z', last_observed_at: '2026-08-28T17:00:00.000Z',
  status: 'active', resolved_at: null, business_date: '2026-08-28', evidence: {}, ...o,
})

describe('threshold alert surface', () => {
  it('a missing record is genuinely empty', async () => {
    const { readThresholdAlerts } = await load()
    const r = readThresholdAlerts()
    expect(r.ok && r.alerts).toEqual([])
  })

  it('a MALFORMED record reports unavailable — not zero alerts', async () => {
    write(alertsFile, '{"schemaVersion":1,"alerts":"oops"}')
    const { readThresholdAlerts } = await load()
    const r = readThresholdAlerts()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/malformed/)
  })

  it('unparseable JSON reports unavailable — not zero alerts', async () => {
    write(alertsFile, '{not json')
    const { readThresholdAlerts } = await load()
    expect(readThresholdAlerts().ok).toBe(false)
  })

  it('orders active before resolved so what is live reads first', async () => {
    write(alertsFile, JSON.stringify({ schemaVersion: 1, alerts: [
      alert({ alert_id: 'old', status: 'resolved', resolved_at: '2026-08-28T18:00:00.000Z' }),
      alert({ alert_id: 'live', status: 'active' }),
    ]}))
    const { readThresholdAlerts } = await load()
    const r = readThresholdAlerts()
    expect(r.ok && r.alerts[0].alert_id).toBe('live')
  })

  // `active now` and `opened today` answer DIFFERENT questions. The first version
  // labelled an all-time count "today", so a condition from weeks ago read as
  // today's news on a real-money surface.
  it('active-now and opened-today are distinct counts', async () => {
    const { businessToday } = await load()
    const today = businessToday()
    write(alertsFile, JSON.stringify({ schemaVersion: 1, alerts: [
      alert({ alert_id: 'carried', status: 'active', business_date: '2026-01-01' }),
      alert({ alert_id: 'todays', status: 'resolved', resolved_at: '2026-08-28T18:00:00.000Z', business_date: today }),
    ]}))
    const { readThresholdAlerts } = await load()
    const r = readThresholdAlerts()
    if (!r.ok) throw new Error('expected ok')
    const activeNow = r.alerts.filter(a => a.status === 'active')
    const openedToday = r.alerts.filter(a => a.business_date === today)
    expect(activeNow.map(a => a.alert_id)).toEqual(['carried'])
    expect(openedToday.map(a => a.alert_id)).toEqual(['todays'])
    expect(activeNow).not.toEqual(openedToday)
  })
})

describe('source provenance surface', () => {
  const freshFile = 'world-intelligence-data-hub-/quota/freshness.json'
  const T0 = new Date('2026-08-29T12:00:00Z')
  const at = (h: number) => new Date(T0.getTime() + h * 3_600_000)
  const fetchedAt = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString()

  // Fixtures carry EVIDENCE, not verdicts: readProvenance recomputes every
  // time-dependent classification from lastSuccessfulFetch against the source's
  // own bound, so a stored `availability` is not trusted.
  const src = (o: Record<string, unknown>) => ({
    source: 'gdelt', lastSuccessfulFetch: fetchedAt(1), maxStalenessHours: 2,
    ageHours: 1, availability: 'current', reason: 'fresh', ...o,
  })
  const EMBARGO = { kind: 'recency-embargo', detail: '12 months old' }
  const CERT = { at: fetchedAt(2), kind: 'transport', detail: 'TLS certificate expired' }
  const record = (classifiedAt: string, sources: unknown[]) =>
    JSON.stringify({ schemaVersion: 1, classifiedAt, sources })

  it('a degraded source is visible without any notification channel', async () => {
    write(freshFile, record(fetchedAt(1), [
      src({ source: 'eia', maxStalenessHours: 36, lastSuccessfulFetch: fetchedAt(1) }),
      src({ source: 'acled', maxStalenessHours: 24, lastSuccessfulFetch: fetchedAt(1538), restriction: EMBARGO }),
    ]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(T0)
    if (!r.ok) throw new Error('expected ok')
    expect(r.sources[0].source).toBe('acled')          // degraded sorts first
    expect(r.sources[0].availability).toBe('restricted')
  })

  it('restricted and unavailable are NOT collapsed into "stale"', async () => {
    write(freshFile, record(fetchedAt(1), [
      src({ source: 'acled', maxStalenessHours: 24, lastSuccessfulFetch: fetchedAt(1538), restriction: EMBARGO }),
      src({ source: 'gdelt', maxStalenessHours: 2,  lastSuccessfulFetch: fetchedAt(50), lastFailure: CERT }),
      src({ source: 'eia',   maxStalenessHours: 36, lastSuccessfulFetch: fetchedAt(50) }),
    ]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(T0)
    if (!r.ok) throw new Error('expected ok')
    expect(r.sources.map(s => s.availability)).toEqual(['unavailable', 'restricted', 'stale'])
  })

  it('a healthy source is NOT falsely shown as degraded', async () => {
    write(freshFile, record(fetchedAt(1), [src({ source: 'eia', maxStalenessHours: 36, lastSuccessfulFetch: fetchedAt(3) })]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(T0)
    expect(r.ok && r.sources.every(s => s.availability === 'current')).toBe(true)
    expect(r.ok && r.recordStale).toBe(false)
  })

  // D2: a persisted `current` verdict is not trusted past the source's OWN bound,
  // even while the record itself is young.
  it('gdelt current at classification becomes stale once its 2h bound elapses', async () => {
    write(freshFile, record(T0.toISOString(), [
      src({ source: 'gdelt', maxStalenessHours: 2, lastSuccessfulFetch: fetchedAt(0.5) }),
    ]))
    const { readSourceFreshness } = await load()
    expect((await load()).readSourceFreshness(at(1)).ok).toBe(true)
    const early = readSourceFreshness(at(1))
    const later = readSourceFreshness(at(3))
    expect(early.ok && early.sources[0].availability).toBe('current')
    expect(later.ok && later.sources[0].availability).toBe('stale')
    expect(later.ok && later.recordStale).toBe(false)   // the RECORD is still young
  })

  it('a long-bound source stays current from the same record', async () => {
    write(freshFile, record(T0.toISOString(), [
      src({ source: 'gdelt',     maxStalenessHours: 2,   lastSuccessfulFetch: fetchedAt(0.5) }),
      src({ source: 'worldbank', maxStalenessHours: 336, lastSuccessfulFetch: fetchedAt(0.5) }),
    ]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(at(3))
    if (!r.ok) throw new Error('expected ok')
    expect(Object.fromEntries(r.sources.map(s => [s.source, s.availability])))
      .toEqual({ gdelt: 'stale', worldbank: 'current' })
  })

  it('a standing restriction survives an aged record', async () => {
    write(freshFile, record(fetchedAt(200), [
      src({ source: 'acled', maxStalenessHours: 24, lastSuccessfulFetch: fetchedAt(1538), restriction: EMBARGO }),
    ]))
    const { readSourceFreshness } = await load()
    expect((readSourceFreshness(T0) as { sources: Array<{ availability: string }> }).sources[0].availability).toBe('restricted')
  })

  it('a missing export reports unavailable, not "all healthy"', async () => {
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no provenance export/)
  })

  it('a malformed export reports unavailable', async () => {
    write(freshFile, '{"sources":"nope"}')
    const { readSourceFreshness } = await load()
    expect(readSourceFreshness(T0).ok).toBe(false)
  })
})
