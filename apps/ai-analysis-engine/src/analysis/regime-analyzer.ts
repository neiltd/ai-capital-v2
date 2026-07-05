import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CompanyHealth, MacroRegime, RegimeConfidence } from '../types.js'

export interface WorldIntelContext {
  marketEvents: Array<{
    title: string; summary: string; eventType: string
    severity: number; marketDirection?: string; marketRelevance: number; countries: string[]
  }>
  worldEvents: Array<{
    title: string; summary: string; eventType: string
    severity: number; escalationPotential: number; marketRelevance: number; countries: string[]
  }>
}

export interface MacroContext {
  asOf: string
  marketAssets: Array<{
    ticker: string; label: string; category: string
    close: number; change1d: number
    changePct1d: number; changePct5d: number; changePct30d: number
    trend: string
  }>
  economicIndicators: Array<{
    seriesId: string; label: string; category: string
    value: number; releaseDate: string; unit: string; trend: string
  }>
}

export interface LiquidityContext {
  asOf: string
  indicators: Array<{
    seriesId:  string
    label:     string
    value:     number
    unit:      string
    change4w:  number | null
    changeYoY: number | null
    signal:    'draining' | 'neutral' | 'injecting'
  }>
}

export interface GovFlowContext {
  asOf: string
  watchlistAwards: Array<{
    ticker: string; company: string; total30d: number; topAgency: string; contracts: string[]
  }>
  agencyFlows: Array<{
    agency: string; total30d: number; trend: string
  }>
  budgetSignals: Array<{
    billNumber: string; title: string; summary: string
    relevantTickers: string[]; totalFunding: number | null; keyProvisions: string[]
  }>
}

const SYSTEM_PROMPT = `You are a macro technology investment analyst.
Classify the current investment regime using the classify_macro_regime tool.

You have four signal sources:
1. Company health signals — thesis assumption status and recent documents per company
2. World intelligence — live geopolitical events and market events ranked by severity
3. Global liquidity conditions — Fed balance sheet (QE/QT), Treasury issuance (TGA), reverse repo
   drainage, and M2 growth. Contracting liquidity compresses equity multiples even when company
   fundamentals are strong. When liquidity conditions are driving or modifying your assessment,
   say so explicitly in the rationale field.
4. Government capital flows — recent federal contract awards to watchlist companies and top agencies,
   plus forward-looking budget and appropriations signals. Government spending is a leading indicator:
   a DoD AI budget increase precedes contracts by 6-12 months. When watchlist companies are winning
   significant government contracts or relevant appropriations bills have passed, factor this into
   your regime assessment and mention it in the rationale.

Weight them together: company signals reveal sector-level dynamics; world events set the macro risk
backdrop; liquidity conditions determine whether multiple expansion or compression is likely;
government flows provide forward-looking fiscal policy signals.

Regime taxonomy examples (you may coin a new label when none fit):
- AI Acceleration: broad AI infrastructure spending up, GPU demand strong
- Semiconductor Correction: inventory excess, CapEx pullback across fab customers
- Cloud Consolidation: hyperscalers slowing new commitments, renegotiating contracts
- Energy Bottleneck: data center buildout constrained by power availability
- AI Commoditization: model costs falling, compute demand shifting to inference
- Stagflationary Pressure: rate risk rising, macro headwinds compressing multiples`

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_macro_regime',
  description: 'Classify the current macro technology investment regime based on company health signals',
  input_schema: {
    type: 'object',
    properties: {
      regime:          { type: 'string', description: 'Short label, e.g. AI Acceleration' },
      confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
      rationale:       { type: 'string', description: '2-3 sentence explanation' },
      keyIndicators:   { type: 'array', items: { type: 'string' }, description: '3-5 specific evidence points from the health data' },
      affectedTickers: { type: 'array', items: { type: 'string' } },
    },
    required: ['regime', 'confidence', 'rationale', 'keyIndicators', 'affectedTickers'],
  },
}

function formatHealth(health: CompanyHealth[]): string {
  return health.map(h => {
    const assumptions = h.assumptions.map(a => `  - ${a.text} [${a.status}]`).join('\n')
    const chunks = h.recentChunks
      .map(c => `  [${c.publishedDate}] ${c.source}: ${c.content.slice(0, 200)}`)
      .join('\n')
    return [
      `## ${h.ticker} (${h.company}) — health: ${h.healthScore}`,
      h.thesisSummary ? `Thesis: ${h.thesisSummary.slice(0, 500)}` : 'No thesis recorded.',
      assumptions ? `Assumptions:\n${assumptions}` : 'No assumptions.',
      chunks ? `Recent documents:\n${chunks}` : 'No recent documents.',
    ].join('\n')
  }).join('\n\n')
}

function formatWorldIntel(world: WorldIntelContext): string {
  const SEVERITY = (n: number) => n >= 5 ? 'Critical' : n >= 4 ? 'High' : n >= 3 ? 'Medium' : 'Low'

  const marketLines = world.marketEvents
    .filter(e => e.marketRelevance >= 0.5)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 6)
    .map(e =>
      `  [${SEVERITY(e.severity)} · ${e.eventType} · mkt-relevance ${e.marketRelevance.toFixed(2)}] ${e.title}\n  ${e.summary.slice(0, 200)}`
    ).join('\n')

  const worldLines = world.worldEvents
    .filter(e => e.marketRelevance >= 0.3 || e.escalationPotential >= 0.6)
    .sort((a, b) => (b.severity + b.escalationPotential) - (a.severity + a.escalationPotential))
    .slice(0, 6)
    .map(e =>
      `  [${SEVERITY(e.severity)} · ${e.eventType} · escalation ${e.escalationPotential.toFixed(2)}] ${e.title}\n  ${e.summary.slice(0, 200)}`
    ).join('\n')

  const parts: string[] = []
  if (marketLines) parts.push(`### Market Events\n${marketLines}`)
  if (worldLines)  parts.push(`### Geopolitical Events\n${worldLines}`)
  return parts.length ? parts.join('\n\n') : 'No significant world intelligence events.'
}

function formatMacroAssets(macro: MacroContext): string {
  const TREND = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'
  const PCT   = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
  const ABS   = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`

  const byCategory = (cat: string) =>
    macro.marketAssets
      .filter(a => a.category === cat)
      .map(a => {
        const isRate = a.category === 'rates'
        const d1 = isRate ? `${ABS(a.change1d * 100)}bps` : PCT(a.changePct1d)
        const d30 = `${PCT(a.changePct30d)} 30d`
        return `${a.label} ${a.close}(${d1} ${d30} ${TREND(a.trend)})`
      })
      .join(' | ')

  const lines = [
    `## Macro Asset Prices (as of ${macro.asOf})`,
    `RATES      : ${byCategory('rates')}`,
    `DOLLAR     : ${byCategory('dollar')}`,
    `COMMODITIES: ${byCategory('commodities')}`,
    `VOLATILITY : ${byCategory('volatility')}`,
    `GLOBAL EQ  : ${byCategory('global-equity')}`,
    `CREDIT     : ${byCategory('credit')}`,
    '',
    '## Economic Indicators (latest available)',
    ...macro.economicIndicators.map(i =>
      `${i.label.padEnd(24)}: ${i.value} ${i.unit} [${i.releaseDate} ${TREND(i.trend)}]`
    ),
  ]
  return lines.join('\n')
}

export function formatGovFlow(gov: GovFlowContext): string {
  const USD = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`
  const TREND = (t: string) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'

  const awardLines = gov.watchlistAwards
    .filter(a => a.total30d > 0)
    .sort((a, b) => b.total30d - a.total30d)
    .map(a => `  ${a.ticker.padEnd(6)}: ${USD(a.total30d)} from ${a.topAgency} — ${a.contracts[0] ?? ''}`)
    .join('\n')

  const agencyLines = gov.agencyFlows
    .sort((a, b) => b.total30d - a.total30d)
    .slice(0, 5)
    .map(a => `  ${a.agency.padEnd(30)}: ${USD(a.total30d)} ${TREND(a.trend)}`)
    .join('\n')

  const budgetLines = gov.budgetSignals
    .map(b => [
      `  [${b.billNumber}] ${b.title}`,
      `  ${b.summary}`,
      b.relevantTickers.length ? `  Watchlist impact: ${b.relevantTickers.join(', ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n')

  const parts = [`## Government Capital Flows (as of ${gov.asOf})`]
  if (awardLines) parts.push(`### Recent Contract Awards (30d)\n${awardLines}`)
  if (agencyLines) parts.push(`### Top Agencies by Spend (30d)\n${agencyLines}`)
  if (budgetLines) parts.push(`### Budget & Appropriations Signals\n${budgetLines}`)
  return parts.join('\n\n')
}

export function formatLiquidity(liq: LiquidityContext): string {
  const SIGNAL = (s: string) => s === 'draining' ? '⬇ DRAINING' : s === 'injecting' ? '⬆ INJECTING' : '→ NEUTRAL'
  const lines = liq.indicators.map(i => {
    const c4w = i.change4w  != null ? ` | 4w: ${i.change4w >= 0 ? '+' : ''}${i.change4w.toFixed(1)}B` : ''
    const yoy = i.changeYoY != null ? ` | YoY: ${i.changeYoY >= 0 ? '+' : ''}${i.changeYoY.toFixed(2)}%` : ''
    return `${i.label.padEnd(28)}: $${i.value.toFixed(0)}B${c4w}${yoy} [${SIGNAL(i.signal)}]`
  })
  const draining  = liq.indicators.filter(i => i.signal === 'draining').length
  const injecting = liq.indicators.filter(i => i.signal === 'injecting').length
  const summary   = draining > injecting ? 'Net: TIGHTENING' : injecting > draining ? 'Net: EASING' : 'Net: MIXED/NEUTRAL'
  return `## Global Liquidity Conditions (as of ${liq.asOf})\n${lines.join('\n')}\n${summary}`
}

export async function analyzeRegime(
  health: CompanyHealth[],
  options: {
    client?: Anthropic
    worldIntel?: WorldIntelContext
    macroAssets?: MacroContext
    liquidityContext?: LiquidityContext
    govFlowContext?: GovFlowContext
  } = {},
): Promise<MacroRegime> {
  const client = options.client ?? new Anthropic()
  const today  = new Date().toISOString().slice(0, 10)
  const now    = new Date().toISOString()

  const macroSection = options.macroAssets
    ? `\n\n${formatMacroAssets(options.macroAssets)}`
    : ''

  const worldSection = options.worldIntel
    ? `\n\n## World Intelligence (live macro events)\n${formatWorldIntel(options.worldIntel)}`
    : ''

  const liquiditySection = options.liquidityContext
    ? `\n\n${formatLiquidity(options.liquidityContext)}`
    : ''

  const govFlowSection = options.govFlowContext
    ? `\n\n${formatGovFlow(options.govFlowContext)}`
    : ''

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'classify_macro_regime' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Classify the current macro regime.\n\n## Company Health Signals (${health.length} companies)\n${formatHealth(health)}${macroSection}${liquiditySection}${govFlowSection}${worldSection}`, cache_control: { type: 'ephemeral' } }],
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    regime: string; confidence: string; rationale: string
    keyIndicators: string[]; affectedTickers: string[]
  }

  return {
    id:              randomUUID(),
    date:            today,
    regime:          input.regime,
    confidence:      input.confidence as RegimeConfidence,
    rationale:       input.rationale,
    keyIndicators:   input.keyIndicators,
    affectedTickers: input.affectedTickers,
    createdAt:       now,
  }
}
