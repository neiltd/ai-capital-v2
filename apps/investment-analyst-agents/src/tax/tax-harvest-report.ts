import type { TaxHarvestJSON } from './tax-harvest-runner.js'

function fmtUSD(n: number): string {
  const sign = n >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(n).toFixed(0)}`
}

export function formatReport(d: TaxHarvestJSON): string {
  const out: string[] = []

  out.push('# Tax-Loss Harvesting Report')
  out.push(`**Generated:** ${d.generatedAt}`)
  out.push(`**FX rate (USD/THB):** ${d.fxRateUsdThb ?? 'unknown'}`)
  out.push('')
  out.push('> Thai SET equities are EXEMPT from capital gains tax for Thai resident individuals')
  out.push('> (per Thai personal income tax code). Harvest opportunities on `.BK` tickers are')
  out.push('> informational — they provide no cash tax saving. Tax-locked vehicles (THAIESG/RMF/SSF/PFM)')
  out.push('> cannot be harvested without clawback.')
  out.push('')
  out.push('---')
  out.push('')

  // ── YTD realized ───────────────────────────────────────────────────────
  out.push('## Year-to-date realized P&L (USD-equivalent)')
  out.push('')
  out.push('| Metric | Value |')
  out.push('|---|---|')
  out.push(`| YTD gains | ${fmtUSD(d.realizedYTD.gainsUSD)} |`)
  out.push(`| YTD losses | ${fmtUSD(d.realizedYTD.lossesUSD)} |`)
  out.push(`| **Net taxable** | **${fmtUSD(d.realizedYTD.netTaxableUSD)}** |`)
  out.push(`| Sell trades YTD | ${d.realizedYTD.trades} |`)
  out.push('')

  // ── Harvest opportunities ──────────────────────────────────────────────
  out.push('## Harvest opportunities (positions underwater right now)')
  out.push('')
  if (d.harvestOpportunities.length === 0) {
    out.push('No underwater positions above the $100 threshold.')
  } else {
    out.push('| Ticker | Strategy | Jurisdiction | Loss (USD) | Harvestable? | Notes |')
    out.push('|---|---|---|---|---|---|')
    for (const o of d.harvestOpportunities) {
      const harv = o.harvestable
        ? (o.washSaleRisk ? '⚠️ Wash sale' : '✅ Yes')
        : '🔒 No'
      out.push(`| ${o.ticker} | ${o.strategy} | ${o.taxJurisdiction} | ${fmtUSD(o.unrealizedLossUSD)} | ${harv} | ${o.notes} |`)
    }
  }
  out.push('')

  // ── Wash sale alerts ───────────────────────────────────────────────────
  out.push('## Active wash-sale windows (do NOT rebuy these yet)')
  out.push('')
  if (d.washSaleAlerts.length === 0) {
    out.push('No active wash-sale windows. Safe to rebuy any ticker.')
  } else {
    out.push('| Ticker | Sold on | Shares × Price | Don\'t rebuy before | Days remaining |')
    out.push('|---|---|---|---|---|')
    for (const w of d.washSaleAlerts) {
      out.push(`| ${w.ticker} | ${w.soldAt} | ${w.soldShares} × $${w.soldPrice.toFixed(2)} | ${w.doNotRebuyBefore} | ${w.daysRemaining}d |`)
    }
    out.push('')
    out.push('> US IRS Section 1091: re-acquiring a "substantially identical" security within 30 days')
    out.push('> of a loss-sale disallows the loss deduction. Wait until the date shown.')
  }
  out.push('')

  // ── Summary ────────────────────────────────────────────────────────────
  out.push('## Summary for briefing')
  out.push('')
  out.push(`\`\`\`\n${d.summary}\n\`\`\``)

  return out.join('\n')
}
