import { describe, it, expect } from 'vitest'
import { computeBookTotals, type BookPosition } from '../src/risk/risk-runner.js'
import { alignedReturns, buildClusterStats, correlatablePositions, type CorrelationCell } from '../src/correlation/correlation-runner.js'
import { formatReport } from '../src/correlation/correlation-report.js'

// The 2026-08-19 bug (`af691cd`) fixed the briefing, which reported the priced
// SLEEVE's weights as shares of the portfolio. The correlation report was the
// second renderer carrying the same defect: its `loadPositions` pre-filtered to
// positions with a Yahoo symbol, so the sleeve became the denominator of a
// column literally titled "% of portfolio". On 2026-08-25 that printed
// "VEA, ASML = 12.8% of portfolio" when the pair was 2.7% of net worth.

const FX = 32.73

// A miniature of the live 2026-08-25 book.
const BOOK: BookPosition[] = [
  { ticker: 'VEA',      priceSymbol: 'VEA',     currentValue: 1001.10,   currency: 'USD', assetClass: 'us_equity' },
  { ticker: 'ASML',     priceSymbol: 'ASML',    currentValue: 1462.23,   currency: 'USD', assetClass: 'us_equity' },
  { ticker: 'LLY',      priceSymbol: 'LLY',     currentValue: 3803.14,   currency: 'USD', assetClass: 'us_equity' },
  { ticker: 'TDEX.BK',  priceSymbol: 'TDEX.BK', currentValue: 42280,     currency: 'THB', assetClass: 'th_equity' },
  // cash — real net worth, no return series
  { ticker: 'CASH_THB',    priceSymbol: '', currentValue: 361223.50, currency: 'THB', assetClass: 'cash' },
  { ticker: 'SAVINGS_THB', priceSymbol: '', currentValue: 500000,    currency: 'THB', assetClass: 'cash' },
  { ticker: 'CASH_USD',    priceSymbol: '', currentValue: 18516.84,  currency: 'USD', assetClass: 'cash' },
  // NAV-only Thai funds — held, unpriceable by Yahoo
  { ticker: 'PFM009',         priceSymbol: '', currentValue: 568513.48, currency: 'THB', assetClass: 'th_fund' },
  { ticker: 'KKP-US500-UH-E', priceSymbol: '', currentValue: 40000,     currency: 'THB', assetClass: 'th_fund' },
]

const PAIRS: CorrelationCell[] = [{ a: 'VEA', b: 'ASML', correlation: 0.75 }]

function build() {
  const totals    = computeBookTotals(BOOK, FX)
  const positions = correlatablePositions(BOOK)
  const sleeve    = positions.reduce((s, p) => s + (p.currency === 'THB' ? p.currentValue / FX : p.currentValue), 0)
  const clusters  = buildClusterStats([['VEA', 'ASML']], PAIRS, positions, FX, sleeve, totals.netWorthUSD)
  return { totals, positions, sleeve, clusters }
}

describe('correlatablePositions', () => {
  it('keeps only positions that can actually carry a return series', () => {
    const tickers = correlatablePositions(BOOK).map(p => p.ticker)
    expect(tickers).toEqual(['VEA', 'ASML', 'LLY', 'TDEX.BK'])
    expect(tickers).not.toContain('CASH_THB')       // cash has no returns
    expect(tickers).not.toContain('PFM009')         // NAV-only, no Yahoo symbol
  })
})

describe('buildClusterStats — two denominators, both real', () => {
  it('reports a cluster as a far smaller share of net worth than of the sleeve', () => {
    const { clusters, totals } = build()
    const c = clusters[0]

    // sleeve share — the number the old code printed as "% of portfolio"
    expect(c.pctOfSleeve).toBeGreaterThan(10)
    // net-worth share — the honest concentration figure, several times smaller
    expect(c.pctOfNetWorth!).toBeLessThan(c.pctOfSleeve / 3)

    // The invariant that proves the two denominators are consistent:
    // share of net worth = share of sleeve × the sleeve's coverage of net worth.
    expect(c.pctOfNetWorth!).toBeCloseTo(c.pctOfSleeve * totals.coverageOfNetWorth, 6)
  })

  it('sizes the cluster from the member positions, FX-converted', () => {
    const { clusters } = build()
    expect(clusters[0].totalValueUSD).toBeCloseTo(1001.10 + 1462.23, 2)
  })

  it('averages only the correlations between cluster members', () => {
    const { clusters } = build()
    expect(clusters[0].avgCorrelation).toBeCloseTo(0.75, 4)
  })

  it('returns a null net-worth share rather than a fake one when net worth is unknown', () => {
    const { positions, sleeve } = build()
    const c = buildClusterStats([['VEA', 'ASML']], PAIRS, positions, FX, sleeve, 0)[0]
    expect(c.pctOfNetWorth).toBeNull()
    expect(c.pctOfSleeve).toBeGreaterThan(0)
  })
})

describe('formatReport — the denominator must be named, never bare', () => {
  function render() {
    const { totals, positions, sleeve, clusters } = build()
    return formatReport({
      positions,
      series: positions.map(p => ({ ticker: p.ticker, dates: [], closes: [] })),
      pairs: PAIRS,
      clusters,
      totals,
      sleeveValueUSD: sleeve,
      windowDays: 90,
      correlationThreshold: 0.7,
      concentrationWarnPctNetWorth: 15,
    })
  }

  it('never prints an unqualified "% of portfolio" column again', () => {
    expect(render()).not.toContain('% of portfolio')
  })

  it('names both denominators in the cluster table', () => {
    const r = render()
    expect(r).toContain('% of NET WORTH')
    expect(r).toContain('% of correlated sleeve')
  })

  it('discloses net worth, the covered fraction, and what was excluded', () => {
    const r = render()
    expect(r).toContain('**Net worth:**')
    expect(r).toContain('% of net worth**')
    expect(r).toContain('Not correlatable')
    expect(r).toContain('PFM009')          // named, not silently dropped
    expect(r).toContain('KKP-US500-UH-E')
  })

  it('does not flag OVER-CONCENTRATED on a cluster that is small against net worth', () => {
    // 12.8% of the sleeve but ~2.7% of net worth — a watch item, not a breach.
    const r = render()
    expect(r).toContain('🟡 Watch')
    expect(r).not.toContain('🔴 OVER-CONCENTRATED')
  })

  it('does flag a cluster that genuinely exceeds the net-worth threshold', () => {
    const { totals, positions, sleeve } = build()
    // Same cluster, but priced as if it were a fifth of everything Neil owns.
    const huge = buildClusterStats([['VEA', 'ASML']], PAIRS, positions, FX, sleeve, totals.netWorthUSD)
      .map(c => ({ ...c, pctOfNetWorth: 22.4 }))
    const r = formatReport({
      positions,
      series: positions.map(p => ({ ticker: p.ticker, dates: [], closes: [] })),
      pairs: PAIRS,
      clusters: huge,
      totals,
      sleeveValueUSD: sleeve,
      windowDays: 90,
      correlationThreshold: 0.7,
      concentrationWarnPctNetWorth: 15,
    })
    expect(r).toContain('🔴 OVER-CONCENTRATED')
    expect(r).toContain('of NET WORTH')
  })
})

// The 2026-08-25 date-alignment bug. `pearson` aligned two return arrays by
// POSITION (`slice(-n)`), not by date. Instruments on different session
// calendars — NYSE Arca vs COMEX, or SET vs NYSE — disagree on holidays, so a
// single extra session in one series shifts every earlier observation by one
// slot. Live proof that day: GLDM vs GC=F, two instruments tracking the same
// metal, printed 0.1225 positionally against 0.8511 date-joined.
describe('alignedReturns — pairs must be joined on dates, never on position', () => {
  // Same underlying moves, but B trades one extra session at the start.
  const A = {
    ticker: 'GLDM',
    dates:  ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'],
    closes: [100, 102, 101, 104],
  }
  const B = {
    ticker: 'GOLD_OZ',
    dates:  ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'],
    closes: [55, 200, 204, 202, 208],   // 2026-08-03 onward is exactly 2x A
  }

  it('drops the unshared session and recovers the true relationship', () => {
    const al = alignedReturns(A, B)
    expect(al.sharedDays).toBe(4)
    expect(al.a).toHaveLength(3)
    expect(al.b).toHaveLength(3)
    // B is a perfect 2x of A on the shared dates, so returns are identical
    al.a.forEach((r, i) => expect(al.b[i]).toBeCloseTo(r, 12))
  })

  it('is symmetric', () => {
    const ab = alignedReturns(A, B)
    const ba = alignedReturns(B, A)
    expect(ba.sharedDays).toBe(ab.sharedDays)
    ab.a.forEach((r, i) => expect(ba.b[i]).toBeCloseTo(r, 12))
  })

  it('returns nothing usable when the two series never overlap', () => {
    const far = { ticker: 'X', dates: ['2020-01-02', '2020-01-03'], closes: [1, 2] }
    const al = alignedReturns(A, far)
    expect(al.sharedDays).toBe(0)
    expect(al.a).toHaveLength(0)
  })

  it('ignores gaps and null-priced days rather than shifting past them', () => {
    const gappy = {
      ticker: 'G',
      dates:  ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'],
      closes: [200, 204, 0, 208],   // 08-05 unpriced
    }
    const al = alignedReturns(A, gappy)
    expect(al.sharedDays).toBe(3)   // 08-05 excluded from BOTH sides
  })
})
