import { describe, it, expect } from 'vitest'
import {
  resolveQuoteUnit,
  formatQuote,
  buildDcaRow,
  type DcaTarget,
} from '../src/briefing/dca-targets.js'

// The 2026-08-25 bug: the renderer picked its currency symbol from
// `DcaTarget.currency`, which is the CASH POT that funds the buy — not the
// currency the instrument is quoted in. Every baht-funded DIME row tracks a
// USD-listed proxy, so the ladder printed VOO's $701.83 as "฿701.83" (~32x)
// in the same table used to place real trades.

function target(over: Partial<DcaTarget>): DcaTarget {
  return {
    label:       'test',
    yahooSymbol: 'VOO',
    target:      705,
    direction:   'below',
    currency:    'USD',
    buyNow:      '$1,750',
    buyDeeper:   '$1,750',
    note:        '',
    ...over,
  }
}

describe('resolveQuoteUnit', () => {
  it('defaults to USD for a plain US-listed symbol', () => {
    expect(resolveQuoteUnit({ yahooSymbol: 'VOO' })).toBe('USD')
    expect(resolveQuoteUnit({ yahooSymbol: 'QQQ' })).toBe('USD')
    expect(resolveQuoteUnit({ yahooSymbol: 'VEA' })).toBe('USD')
  })

  it('treats a .BK suffix as a baht quote', () => {
    expect(resolveQuoteUnit({ yahooSymbol: 'TDEX.BK' })).toBe('THB')
    expect(resolveQuoteUnit({ yahooSymbol: 'GULF.BK' })).toBe('THB')
  })

  it('treats a ^ prefix as index points, even when it also ends in .BK', () => {
    expect(resolveQuoteUnit({ yahooSymbol: '^SET50.BK' })).toBe('index')
  })

  it('treats an =X suffix as an FX rate', () => {
    expect(resolveQuoteUnit({ yahooSymbol: 'THB=X' })).toBe('rate')
  })

  it('lets an explicit quoteCurrency override the derivation', () => {
    expect(resolveQuoteUnit({ yahooSymbol: '^SET50.BK', quoteCurrency: 'THB' })).toBe('THB')
  })
})

describe('formatQuote', () => {
  it('renders each unit in its own notation', () => {
    expect(formatQuote(701.83, 'USD')).toBe('$701.83')
    expect(formatQuote(10.57, 'THB')).toBe('฿10.57')
    expect(formatQuote(1073.6, 'index')).toBe('1,073.60 pts')
    expect(formatQuote(32.73, 'rate')).toBe('฿32.73/$')
  })
})

describe('buildDcaRow — the funding bucket must not set the quote unit', () => {
  it('quotes a baht-FUNDED row that tracks a USD proxy in dollars', () => {
    // KKP US500-UH-E: bought with baht on DIME, but priced off VOO.
    const row = buildDcaRow(
      target({ label: 'KKP US500-UH-E', yahooSymbol: 'VOO', currency: 'THB', target: 705 }),
      701.83,
    )
    expect(row).toContain('$701.83')
    expect(row).toContain('$705')
    expect(row).not.toContain('฿701.83')
    expect(row).not.toContain('฿705')
  })

  it('still shows which cash pot funds the buy', () => {
    expect(buildDcaRow(target({ currency: 'THB' }), 701.83)).toContain('฿ baht')
    expect(buildDcaRow(target({ currency: 'USD' }), 701.83)).toContain('$ USD')
  })

  it('quotes a genuinely baht-denominated row in baht', () => {
    const row = buildDcaRow(
      target({ label: 'TDEX', yahooSymbol: 'TDEX.BK', currency: 'THB', target: 10 }),
      10.57,
    )
    expect(row).toContain('฿10.57')
  })

  it('renders the FX trigger as a rate, not as a dollar price', () => {
    const row = buildDcaRow(
      target({ label: 'USD/THB', yahooSymbol: 'THB=X', currency: 'USD', target: 32.5 }),
      32.73,
    )
    expect(row).toContain('฿32.73/$')
    expect(row).not.toContain('$32.73 ')
  })

  it('renders the SET50 trigger in index points', () => {
    const row = buildDcaRow(
      target({ label: 'SET50', yahooSymbol: '^SET50.BK', currency: 'THB', target: 1040 }),
      1073.6,
    )
    expect(row).toContain('1,073.60 pts')
    expect(row).toContain('1,040.00 pts')
  })
})

describe('buildDcaRow — trigger logic is unchanged by the unit fix', () => {
  it('flags a below-target as TRIGGERED', () => {
    const row = buildDcaRow(target({ target: 705, direction: 'below' }), 701.83)
    expect(row).toContain('🟢 **TRIGGERED**')
    expect(row).toContain('at/through level')
  })

  it('reports distance when not yet triggered', () => {
    const row = buildDcaRow(target({ label: 'LLY', yahooSymbol: 'LLY', target: 1080 }), 1246.93)
    expect(row).not.toContain('TRIGGERED')
    expect(row).toContain('13.4% away')
  })

  it('supports above-direction triggers', () => {
    expect(buildDcaRow(target({ target: 700, direction: 'above' }), 701.83)).toContain('TRIGGERED')
    expect(buildDcaRow(target({ target: 710, direction: 'above' }), 701.83)).not.toContain('TRIGGERED')
  })

  it('degrades gracefully when the quote fetch failed', () => {
    const row = buildDcaRow(target({}), null)
    expect(row).toContain('| — | $705.00 | — |')
    expect(row).not.toContain('TRIGGERED')
  })
})
