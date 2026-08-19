import type { RiskMetricsJSON } from './risk-runner.js'

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function formatReport(d: RiskMetricsJSON): string {
  const out: string[] = []

  out.push('# Portfolio Risk Metrics')
  out.push(`**Generated:** ${d.generatedAt}`)
  out.push(`**Window:** ${d.windowDays} trading days`)
  out.push(`**Benchmark:** ${d.benchmark}`)
  // The analyzed sleeve is only the priced securities. Stating it next to true
  // net worth (and the coverage fraction) is what stops a sleeve weight being
  // read as a share of the whole book downstream.
  out.push(`**Priced sleeve (what these metrics cover):** ${fmtUsd(d.analyzedValueUSD ?? d.portfolioValueUSD)}`)
  if (d.netWorthUSD) {
    const cov = d.coverageOfNetWorth ?? (d.analyzedValueUSD ?? d.portfolioValueUSD) / d.netWorthUSD
    out.push(`**Total net worth:** ${fmtUsd(d.netWorthUSD)} — the sleeve is **${(cov * 100).toFixed(1)}%** of it`)
    const excluded: string[] = []
    if (d.cashUSD) excluded.push(`cash ${fmtUsd(d.cashUSD)}`)
    if (d.unpricedUSD) {
      const names = d.unpricedTickers?.length ? ` (${d.unpricedTickers.join(', ')})` : ''
      excluded.push(`NAV-only / unpriced holdings ${fmtUsd(d.unpricedUSD)}${names}`)
    }
    if (excluded.length) out.push(`**Not covered:** ${excluded.join('; ')}`)
  }
  out.push(`**FX (USD/THB):** ${d.fxRateUsdThb?.toFixed(2) ?? 'unknown — THB positions not converted'}`)
  out.push('')
  out.push('---')
  out.push('')

  // ── Portfolio-level metrics ─────────────────────────────────────────────
  out.push('## Portfolio-level metrics')
  out.push('')
  out.push('| Metric | Value | Interpretation |')
  out.push('|---|---|---|')
  out.push(`| Annualized volatility | ${fmtPct(d.portfolioVolatility)} | Lower is calmer; <15% = conservative, 15-25% = balanced, >25% = aggressive |`)
  out.push(`| Total return (${d.windowDays}d) | ${fmtPct(d.portfolioReturn)} | Portfolio performance over the window |`)
  out.push(`| Sharpe ratio (ann) | ${d.sharpeRatio.toFixed(2)} | Risk-adjusted return; >1.0 is good, >2.0 is excellent, <0 means underperforming risk-free |`)
  out.push(`| Max drawdown | ${fmtPct(d.maxDrawdown)} | Worst peak-to-trough loss in the window |`)
  out.push(`| 1-day 95% VAR | $${d.oneDayVAR95.toFixed(0)} | On a "bad" day (5th percentile), expected loss of this much |`)
  out.push(`| Beta vs ${d.benchmark} | ${d.portfolioBeta.toFixed(2)} | 1.0 = moves with market; <1 = defensive; >1 = aggressive; <0 = inverse |`)
  out.push('')

  // ── Per-ticker breakdown ────────────────────────────────────────────────
  out.push('## Per-ticker contribution')
  out.push('')
  out.push('| Ticker | % of net worth | % of priced sleeve | Vol (ann) | Return (90d) | Beta | Corr to ' + d.benchmark + ' |')
  out.push('|---|---|---|---|---|---|---|')
  for (const t of d.perTicker) {
    const nw = t.weightOfNetWorth != null ? fmtPct(t.weightOfNetWorth) : 'n/a'
    out.push(`| ${t.ticker} | ${nw} | ${fmtPct(t.weight)} | ${fmtPct(t.volatility)} | ${fmtPct(t.totalReturn)} | ${t.beta.toFixed(2)} | ${t.correlation.toFixed(2)} |`)
  }
  out.push('')

  // ── Interpretation ──────────────────────────────────────────────────────
  out.push('## How to read this')
  out.push('')
  out.push('- **Two denominators** — "% of net worth" is the real position size; "% of priced sleeve" is only the share of the securities these risk stats could be computed on. Never quote the sleeve figure as portfolio concentration.')
  out.push('- **High beta + high weight** = single position can swing the portfolio significantly')
  out.push('- **Negative beta** = natural hedge — when the market falls, this position rises')
  out.push('- **Correlation ≠ beta** — correlation measures direction, beta measures magnitude')
  out.push('- **VAR is a probabilistic floor, not a worst case** — actual tail events can exceed it')
  out.push('- **Sharpe degrades in regime shifts** — a high Sharpe in calm times can collapse in volatility')

  return out.join('\n')
}
