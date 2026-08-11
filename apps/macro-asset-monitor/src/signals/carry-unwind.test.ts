import { describe, it, expect } from 'vitest'
import { computeCarryUnwindSignal } from './carry-unwind.js'
import type { MarketAsset } from '../types.js'

// Build only the fields the signal reads; fill the rest with inert defaults.
function asset(ticker: string, close: number, change1d: number, changePct1d: number): MarketAsset {
  return { ticker, label: ticker, category: 'dollar', close, change1d, changePct1d, changePct5d: 0, changePct30d: 0, trend: 'stable' }
}
const jpy = (move: number) => asset('JPY=X', 159, move, 0)          // move = daily yen change
const vix = (level: number) => asset('^VIX', level, 0, 0)
const nk  = (pct: number)   => asset('^N225', 65000, 0, pct)        // pct = daily % change

describe('computeCarryUnwindSignal', () => {
  it('is calm on a quiet day', () => {
    const s = computeCarryUnwindSignal([jpy(-0.3), vix(15), nk(0.5)])
    expect(s.status).toBe('calm')
    expect(s.usdJpy).toBe(159)
  })

  it('escalates to tripwire only when a primary fire is confirmed by the Nikkei', () => {
    const s = computeCarryUnwindSignal([jpy(-2.5), vix(28), nk(-4)])
    expect(s.status).toBe('tripwire')
    expect(s.reasons.join(' ')).toMatch(/confirms disorderly/i)
  })

  it('tripwires on a VIX spike + Nikkei confirmation even without a big yen move', () => {
    expect(computeCarryUnwindSignal([jpy(-0.4), vix(26), nk(-3.5)]).status).toBe('tripwire')
  })

  it('stays at watch when USD/JPY jumps > 2 figures but the Nikkei has not confirmed', () => {
    const s = computeCarryUnwindSignal([jpy(2.5), vix(16), nk(-1)])
    expect(s.status).toBe('watch')
    expect(s.reasons.join(' ')).toMatch(/not confirming yet/i)
  })

  it('watches on an elevated-but-sub-trip VIX alone', () => {
    expect(computeCarryUnwindSignal([jpy(-0.5), vix(22), nk(-1)]).status).toBe('watch')
  })

  it('handles missing assets without throwing, flagging insufficient data', () => {
    const s = computeCarryUnwindSignal([nk(-1)])
    expect(s.status).toBe('calm')
    expect(s.usdJpy).toBeNull()
    expect(s.vix).toBeNull()
    expect(s.reasons.join(' ')).toMatch(/insufficient data/i)
  })
})
