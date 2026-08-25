// Format correlation analysis into a markdown report.

import type { PriceSeries, CorrelationCell, Cluster } from './correlation-runner.js'
import type { BookTotals } from '../risk/risk-runner.js'

interface Position {
  ticker:       string
  assetClass:   string
  priceSymbol:  string
  currentValue: number
}

interface FormatOptions {
  /** The correlatable subset only — positions carrying a Yahoo price symbol. */
  positions:            Position[]
  series:               PriceSeries[]
  pairs:                CorrelationCell[]
  clusters:             Cluster[]
  /** Whole-book split: net worth, what's covered, and what is not. */
  totals:               BookTotals
  /** Value of the correlated sleeve — context, never a concentration denominator. */
  sleeveValueUSD:       number
  windowDays:           number
  correlationThreshold: number
  concentrationWarnPctNetWorth: number
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

export function formatReport(opts: FormatOptions): string {
  const {
    positions, series, pairs, clusters, totals, sleeveValueUSD,
    windowDays, correlationThreshold, concentrationWarnPctNetWorth,
  } = opts
  const usd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  const today = new Date().toISOString().slice(0, 10)
  const out: string[] = []

  out.push(`# Portfolio Correlation Report`)
  out.push(`**Generated:** ${today}`)
  out.push(`**Window:** ${windowDays} trading days`)
  out.push(`**Positions analyzed:** ${series.length} of ${positions.length} correlatable (others lack a Yahoo symbol)`)
  out.push(`**Pairwise correlations computed:** ${pairs.length}`)
  out.push('')
  // TWO denominators, both named. Reporting a sleeve share as a share of the
  // portfolio is the 2026-08-19 bug (`af691cd`); it lived here too until
  // 2026-08-25. Concentration is judged on net worth, and the gap is disclosed.
  out.push(`**Net worth:** ${usd0(totals.netWorthUSD)} — of which cash ${usd0(totals.cashUSD)}, unpriced/NAV-only holdings ${usd0(totals.unpricedUSD)}, correlated sleeve ${usd0(sleeveValueUSD)} (**${(totals.coverageOfNetWorth * 100).toFixed(1)}% of net worth**).`)
  if (totals.unpricedTickers.length > 0) {
    out.push(`**Not correlatable** (no price series — excluded from every number below, NOT from your net worth): ${totals.unpricedTickers.join(', ')}.`)
  }
  out.push('')
  out.push(`> ⚠️ Correlations and cluster sizes cover only the ${(totals.coverageOfNetWorth * 100).toFixed(1)}% of net worth that has a return series. A cluster's **% of net worth** is the concentration figure; **% of sleeve** is shown for context only and will always look larger.`)
  out.push('')
  out.push('> Correlation = +1: tickers move together perfectly (no diversification).')
  out.push(`> Correlation = -1: opposite moves (great hedge). 0 = independent.`)
  out.push(`> Pairs at \\>= ${correlationThreshold} get clustered as "concentration risk".`)
  out.push('')
  out.push('---')
  out.push('')

  // ── Concentration warnings ──────────────────────────────────────────────
  out.push('## ⚠️ Concentration risk clusters')
  out.push('')
  if (clusters.length === 0) {
    out.push(`No clusters at correlation \\>= ${correlationThreshold}. Portfolio is well-diversified across the analyzed positions.`)
  } else {
    out.push('Holdings that move together and concentrate risk. Each cluster is')
    out.push(`treated as a single risk bet for the purpose of position sizing.`)
    out.push('')
    out.push('| Cluster members | Combined value | % of NET WORTH | % of correlated sleeve | Avg correlation | Flag |')
    out.push('|---|---|---|---|---|---|')
    for (const c of clusters) {
      const overNet = c.pctOfNetWorth != null && c.pctOfNetWorth >= concentrationWarnPctNetWorth
      const flag = overNet ? '🔴 OVER-CONCENTRATED' : '🟡 Watch'
      const netStr = c.pctOfNetWorth == null ? '—' : `${c.pctOfNetWorth.toFixed(1)}%`
      out.push(`| ${c.members.join(', ')} | ${usd0(c.totalValueUSD)} | ${netStr} | ${c.pctOfSleeve.toFixed(1)}% | ${c.avgCorrelation.toFixed(2)} | ${flag} |`)
    }
    out.push('')
    const overConc = clusters.filter(c => c.pctOfNetWorth != null && c.pctOfNetWorth >= concentrationWarnPctNetWorth)
    if (overConc.length > 0) {
      out.push(`> 🔴 **${overConc.length} cluster(s) exceed ${concentrationWarnPctNetWorth}% of NET WORTH** (the satellite hard cap). Consider reducing exposure or adding uncorrelated positions as hedge.`)
      out.push('')
    } else {
      out.push(`> 🟡 No cluster exceeds the **${concentrationWarnPctNetWorth}% of net worth** breach threshold — worth watching, but not a concentration breach. (That is the ONLY threshold; the sleeve column has none, because a share of a ${(totals.coverageOfNetWorth * 100).toFixed(0)}% slice cannot be compared to a whole-book limit.)`)
      out.push('')
    }
  }

  // ── Top correlated pairs ────────────────────────────────────────────────
  out.push('## Most correlated pairs (top 20)')
  out.push('')
  out.push('| Ticker A | Ticker B | Correlation | Strength |')
  out.push('|---|---|---|---|')
  for (const p of pairs.slice(0, 20)) {
    const strength = Math.abs(p.correlation) >= 0.8 ? '🔴 Very strong'
      : Math.abs(p.correlation) >= 0.6 ? '🟡 Strong'
      : Math.abs(p.correlation) >= 0.3 ? '🟢 Moderate'
      : '⚪ Weak'
    out.push(`| ${p.a} | ${p.b} | ${fmtPct(p.correlation * 100)}% | ${strength} |`)
  }
  out.push('')

  // ── Best hedge pairs (negative correlation) ─────────────────────────────
  const negativePairs = [...pairs].filter(p => p.correlation < -0.2).sort((a, b) => a.correlation - b.correlation)
  out.push('## Natural hedges (negative correlation)')
  out.push('')
  if (negativePairs.length === 0) {
    out.push('No meaningful negative correlations found in this portfolio. Consider adding genuinely uncorrelated assets (long-duration bonds, gold, defensive sectors) for downside protection.')
  } else {
    out.push('| Ticker A | Ticker B | Correlation | Note |')
    out.push('|---|---|---|---|')
    for (const p of negativePairs.slice(0, 10)) {
      const note = p.correlation < -0.5 ? '🟢 Strong hedge' : '🟡 Mild offset'
      out.push(`| ${p.a} | ${p.b} | ${fmtPct(p.correlation * 100)}% | ${note} |`)
    }
  }
  out.push('')

  // ── Full matrix ──────────────────────────────────────────────────────────
  const tickers = series.map(s => s.ticker)
  if (tickers.length > 1 && tickers.length <= 20) {
    out.push('## Full correlation matrix')
    out.push('')
    out.push('| Ticker | ' + tickers.join(' | ') + ' |')
    out.push('|---' + tickers.map(() => '|---').join('') + '|')
    const cellByPair = new Map<string, number>()
    for (const p of pairs) {
      cellByPair.set(`${p.a}|${p.b}`, p.correlation)
      cellByPair.set(`${p.b}|${p.a}`, p.correlation)
    }
    for (const a of tickers) {
      const row = tickers.map(b => {
        if (a === b) return '1.00'
        const c = cellByPair.get(`${a}|${b}`)
        return c == null ? '—' : c.toFixed(2)
      })
      out.push(`| **${a}** | ${row.join(' | ')} |`)
    }
    out.push('')
  }

  // ── Interpretation ──────────────────────────────────────────────────────
  out.push('## How to read this')
  out.push('')
  out.push(`1. **Concentration clusters** are your true single risk bets. Size them on **% of net worth** — a cluster at 40% of the correlated sleeve is only ${(0.4 * (opts.totals.coverageOfNetWorth * 100)).toFixed(0)}% of what you actually own at today's ${(opts.totals.coverageOfNetWorth * 100).toFixed(0)}% coverage.`)
  out.push('2. **Natural hedges** earn their place by going up when others go down — these are precious.')
  out.push('3. **All correlations are recent** (last 90 days). In a regime shift, historically uncorrelated assets can suddenly move together (2008 lesson).')

  return out.join('\n')
}
