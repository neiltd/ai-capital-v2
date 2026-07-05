import Anthropic from '@anthropic-ai/sdk'
import type { ContextBundle } from '../types.js'
import { enrichWorldEvents, renderEnrichedEventBlock, loadTradeExposureLookup } from './world-storylines.js'

// Fund code → what it actually invests in. Used by the briefing model to suggest rotation targets.
const FUND_METADATA: Record<string, string> = {
  'SCBCEH':           'SCB China Equity Hedged — China A-share & Hong Kong equity, currency hedged to THB',
  'K-ESGSI-THAIESG':  'Kasikorn THAIESG ESG Fund — Thai SET large-cap equities with ESG criteria (tax-savings scheme)',
  'K-TNZ-THAIESG':    'Kasikorn TNz THAIESG Fund — Thai SET equities with ESG criteria (tax-savings scheme)',
  'K-VIETNAM':        'Kasikorn Vietnam Equity Fund — Vietnamese equity market (VND-denominated)',
  'KFINDIA-A':        'Krungsri India Equity Fund A — Indian equity market (Rupee-denominated)',
  'GOLD_MTS':         'Physical MTS gold — spot gold exposure priced in THB',
}

const SYSTEM_PROMPT = `You are a senior technology investment analyst with deep knowledge of global markets.
Write a concise daily investment briefing in Markdown.
Ground every claim in the provided data — cite specific tickers, signals, and events.
Each section must be tight: the full briefing should be readable in under 5 minutes.
Do not add generic market commentary not supported by the data.

CURRENCY RULE: Portfolio positions tagged [THB] are Thai assets priced in Thai Baht (฿), NOT US Dollars.
Their P&L is shown as "$X.XX USD" (the USD equivalent). When citing losses or gains for Thai positions,
always use the USD equivalent figure and label it USD (e.g. "-$3,007 USD", not "-$98,150").
Never mix the THB amount with a dollar sign — ฿98,150 ≠ $98,150.

FUND ROTATION RULE: When you recommend SELL, TRIM, or EXIT for any mutual fund position, you MUST
include a "↳ Consider rotating into:" line with 2-3 specific alternative investment themes that fit
the current macro regime. Draw from the full global market universe: US equity (broad/tech/value/sector),
European equity (EU), Japanese equity, Vietnamese equity, ASEAN equity, Indian equity, Global bonds,
US Treasuries, Gold, Commodities, Real Estate/REITs, EM equity. Briefly explain why each alternative
fits the regime — 1 sentence each. The investor will pick the specific fund from their bank.

RISK-AWARE RULE: If a "Portfolio Risk Metrics" section is present, use the
numbers to shape position sizing:
  - High portfolio beta (>1.2) means the portfolio is more aggressive than
    the market — recommendations should lean toward de-risking on adverse macro.
  - Low Sharpe ratio (<0.5) means the portfolio's risk-adjusted return is
    poor — be explicit that the user is taking risk without proportional return.
  - High max drawdown (worse than -10%) means recent volatility was severe —
    be cautious about adding to the same factor exposure.
  - High per-ticker volatility (>40% annualized) is a position sizing flag —
    if such a position is also a large weight, mention concentration risk.

TAX-AWARE RULE: If a "Tax Harvest Snapshot" section is present, use it to
shape SELL/TRIM recommendations:
  - For each sell/trim you recommend on a UNDERWATER position, check whether
    the snapshot lists it as harvestable. If yes, mention the harvest dollar
    amount and how it offsets YTD realized gains.
  - If the snapshot lists ACTIVE WASH-SALE WINDOWS, do NOT recommend re-buying
    or adding to those tickers until the "do not rebuy before" date.
  - Thai SET equities ('.BK') are tax-exempt for individuals — harvesting them
    saves no cash tax. Do not present '.BK' harvest as a tax win.
  - Tax-locked positions (THAIESG, RMF, SSF, PFM009) are never harvested.
  - YTD net taxable amount is informational — if YTD realized gains are large,
    the case for harvesting any current losses is stronger.

SELF-CALIBRATION RULE: If a "Briefing Self-Calibration" section is present in the
context, it contains accuracy stats from your own prior recommendations. Use it
honestly to weight today's calls:
  - When your trim/exit signals have outperformed your buy/hold signals, lean
    toward trim when uncertain.
  - When your "high conviction" calls have been INVERTED (worse than medium),
    explicitly downgrade today's high-conviction labels by one level unless you
    have a concrete, named catalyst that justifies the upgrade.
  - When a specific action type has accuracy below 50%, treat it as a coin flip
    in your reasoning — do not claim it as a strong signal.
  - When the calibration shows you historically missed major upside on "hold"
    recommendations, be explicit about the missed-upside risk in any new HOLD
    you issue for an already-winning position.
This is the only mechanism keeping your future recommendations honest. Use it.

CONCENTRATION RISK RULE: If a "Portfolio Correlation" section is present, use the
concentration clusters to shape position sizing recommendations:
  - A cluster marked 🔴 OVER-CONCENTRATED (>30% of portfolio) is a hidden single bet —
    surface it explicitly in Portfolio Health or Today's Recommended Actions.
  - Suggest trimming the largest member of an over-concentrated cluster to bring exposure
    below 30%, unless they are all TAX_LOCKED or DCA positions.
  - Natural hedges (negative correlation) are valuable — do not recommend trimming both
    sides of a genuine hedge unless the thesis on both is broken.
  - Correlation data is 90-day trailing — note if the regime shift could change these
    relationships (e.g., correlations typically spike in a crisis).

STRATEGY-AWARE RULE: Every portfolio position has a strategy tag shown next to its ticker:
  - <TACTICAL> (or unlabeled) — short-term position. Standard exit logic applies: recommend trim/exit
    if thesis breaks OR if short-term scenarios turn unfavorable (no-catalyst, scenario-specific risk).
  - <DCA> — long-term Dollar Cost Averaging position with multi-year horizon. The investor adds on a
    fixed schedule regardless of price. DO NOT recommend exit because of "no catalyst" or "no near-term
    upside" or "scenario-specific drag". Only recommend exit if the LONG-TERM thesis is structurally
    broken (e.g. fraud, sector permanently destroyed, country/asset class unfavorable for 10+ years).
    Underwater status is the strategy working as intended (buying cheaper units). Recommend "continue
    DCA" or "consider accelerating contribution" during drawdowns. Never recommend trim.
  - <TAX_LOCKED> — tax-deduction vehicle (THAIESG, RMF, SSF, social security fund). Selling triggers
    tax clawback that destroys the rationale for owning it. NEVER recommend sell/trim/exit on these
    positions regardless of price action or thesis. Only acceptable recommendations: "continue
    contributions", "pause new contributions", or "tax-locked — hold to maturity".

Produce exactly these sections in this order:
# Investment Briefing — {date}
## Macro Regime
## World Intelligence
## Portfolio Health
## Thesis Status
## Key People
## Scenario Outlook
## Today's Recommended Actions
## Things to Watch

## Key People section guidance
Use ONLY the items listed under "Key People Events (last 7 days)" in the context. If that list is empty,
write exactly: "No key people events in the last 7 days." and stop. Otherwise surface the top 3-5 events.
Lead with role_change and key_hire (most strategically meaningful), then public_statement, then
insider_trade. For each event include:
- the person's name and role
- the company ticker
- the event type and a one-line "why it matters" tied to the company thesis or regime
For insider trades, always state the dollar amount. Do not invent people or quotes.`

async function formatContext(ctx: ContextBundle): Promise<string> {
  const tradeLookup = await loadTradeExposureLookup()
  const { analysis, simulation, graph, stockIntel, worldIntel, profile, profileMissing, thesisSummary, peopleEvents, calibration, taxHarvest, risk, correlationReport } = ctx

  const profileBlock = profileMissing
    ? 'No investor profile found — proceeding without personal context.'
    : `## Investor Profile\n${profile}`

  // ── Briefing self-calibration block ──────────────────────────────────────
  // Surfaces the accuracy stats from your own past recommendations so the
  // model can honestly weight today's calls.
  function fmtPct(n: number) { return `${(n * 100).toFixed(1)}%` }
  const calibrationBlock = (() => {
    if (!calibration) return ''
    const shortest = `${Math.min(...calibration.windows)}d`
    const actionLines = Object.entries(calibration.byAction)
      .map(([action, byW]) => {
        const s = byW[shortest]
        if (!s || s.calls === 0) return null
        return `  - ${action.toUpperCase()} (${shortest}, ${s.calls} calls): ${fmtPct(s.accuracy)} accurate, avg return ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn.toFixed(2)}%`
      }).filter(Boolean).join('\n')
    const convictionLines = ['high', 'medium', 'low']
      .map(c => {
        const s = calibration.byConviction[c]?.[shortest]
        if (!s || s.calls === 0) return null
        return `  - ${c.toUpperCase()} conviction (${shortest}, ${s.calls} calls): ${fmtPct(s.accuracy)} accurate`
      }).filter(Boolean).join('\n')
    const verdict = calibration.calibrationInverted
      ? `🔴 CALIBRATION INVERTED — high-conviction calls are ${(calibration.highConvictionPenalty * 100).toFixed(1)} pp WORSE than medium. Downgrade today's high-conviction labels unless concretely justified.`
      : `✅ Conviction labels are correctly calibrated (high outperforms medium).`
    return [
      `\n## Briefing Self-Calibration (from your prior recommendations)`,
      `Predictions analyzed: ${calibration.predictionsAnalyzed} | Scored calls: ${calibration.scoredCalls}`,
      ``,
      `### Accuracy by action type`,
      actionLines || '  (not enough data yet)',
      ``,
      `### Accuracy by conviction level`,
      convictionLines || '  (not enough data yet)',
      ``,
      `### Verdict`,
      verdict,
      calibration.bestEdge ? `Best edge: ${calibration.bestEdge.signal} = ${fmtPct(calibration.bestEdge.accuracy)} accurate — lean on this signal.` : '',
      calibration.worstSignal && calibration.worstSignal.accuracy < 0.5 ? `Worst signal: ${calibration.worstSignal.signal} = ${fmtPct(calibration.worstSignal.accuracy)} — treat as coin flip.` : '',
    ].filter(Boolean).join('\n')
  })()

  // ── Tax harvest block ──────────────────────────────────────────────────
  const taxBlock = (() => {
    if (!taxHarvest) return ''
    const fmt = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(0)}`
    const harvestLines = taxHarvest.harvestOpportunities.map(o => {
      const flag = o.harvestable
        ? (o.washSaleRisk ? '⚠️ wash sale risk' : '✅ harvestable')
        : '🔒 not harvestable'
      return `  - ${o.ticker} (${o.taxJurisdiction}, ${o.strategy}): ${fmt(o.unrealizedLossUSD)} USD — ${flag} — ${o.notes}`
    }).join('\n')
    const washLines = taxHarvest.washSaleAlerts.map(w =>
      `  - ${w.ticker}: sold ${w.soldAt}; do NOT rebuy before ${w.doNotRebuyBefore} (${w.daysRemaining}d remaining)`
    ).join('\n')
    return [
      `\n## Tax Harvest Snapshot`,
      `Year-to-date realized P&L (USD): gains ${fmt(taxHarvest.realizedYTD.gainsUSD)}, losses ${fmt(taxHarvest.realizedYTD.lossesUSD)}, net taxable ${fmt(taxHarvest.realizedYTD.netTaxableUSD)} from ${taxHarvest.realizedYTD.trades} sell(s)`,
      ``,
      `### Harvest opportunities (underwater positions)`,
      harvestLines || '  None above $100 threshold',
      ``,
      `### Active wash-sale windows (US §1091 — do NOT rebuy these tickers)`,
      washLines || '  None',
    ].join('\n')
  })()

  // ── Risk metrics block ─────────────────────────────────────────────────
  const riskBlock = (() => {
    if (!risk) return ''
    const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`
    const topRisk = risk.perTicker
      .filter(t => t.volatility > 0.4 || Math.abs(t.beta) > 1.5 || t.weight > 0.2)
      .slice(0, 10)
      .map(t => `  - ${t.ticker}: weight ${fmtPct(t.weight)}, vol ${fmtPct(t.volatility)}, β ${t.beta.toFixed(2)}, ρ ${t.correlation.toFixed(2)}`)
      .join('\n')
    return [
      `\n## Portfolio Risk Metrics (${risk.windowDays}d window, benchmark ${risk.benchmark})`,
      `Annualized vol: ${fmtPct(risk.portfolioVolatility)} | Sharpe: ${risk.sharpeRatio.toFixed(2)} | Max DD: ${fmtPct(risk.maxDrawdown)} | 1d-95% VAR: $${risk.oneDayVAR95.toFixed(0)} | Portfolio β vs ${risk.benchmark}: ${risk.portfolioBeta.toFixed(2)}`,
      ``,
      `### High-risk / high-weight positions to monitor`,
      topRisk || '  None — risk concentrations are within normal bounds',
    ].join('\n')
  })()

  const r       = analysis.latestRegime
  const signals = analysis.latestSignals.length
    ? analysis.latestSignals.map(s => `  ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}): ${s.description}`).join('\n')
    : '  None'
  const health  = analysis.companySummaries.map(c => `  ${c.ticker}: ${c.healthScore}`).join('\n') || '  None'

  const scenarios = simulation.scenarios.map(s =>
    `### ${s.scenarioType}: ${s.title} (${s.probability}%, ${s.timeHorizon})\n${s.narrative.slice(0, 400)}\nTriggers: ${s.triggers.join('; ')}\nRegime → ${s.regimeTransition ?? 'unchanged'}`
  ).join('\n\n') || '  No scenarios (run npm run simulate first)'

  // Annotate mutual fund positions with their actual investment focus
  const fundAnnotations = simulation.portfolio
    .filter(p => FUND_METADATA[p.ticker])
    .map(p => `  ${p.ticker}: ${FUND_METADATA[p.ticker]}`)
    .join('\n')

  const usdThb = simulation.usdThb ?? null
  const portfolio = simulation.portfolio.length
    ? simulation.portfolio.map(p => {
        const cur = p.currency ?? 'USD'
        const sym = cur === 'THB' ? '฿' : '$'
        // For THB positions: lead with USD equivalent to avoid LLM confusing ฿ with $
        const pnlSign = p.unrealizedPnl >= 0 ? '+' : ''
        const pnlStr = cur === 'THB' && usdThb
          ? `${pnlSign}$${(p.unrealizedPnl / usdThb).toFixed(2)} USD (${pnlSign}${sym}${Math.abs(p.unrealizedPnl).toFixed(0)} THB raw)`
          : `${pnlSign}${sym}${p.unrealizedPnl.toFixed(2)} ${cur}`
        const strat = (p as { strategy?: string }).strategy ?? 'tactical'
        const stratTag = strat === 'tactical' ? '' : ` <${strat.toUpperCase()}>`
        return `  ${p.ticker} [${cur}]${stratTag}: ${p.shares} shares @ ${sym}${p.avgCost.toFixed(2)} | current ${sym}${p.currentPrice.toFixed(2)} | P&L ${pnlStr}`
      }).join('\n')
    : '  No positions held'

  const actions = simulation.actions.length
    ? simulation.actions.map(a =>
        `  ${a.ticker} [${a.conviction}]: ${a.action} ${a.allocationChangePct > 0 ? '+' : ''}${a.allocationChangePct}% — ${a.rationale.slice(0, 100)}`
      ).join('\n')
    : '  None'

  const edges = graph.edges.slice(0, 15).map(e =>
    `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]`
  ).join('\n') || '  None'

  const stockEvents = stockIntel.marketEvents.slice(0, 5).map(e =>
    `  [${e.severity}] ${e.title}: ${e.summary.slice(0, 150)}`
  ).join('\n') || '  None'

  // World-event block: lead with causal chains + counterfactuals when the
  // memory-agent has enriched the events. Falls back to the flat title/summary
  // line when no enrichment exists (older event files, agent hasn't run yet).
  const enriched = enrichWorldEvents(worldIntel.events.slice(0, 5), {
    tradeExposureLookup: tradeLookup ?? undefined,
  })
  const anyEnriched = enriched.some(e => e.counterfactual || e.causedByRationales.length > 0)
  const worldEvents = anyEnriched
    ? enriched.map(renderEnrichedEventBlock).join('\n\n') || '  None'
    : worldIntel.events.slice(0, 5).map(e =>
        `  [${e.severity}] ${e.title}: ${e.summary.slice(0, 150)}`
      ).join('\n') || '  None'

  // Surface only portfolio-relevant people events. Sort: high-impact first, then by date desc.
  const impactRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
  const peopleSorted = [...(peopleEvents ?? [])].sort((a, b) => {
    const ai = impactRank[a.impact] ?? 3
    const bi = impactRank[b.impact] ?? 3
    if (ai !== bi) return ai - bi
    return b.publishedDate.localeCompare(a.publishedDate)
  })
  const peopleBlock = peopleSorted.length === 0
    ? '  None in the last 7 days'
    : peopleSorted.slice(0, 10).map(p => {
        const quote = p.evidenceQuote ? ` | quote: "${p.evidenceQuote.slice(0, 150)}"` : ''
        return `  [${p.impact}] ${p.ticker} ${p.eventType} — ${p.personName} (${p.personRole}): ${p.headline} | ${p.detail.slice(0, 200)} | ${p.publishedDate} (${p.source})${quote}`
      }).join('\n')

  const correlationBlock = correlationReport
    ? `\n## Portfolio Correlation (90-day trailing)\n${(() => {
        const truncated = correlationReport.slice(0, 3000)
        const lastNewline = truncated.lastIndexOf('\n')
        return lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated
      })()}`
    : ''

  return [
    profileBlock,
    calibrationBlock,
    taxBlock,
    riskBlock,
    correlationBlock,
    `\n## Macro Regime: ${r.regime} (${r.confidence} confidence)\n${r.rationale}\nKey Indicators:\n${r.keyIndicators.map(i => `  - ${i}`).join('\n')}`,
    `\n## Propagation Signals:\n${signals}`,
    `\n## Company Health:\n${health}`,
    `\n## Portfolio:\n${portfolio}`,
    fundAnnotations ? `\n## Mutual Fund Details (what each fund invests in):\n${fundAnnotations}` : '',
    thesisSummary ? `\n## Investment Theses:\n${thesisSummary}` : '',
    `\n## Key People Events (last 7 days):\n${peopleBlock}`,
    `\n## Scenarios:\n${scenarios}`,
    `\n## Portfolio Actions:\n${actions}`,
    `\n## Dependency Graph (key edges):\n${edges}`,
    `\n## Stock Market Events:\n${stockEvents}`,
    `\n## World Events:\n${worldEvents}`,
  ].filter(Boolean).join('\n')
}

export async function generateBriefing(
  ctx: ContextBundle,
  options: { client?: Anthropic } = {},
): Promise<string> {
  const client = options.client ?? new Anthropic()

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages:   [{
      role:    'user',
      content: [{ type: 'text', text: `Write today's investment briefing for ${ctx.date}.\n\n${await formatContext(ctx)}` }],
    }],
  })

  const block = message.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Expected text response from Claude')
  return block.text
}
