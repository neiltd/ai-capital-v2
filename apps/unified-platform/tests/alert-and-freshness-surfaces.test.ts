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
  const NOW = new Date('2026-08-29T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
  const src = (o: Record<string, unknown>) => ({
    source: 'gdelt', lastSuccessfulFetch: hoursAgo(1), maxStalenessHours: 2,
    ageHours: 1, availability: 'current', reason: 'fresh', ...o,
  })
  const record = (classifiedAt: string, sources: unknown[]) =>
    JSON.stringify({ schemaVersion: 1, classifiedAt, sources })

  it('a degraded source is visible without any notification channel', async () => {
    write(freshFile, record(hoursAgo(1), [
      src({ source: 'eia' }),
      src({ source: 'acled', availability: 'restricted', ageHours: 1538, maxStalenessHours: 24,
            reason: 'restricted by entitlement — 12 months old' }),
    ]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    if (!r.ok) throw new Error('expected ok')
    expect(r.sources[0].source).toBe('acled')          // degraded sorts first
    expect(r.sources[0].availability).toBe('restricted')
  })

  it('restricted and unavailable are NOT collapsed into "stale"', async () => {
    write(freshFile, record(hoursAgo(1), [
      src({ source: 'acled', availability: 'restricted' }),
      src({ source: 'gdelt', availability: 'unavailable' }),
      src({ source: 'eia',   availability: 'stale' }),
    ]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    if (!r.ok) throw new Error('expected ok')
    expect(r.sources.map(s => s.availability)).toEqual(['unavailable', 'restricted', 'stale'])
  })

  it('a healthy source is NOT falsely shown as degraded', async () => {
    write(freshFile, record(hoursAgo(1), [src({ source: 'eia', maxStalenessHours: 36, ageHours: 3 })]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    expect(r.ok && r.sources.every(s => s.availability === 'current')).toBe(true)
    expect(r.ok && r.recordStale).toBe(false)
  })

  // B1: an old export must not keep asserting "current".
  it('a STALE record downgrades current verdicts to unknown', async () => {
    write(freshFile, record(hoursAgo(200), [src({ source: 'eia', availability: 'current' })]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    if (!r.ok) throw new Error('expected ok')
    expect(r.recordStale).toBe(true)
    expect(r.sources[0].availability).toBe('unknown')
    expect(r.sources[0].reason).toMatch(/provenance record is/)
  })

  it('but a standing restriction survives a stale record', async () => {
    write(freshFile, record(hoursAgo(200), [src({ source: 'acled', availability: 'restricted' })]))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    expect(r.ok && r.sources[0].availability).toBe('restricted')
  })

  it('a missing export reports unavailable, not "all healthy"', async () => {
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness(NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no provenance export/)
  })

  it('a malformed export reports unavailable', async () => {
    write(freshFile, '{"sources":"nope"}')
    const { readSourceFreshness } = await load()
    expect(readSourceFreshness(NOW).ok).toBe(false)
  })
})
