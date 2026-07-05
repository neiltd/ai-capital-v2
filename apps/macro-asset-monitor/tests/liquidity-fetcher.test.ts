import { describe, it, expect } from 'vitest'
import { computeSignal } from '../src/fetchers/liquidity-fetcher.js'

describe('computeSignal — WALCL (Fed Balance Sheet)', () => {
  it('returns draining when 4w change < -20B', () => {
    expect(computeSignal('WALCL', -85, null)).toBe('draining')
  })
  it('returns injecting when 4w change > +20B', () => {
    expect(computeSignal('WALCL', 50, null)).toBe('injecting')
  })
  it('returns neutral when 4w change is between -20 and +20', () => {
    expect(computeSignal('WALCL', 10, null)).toBe('neutral')
  })
  it('returns neutral when change4w is null', () => {
    expect(computeSignal('WALCL', null, null)).toBe('neutral')
  })
})

describe('computeSignal — WTREGEN (Treasury General Account)', () => {
  it('returns draining when 4w change > +20B (rising TGA drains liquidity)', () => {
    expect(computeSignal('WTREGEN', 120, null)).toBe('draining')
  })
  it('returns injecting when 4w change < -20B (falling TGA injects liquidity)', () => {
    expect(computeSignal('WTREGEN', -50, null)).toBe('injecting')
  })
  it('returns neutral within thresholds', () => {
    expect(computeSignal('WTREGEN', 5, null)).toBe('neutral')
  })
})

describe('computeSignal — RRPONTSYD (Overnight Reverse Repo)', () => {
  it('returns draining when 4w change > +20B', () => {
    expect(computeSignal('RRPONTSYD', 180, null)).toBe('draining')
  })
  it('returns injecting when 4w change < -20B', () => {
    expect(computeSignal('RRPONTSYD', -180, null)).toBe('injecting')
  })
})

describe('computeSignal — M2SL (M2 Money Supply)', () => {
  it('returns draining when YoY < -0.5%', () => {
    expect(computeSignal('M2SL', null, -1.2)).toBe('draining')
  })
  it('returns injecting when YoY > +1.0%', () => {
    expect(computeSignal('M2SL', null, 2.5)).toBe('injecting')
  })
  it('returns neutral between thresholds', () => {
    expect(computeSignal('M2SL', null, 0.3)).toBe('neutral')
  })
  it('returns neutral when YoY is null', () => {
    expect(computeSignal('M2SL', null, null)).toBe('neutral')
  })
})
