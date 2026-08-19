import { describe, it, expect } from 'vitest'
import { computeBookTotals, type BookPosition } from '../src/risk/risk-runner.js'

// A miniature of the real 2026-08-19 book, which is what exposed the bug:
// only 9 of 21 positions carry a Yahoo price_symbol, so the risk run's
// denominator ($14.3k) was ~1/6th of true net worth ($91.1k) — and the
// briefing rendered sleeve weights as "% of the portfolio".
const FX = 32.86

const BOOK: BookPosition[] = [
  // priced securities — these are the only ones the risk math can cover
  { ticker: 'LLY',      priceSymbol: 'LLY',     currentValue: 3927.67,   currency: 'USD', assetClass: 'us_equity' },
  { ticker: 'GULF.BK',  priceSymbol: 'GULF.BK', currentValue: 51600,     currency: 'THB', assetClass: 'th_equity' },
  // cash — real net worth, no price series
  { ticker: 'CASH_THB',    priceSymbol: '', currentValue: 361223.50, currency: 'THB', assetClass: 'cash' },
  { ticker: 'SAVINGS_THB', priceSymbol: '', currentValue: 500000,    currency: 'THB', assetClass: 'cash' },
  // held securities with no price symbol — NAV-only Thai funds + the GLDM gap
  { ticker: 'PFM009', priceSymbol: '', currentValue: 568513.48, currency: 'THB', assetClass: 'th_fund' },
  { ticker: 'GLDM',   priceSymbol: '', currentValue: 4895.96,   currency: 'USD', assetClass: 'gold'    },
]

describe('computeBookTotals', () => {
  it('counts cash and unpriced holdings in net worth, but only priced ones in the analyzed value', () => {
    const t = computeBookTotals(BOOK, FX)

    // analyzed = LLY + GULF.BK only
    expect(t.analyzedValueUSD).toBeCloseTo(3927.67 + 51600 / FX, 2)

    // net worth = every position, FX-converted
    const expectedNet =
      3927.67 + 51600 / FX + 361223.5 / FX + 500000 / FX + 568513.48 / FX + 4895.96
    expect(t.netWorthUSD).toBeCloseTo(expectedNet, 2)

    // the whole point: net worth is far larger than the analyzed sleeve
    expect(t.netWorthUSD).toBeGreaterThan(t.analyzedValueUSD * 4)
  })

  it('reports what was left out so the gap can be disclosed rather than hidden', () => {
    const t = computeBookTotals(BOOK, FX)

    expect(t.cashUSD).toBeCloseTo((361223.5 + 500000) / FX, 2)
    expect(t.unpricedUSD).toBeCloseTo(568513.48 / FX + 4895.96, 2)
    expect(t.unpricedTickers).toEqual(['PFM009', 'GLDM'])
  })

  it('derives the coverage fraction the briefing must disclose', () => {
    const t = computeBookTotals(BOOK, FX)
    expect(t.coverageOfNetWorth).toBeCloseTo(t.analyzedValueUSD / t.netWorthUSD, 6)
    expect(t.coverageOfNetWorth).toBeLessThan(0.25)
  })

  it('leaves THB positions unconverted rather than inventing a rate when FX is unavailable', () => {
    // Mirrors valueInUSD's existing null-fx behaviour; net worth must still be
    // a number so the briefing can degrade gracefully instead of crashing.
    const t = computeBookTotals(BOOK, null)
    expect(Number.isFinite(t.netWorthUSD)).toBe(true)
    expect(t.fxApplied).toBe(false)
  })

  it('ignores zero-value rows so closed positions do not dilute weights', () => {
    const withClosed = [
      ...BOOK,
      { ticker: 'OLD', priceSymbol: 'OLD', currentValue: 0, currency: 'USD', assetClass: 'us_equity' },
    ]
    const t = computeBookTotals(withClosed, FX)
    expect(t.analyzedValueUSD).toBeCloseTo(computeBookTotals(BOOK, FX).analyzedValueUSD, 6)
    expect(t.unpricedTickers).not.toContain('OLD')
  })
})
