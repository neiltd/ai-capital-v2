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

describe('source freshness surface', () => {
  const freshFile = 'world-intelligence-data-hub-/quota/freshness.json'
  const src = (o: Record<string, unknown>) => ({
    source: 'gdelt', lastSuccessfulFetch: '2026-08-28T17:00:00.000Z',
    maxStalenessHours: 2, ageHours: 1, stale: false, reason: null, ...o,
  })

  it('a stale source is visible without any notification channel', async () => {
    write(freshFile, JSON.stringify({ schemaVersion: 1, exportedAt: '2026-08-29T00:00:00.000Z', sources: [
      src({ source: 'eia', stale: false }),
      src({ source: 'acled', stale: true, ageHours: 1538, maxStalenessHours: 24, reason: 'last success was 1538h ago, past the 24h bound' }),
    ]}))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness()
    if (!r.ok) throw new Error('expected ok')
    expect(r.sources[0].source).toBe('acled')       // stale sorts first
    expect(r.sources[0].stale).toBe(true)
    expect(r.sources[0].reason).toMatch(/1538h/)
  })

  it('a healthy source is NOT falsely shown as stale', async () => {
    write(freshFile, JSON.stringify({ schemaVersion: 1, exportedAt: '2026-08-29T00:00:00.000Z',
      sources: [src({ source: 'eia', stale: false, ageHours: 3, maxStalenessHours: 36 })] }))
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness()
    expect(r.ok && r.sources.every(s => !s.stale)).toBe(true)
    expect(r.ok && r.sources[0].reason).toBeNull()
  })

  // Absence of the export is absence of information, never a clean bill.
  it('a missing export reports unavailable, not "all healthy"', async () => {
    const { readSourceFreshness } = await load()
    const r = readSourceFreshness()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no freshness export/)
  })

  it('a malformed export reports unavailable', async () => {
    write(freshFile, '{"sources":"nope"}')
    const { readSourceFreshness } = await load()
    expect(readSourceFreshness().ok).toBe(false)
  })
})
