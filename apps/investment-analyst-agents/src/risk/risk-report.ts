import type { RiskMetricsJSON } from './risk-runner.js'

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

export function formatReport(d: RiskMetricsJSON): string {
  const out: string[] = []

  out.push('# Portfolio Risk Metrics')
  out.push(`**Generated:** ${d.generatedAt}`)
  out.push(`**Window:** ${d.windowDays} trading days`)
  out.push(`**Benchmark:** ${d.benchmark}`)
  out.push(`**Portfolio value (analyzed):** $${d.portfolioValueUSD.toFixed(0)}`)
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
  out.push('| Ticker | Weight | Vol (ann) | Return (90d) | Beta | Corr to ' + d.benchmark + ' |')
  out.push('|---|---|---|---|---|---|')
  for (const t of d.perTicker) {
    out.push(`| ${t.ticker} | ${fmtPct(t.weight)} | ${fmtPct(t.volatility)} | ${fmtPct(t.totalReturn)} | ${t.beta.toFixed(2)} | ${t.correlation.toFixed(2)} |`)
  }
  out.push('')

  // ── Interpretation ──────────────────────────────────────────────────────
  out.push('## How to read this')
  out.push('')
  out.push('- **High beta + high weight** = single position can swing the portfolio significantly')
  out.push('- **Negative beta** = natural hedge — when the market falls, this position rises')
  out.push('- **Correlation ≠ beta** — correlation measures direction, beta measures magnitude')
  out.push('- **VAR is a probabilistic floor, not a worst case** — actual tail events can exceed it')
  out.push('- **Sharpe degrades in regime shifts** — a high Sharpe in calm times can collapse in volatility')

  return out.join('\n')
}
