import { describe, it, expect } from 'vitest'
import { reconcile, businessDate, type AlertFile, type Observation } from './alert-store.js'

const empty = (): AlertFile => ({ schemaVersion: 1, updatedAt: '', alerts: [] })
const obs = (rule: 'price_drop' | 'news_velocity', instrument: string, v: number): Observation => ({
  rule_id: rule, instrument, direction: rule === 'price_drop' ? 'down' : 'elevated',
  severity: 'warning', observed_value: v, threshold: rule === 'price_drop' ? -0.05 : 3, evidence: {},
})

describe('threshold alert records state that a condition existed', () => {
  const t0 = new Date('2026-08-28T17:00:00Z')   // 10:00 America/Los_Angeles
  const t1 = new Date('2026-08-28T17:30:00Z')
  const t2 = new Date('2026-08-29T17:00:00Z')   // next business day

  it('opens an alert the first time a condition holds', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    expect(r.opened).toHaveLength(1)
    expect(r.file.alerts[0]).toMatchObject({ rule_id: 'price_drop', instrument: 'LLY', status: 'active' })
    expect(r.file.alerts[0].business_date).toBe(businessDate(t0))
  })

  it('does NOT duplicate while the same condition keeps holding', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    const b = reconcile(a.file, [obs('price_drop', 'LLY', -0.09)], ['LLY'], t1)
    expect(b.opened).toHaveLength(0)
    expect(b.continuing).toHaveLength(1)
    expect(b.file.alerts).toHaveLength(1)
    // latest observation wins, but the alert keeps when it started
    expect(b.file.alerts[0].observed_value).toBe(-0.09)
    expect(b.file.alerts[0].detected_at).toBe(t0.toISOString())
    expect(b.file.alerts[0].last_observed_at).toBe(t1.toISOString())
  })

  it('resolves an alert when the condition stops holding', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    const b = reconcile(a.file, [], ['LLY'], t1)
    expect(b.resolved).toHaveLength(1)
    expect(b.file.alerts[0]).toMatchObject({ status: 'resolved', resolved_at: t1.toISOString() })
  })

  it('does NOT resolve an instrument that was not evaluated this run', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    const b = reconcile(a.file, [], [], t1)          // LLY could not be priced
    expect(b.resolved).toHaveLength(0)
    expect(b.file.alerts[0].status).toBe('active')
  })

  it('a new business day is a new alert, not a continuation', () => {
    const a = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    const b = reconcile(a.file, [obs('price_drop', 'LLY', -0.07)], ['LLY'], t2)
    expect(b.opened).toHaveLength(1)
    expect(b.file.alerts).toHaveLength(2)
  })

  it('separates rules on the same instrument', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07), obs('news_velocity', 'LLY', 5)], ['LLY'], t0)
    expect(r.opened).toHaveLength(2)
  })

  // The incident, inverted: nothing here can be advanced by a send.
  it('has no delivery state at all', () => {
    const r = reconcile(empty(), [obs('price_drop', 'LLY', -0.07)], ['LLY'], t0)
    const keys = Object.keys(r.file.alerts[0])
    expect(keys.some(k => /sent|deliver|notif|line|channel|retry/i.test(k))).toBe(false)
  })
})
