import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CalibrationContext, TaxHarvestContext } from '../types.js'
import type { BriefingJSON } from '@common/types'
import { coerceToolArray } from '../util/sanitize.js'

const SYSTEM_PROMPT = `You extract structured data from a finished daily investment briefing.

For "actions": read the "## Today's Recommended Actions" section and output one entry per
ticker mentioned there. If a single numbered item covers multiple tickers (e.g. "K-VIETNAM
(DCA), KFINDIA-A (DCA) — Continue DCA"), split it into one entry per ticker, each sharing the
item's distilled rationale. Map the item's stated action to exactly one of: buy, hold, trim,
exit — "pause new contributions" and "continue DCA" and "tax-locked, hold to maturity" all map
to hold; "reduce" maps to trim. Do not invent tickers that are not present in the section.
Condense each rationale to 1-2 sentences — do not copy the full paragraph verbatim.

For "watchItems": read the "## Things to Watch" section and output one entry per row/item.
Classify each as bull (favorable if it happens), bear (unfavorable if it happens), or neutral
(informational/data release with no inherent direction) based on the stated "why it matters".
List every ticker explicitly named for that item; if none are named, use an empty array.`

interface RawAction {
  ticker: string
  action: 'buy' | 'hold' | 'trim' | 'exit'
  conviction: 'high' | 'medium' | 'low'
  allocationChangePct: number
  rationale: string
}

interface RawWatchItem {
  kind: 'bull' | 'bear' | 'neutral'
  trigger: string
  tickers: string[]
  why: string
}

interface ExtractionResult {
  actions: RawAction[]
  watchItems: RawWatchItem[]
}

/**
 * Extracts structured data FROM the already-written markdown, rather than
 * generating it in parallel with the prose — guarantees the JSON can never
 * disagree with what the investor actually reads, at the cost of one extra
 * cheap tool-forced call.
 */
async function extractStructuredSections(
  briefingMarkdown: string,
  client: Anthropic,
): Promise<ExtractionResult> {
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    // 8192 (raised from 4096 on the Sonnet 5 swap): the prose briefing this
    // extracts from is now longer/more verbose, so it can carry more actions +
    // watch items. Paired with the loud stop_reason guard below.
    max_tokens: 8192,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [
      {
        name: 'extract_briefing_sections',
        description: "Extract today's recommended actions and things-to-watch triggers from the finished briefing",
        input_schema: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ticker: { type: 'string' },
                  action: { type: 'string', enum: ['buy', 'hold', 'trim', 'exit'] },
                  conviction: { type: 'string', enum: ['high', 'medium', 'low'] },
                  allocationChangePct: {
                    type: 'number',
                    description: 'Best-effort estimate of the recommended allocation change (negative for trim/exit); 0 if unspecified',
                  },
                  rationale: { type: 'string', description: '1-2 sentence condensed rationale' },
                },
                required: ['ticker', 'action', 'conviction', 'allocationChangePct', 'rationale'],
              },
            },
            watchItems: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['bull', 'bear', 'neutral'] },
                  trigger: { type: 'string', description: 'The item/trigger, condensed to one line' },
                  tickers: { type: 'array', items: { type: 'string' } },
                  why: { type: 'string', description: '1 sentence condensed from "why it matters"' },
                },
                required: ['kind', 'trigger', 'tickers', 'why'],
              },
            },
          },
          required: ['actions', 'watchItems'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_briefing_sections' },
    messages: [{ role: 'user', content: briefingMarkdown }],
  })

  // Fail loudly on truncation rather than silently returning empty actions —
  // this JSON feeds the dashboard and trade alerts, so a silent truncation
  // would let the structured actions diverge from the prose briefing unnoticed
  // (the prose side is already guarded in briefing-agent.ts).
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `briefing-extractor hit max_tokens (${response.usage.output_tokens} output tokens) — extracted actions/watchItems truncated; would silently diverge from the prose briefing. Raise max_tokens.`,
    )
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return { actions: [], watchItems: [] }
  const raw = toolUse.input as { actions?: unknown; watchItems?: unknown }
  // Sonnet 5 may return these array fields as JSON strings — coerce (see the
  // 2026-08-06 scenario-generator fix).
  const actions    = (coerceToolArray(raw.actions, 'actions') ?? []) as ExtractionResult['actions']
  const watchItems = (coerceToolArray(raw.watchItems, 'watchItems') ?? []) as ExtractionResult['watchItems']
  return { actions, watchItems }
}

export async function buildBriefingJson(params: {
  date: string
  briefingMarkdown: string
  regime: { regime: string; confidence: string; rationale: string; keyIndicators: string[] }
  scenarios: BriefingJSON['scenarios']
  calibration?: CalibrationContext | null
  taxHarvest?: TaxHarvestContext | null
  client?: Anthropic
}): Promise<BriefingJSON> {
  const client = params.client ?? new Anthropic()
  const { actions: raw, watchItems } = await extractStructuredSections(params.briefingMarkdown, client)

  const convictionDowngraded = params.calibration?.calibrationInverted ?? false
  const calibrationNote = params.calibration
    ? params.calibration.calibrationInverted
      ? `Calibration inverted — high-conviction calls are ${(params.calibration.highConvictionPenalty * 100).toFixed(1)}pp worse than medium; today's high-conviction labels were downgraded one level.`
      : 'Conviction labels are correctly calibrated (high outperforms medium).'
    : null

  const recommendedActions: BriefingJSON['recommendedActions'] = raw.map((a) => {
    const harvest = params.taxHarvest?.harvestOpportunities.find((o) => o.ticker === a.ticker)
    const wash = params.taxHarvest?.washSaleAlerts.find((w) => w.ticker === a.ticker)
    return {
      id: randomUUID(),
      ticker: a.ticker,
      action: a.action,
      conviction: a.conviction,
      allocationChangePct: a.allocationChangePct,
      rationale: a.rationale,
      convictionDowngraded,
      harvestableUsd: harvest?.harvestable ? Math.abs(harvest.unrealizedLossUSD) : null,
      washSaleNote: wash ? `do not rebuy before ${wash.doNotRebuyBefore} (${wash.daysRemaining}d remaining)` : null,
    }
  })

  return {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    date: params.date,
    regime: params.regime,
    calibrationNote,
    recommendedActions,
    scenarios: params.scenarios,
    watchItems,
  }
}
