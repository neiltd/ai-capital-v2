import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reconcile, businessDate, loadAlerts, saveAlerts, alertsPath, DATA_DIR,
  type AlertFile, type Observation, type Evaluated, type AlertRuleId,
} from './alert-store.js'

const empty = (): AlertFile => ({ schemaVersion: 1, updatedAt: '', alerts: [] })
const obs = (rule: AlertRuleId, instrument: string, v: number): Observation => ({
  rule_id: rule, instrument, direction: rule === 'price_drop' ? 'down' : 'elevated',
  severity: 'warning', observed_value: v, threshold: rule === 'price_drop' ? -0.05 : 3, evidence: {},
})
const ev = (rule: AlertRuleId, instrument: string): Evaluated => ({ rule_id: rule, instrument })

// Business days in America/Los_Angeles. 17:00Z = 10:00 PT.
const D1 = new Date('2026-08-28T17:00:00Z')
const D1_LATER = new Date('2026-08-28T17:30:00Z')
const D2 = new Date('2026-08-29T17:00:00Z')
const D9 = new Date('2026-09-15T17:00:00Z')

describe('threshold alerts record that a condition existed', () => {
  it('opens an alert the first time a condition holds', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    expect(r.opened).toHaveLength(1)
    expect(r.file.alerts[0]).toMatchObject({ rule_id: 'price_drop', instrument: 'LLY', status: 'active' })
    expect(r.file.alerts[0].business_date).toBe(businessDate(D1))
  })

  it('does not duplicate while the same condition keeps holding', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [obs('price_drop', 'LLY', -0.09)], [ev('price_drop', 'LLY')], D1_LATER)
    expect(b.opened).toHaveLength(0)
    expect(b.continuing).toHaveLength(1)
    expect(b.file.alerts).toHaveLength(1)
    expect(b.file.alerts[0].observed_value).toBe(-0.09)
    expect(b.file.alerts[0].detected_at).toBe(D1.toISOString())
  })

  it('separates rules on the same instrument', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07), obs('news_velocity', 'LLY', 5)],
      [ev('price_drop', 'LLY'), ev('news_velocity', 'LLY')], D1)
    expect(r.opened).toHaveLength(2)
  })

  it('has no delivery state at all', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    expect(Object.keys(r.file.alerts[0]).some(k => /sent|deliver|notif|line|channel|retry/i.test(k))).toBe(false)
  })
})

// ── A1: the defect Warden found. An alert opened on day N was skipped by every
// later reconcile, so `active` was permanent and the dashboard rendered
// weeks-old conditions as live on a real-money surface.
describe('A1 — alerts resolve across business-day boundaries', () => {
  it('day N active, condition gone and evaluated on day N+1 → resolved', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [], [ev('price_drop', 'LLY')], D2)
    expect(b.resolved).toHaveLength(1)
    expect(b.file.alerts[0]).toMatchObject({ status: 'resolved', resolved_at: D2.toISOString() })
  })

  it('still resolves weeks later — not just the next day', () => {
    let f = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1).file
    const r = reconcile(f, [], [ev('price_drop', 'LLY')], D9)
    expect(r.file.alerts[0].status).toBe('resolved')
  })

  it('a condition spanning days stays ONE alert and keeps its original history', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [obs('price_drop', 'LLY', -0.08)], [ev('price_drop', 'LLY')], D2)
    expect(b.file.alerts).toHaveLength(1)
    expect(b.file.alerts[0].business_date).toBe(businessDate(D1))   // history
    expect(b.file.alerts[0].detected_at).toBe(D1.toISOString())     // history
    expect(b.file.alerts[0].last_observed_at).toBe(D2.toISOString()) // current
  })

  it('resolved then re-detected on a later day is a NEW alert, with the old one kept', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [], [ev('price_drop', 'LLY')], D1_LATER)          // resolves
    const c = reconcile(b.file, [obs('price_drop', 'LLY', -0.06)], [ev('price_drop', 'LLY')], D2)
    expect(c.opened).toHaveLength(1)
    expect(c.file.alerts).toHaveLength(2)
    expect(c.file.alerts.filter(x => x.status === 'active')).toHaveLength(1)
    expect(c.file.alerts[1].business_date).toBe(businessDate(D2))
  })
})

// ── A4: absence of evidence is not evidence of resolution.
describe('A4 — a rule resolves only when that rule was actually evaluated', () => {
  it('evidence unavailable on day N+1 leaves the alert unresolved', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [], [], D2)          // nothing could be checked
    expect(b.resolved).toHaveLength(0)
    expect(b.file.alerts[0].status).toBe('active')
  })

  it('price evaluated but news unavailable does NOT resolve the news alert', () => {
    const a = reconcile(empty(), [obs('news_velocity', 'LLY', 5)], [ev('news_velocity', 'LLY')], D1)
    const b = reconcile(a.file, [], [ev('price_drop', 'LLY')], D2)
    expect(b.resolved).toHaveLength(0)
    expect(b.file.alerts[0].status).toBe('active')
  })

  it('news evaluated but price unavailable does NOT resolve the price alert', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
    const b = reconcile(a.file, [], [ev('news_velocity', 'LLY')], D2)
    expect(b.resolved).toHaveLength(0)
    expect(b.file.alerts[0].status).toBe('active')
  })

  it('resolves each rule independently when each is evaluated', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07), obs('news_velocity', 'LLY', 5)],
      [ev('price_drop', 'LLY'), ev('news_velocity', 'LLY')], D1)
    const b = reconcile(a.file, [obs('news_velocity', 'LLY', 5)],
      [ev('price_drop', 'LLY'), ev('news_velocity', 'LLY')], D2)
    const byRule = Object.fromEntries(b.file.alerts.map(x => [x.rule_id, x.status]))
    expect(byRule).toEqual({ price_drop: 'resolved', news_velocity: 'active' })
  })
})

// ── A3: a corrupt authoritative store must never read as a clean one.
describe('A3 — malformed state fails visibly', () => {
  const withFile = (contents: string, fn: (p: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'))
    const p = join(dir, 'threshold-alerts.json')
    writeFileSync(p, contents, 'utf-8')
    try { fn(p) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('throws on unparseable JSON rather than returning empty', () => {
    withFile('{not json', p => expect(() => loadAlerts(p)).toThrow(/cannot read/))
  })

  it('throws when `alerts` is not an array rather than returning empty', () => {
    withFile('{"schemaVersion":1,"alerts":"oops"}', p => expect(() => loadAlerts(p)).toThrow(/malformed/))
  })

  it('a missing file is genuinely empty, which is different from corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'))
    try { expect(loadAlerts(join(dir, 'nope.json')).alerts).toEqual([]) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── A5: the record must not move when the caller's cwd does.
describe('A5 — the authoritative path is anchored, not cwd-relative', () => {
  it('resolves identically from any working directory', () => {
    const before = process.cwd()
    const a = alertsPath()
    try {
      process.chdir(tmpdir())
      expect(alertsPath()).toBe(a)
    } finally { process.chdir(before) }
  })

  it('is anchored inside the scenario-simulator app, not the caller', () => {
    expect(alertsPath()).toBe(join(DATA_DIR, 'threshold-alerts.json'))
    expect(alertsPath()).toMatch(/scenario-simulator[\\/]data[\\/]threshold-alerts\.json$/)
  })

  it('round-trips through save and load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'))
    try {
      const p = join(dir, 'threshold-alerts.json')
      const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], [ev('price_drop', 'LLY')], D1)
      saveAlerts(p, r.file)
      expect(loadAlerts(p).alerts[0].instrument).toBe('LLY')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── A2: this module carries the correctness boundary; it must stay reviewable.
describe('A2 — the module is an ordinary text file', () => {
  it('contains no literal NUL bytes, so git can diff it', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./alert-store.ts', import.meta.url)), 'utf-8')
    expect(src.includes('\u0000')).toBe(false)
  })
})
