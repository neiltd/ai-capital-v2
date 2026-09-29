import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CompanyHealth, MacroRegime, PropagationSignal, GraphJSON } from '../types.js'
import { stripLoneSurrogates } from '../util/sanitize.js'

const SYSTEM_PROMPT = `You are a technology supply chain analyst.
Identify which dependency relationships between companies are currently transmitting signals,
given the current macro regime and each company's health data.

Edge type semantics:
- supply_chain: from depends on to for manufacturing/supply
- customer: from is a paying customer of to
- technology: from's products run on or are built on to's technology
- competitive: from and to compete in overlapping markets

direction semantics:
- "downstream": signal flows from source to its customers/dependents
- "upstream": signal flows back from source to its suppliers

Use the propose_propagation_signals tool. Return an empty signals array if no active propagation is occurring.`

/**
 * THE SAME TRUST BOUNDARY, CLOSED BEFORE IT COSTS A RUN.
 *
 * This stage consumes the regime the classifier produced and used exactly the same
 * pattern that failed there: an unchecked cast of tool input into
 * `PropagationSignal`. A malformed `signals` array, one bad enum or a numeric
 * `description` would have been written into analysis.json and surfaced as a
 * TypeError in whatever read it next. It is hardened now rather than after.
 *
 * `strict: true` plus `additionalProperties: false` on BOTH the root and each
 * signal, so the decoder cannot invent a key or a shape.
 *
 * evidenceQuote IS REQUIRED AND NULLABLE. Strict mode requires every property to
 * be listed in `required`, and "no supporting quote" is a real answer here, so the
 * honest encoding is `type: ['string', 'null']` rather than an optional field the
 * model may simply omit.
 */
const PROPAGATE_TOOL: Anthropic.Tool = {
  name: 'propose_propagation_signals',
  description: 'Identify which dependency relationships are currently transmitting signals',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      signals: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceTicker:  { type: 'string' },
            targetTicker:  { type: 'string' },
            signalType:    { type: 'string', enum: ['supply_chain', 'customer', 'technology', 'competitive'] },
            direction:     { type: 'string', enum: ['upstream', 'downstream'] },
            magnitude:     { type: 'string', enum: ['strong', 'moderate', 'weak'] },
            sentiment:     { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            description:   { type: 'string' },
            evidenceQuote: { type: ['string', 'null'] },
          },
          required: [
            'sourceTicker', 'targetTicker', 'signalType', 'direction', 'magnitude',
            'sentiment', 'description', 'evidenceQuote',
          ],
        },
      },
    },
    required: ['signals'],
  },
}

/** The reviewed enums, in one place so the validator and the schema cannot drift. */
const SIGNAL_TYPES = ['supply_chain', 'customer', 'technology', 'competitive'] as const
const DIRECTIONS = ['upstream', 'downstream'] as const
const MAGNITUDES = ['strong', 'moderate', 'weak'] as const
const SENTIMENTS = ['positive', 'negative', 'neutral'] as const

/**
 * FAIL CLOSED ON THE TOOL RESPONSE, field by field.
 *
 * NOT COERCED AND NOT SKIPPED. Dropping a malformed signal would publish a
 * shorter propagation list and call it the analysis; coercing one would publish a
 * guess. Either way analysis.json would look complete while being wrong, and
 * every downstream stage and the briefing would inherit that silently.
 *
 * ERRORS NAME THE FIELD, NEVER THE CONTENT. These signals quote source material
 * and name real holdings; an exception reaching launchd logs or a pipeline_runs
 * row must not carry it.
 */
export function validatedPropagationInput(raw: unknown): Array<{
  sourceTicker: string; targetTicker: string
  signalType: PropagationSignal['signalType']; direction: PropagationSignal['direction']
  magnitude: PropagationSignal['magnitude']; sentiment: PropagationSignal['sentiment']
  description: string; evidenceQuote: string | null
}> {
  const bad = (field: string, expected: string): never => {
    throw new Error(`propose_propagation_signals returned ${field} that is not ${expected}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad('a tool input', 'an object')
  }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.signals)) bad('signals', 'an array')

  return (r.signals as unknown[]).map((sig, i) => {
    const at = (field: string, expected: string): never =>
      bad(`signals[${String(i)}].${field}`, expected)
    if (typeof sig !== 'object' || sig === null || Array.isArray(sig)) {
      return bad(`signals[${String(i)}]`, 'an object') as never
    }
    const o = sig as Record<string, unknown>

    const str = (field: string): string => {
      const v = o[field]
      if (typeof v !== 'string' || v === '') at(field, 'a non-empty string')
      return v as string
    }
    const oneOf = <T extends readonly string[]>(field: string, allowed: T): T[number] => {
      const v = o[field]
      if (typeof v !== 'string' || !allowed.includes(v)) {
        at(field, `one of ${allowed.join(', ')}`)
      }
      return v as T[number]
    }
    // REQUIRED AND NULLABLE: present, and either a string or an explicit null.
    // `undefined` is a missing field, which strict mode forbids and which this
    // refuses rather than silently reading as "no quote".
    if (!Object.prototype.hasOwnProperty.call(o, 'evidenceQuote')) {
      at('evidenceQuote', 'present (string or null)')
    }
    if (o.evidenceQuote !== null && typeof o.evidenceQuote !== 'string') {
      at('evidenceQuote', 'a string or null')
    }

    return {
      sourceTicker: str('sourceTicker'),
      targetTicker: str('targetTicker'),
      signalType: oneOf('signalType', SIGNAL_TYPES),
      direction: oneOf('direction', DIRECTIONS),
      magnitude: oneOf('magnitude', MAGNITUDES),
      sentiment: oneOf('sentiment', SENTIMENTS),
      description: str('description'),
      evidenceQuote: o.evidenceQuote as string | null,
    }
  })
}

function formatContext(regime: MacroRegime, graph: GraphJSON, health: CompanyHealth[]): string {
  const healthMap = new Map(health.map(h => [h.ticker, h]))

  const edgeSummary = graph.edges
    .map(e => `${e.from} -[${e.type}, ${e.strength}]→ ${e.to}: ${e.description}`)
    .join('\n')

  const healthSummary = graph.nodes
    .map(n => {
      const h = healthMap.get(n.ticker)
      if (!h) return `${n.ticker}: no health data`
      return `${n.ticker} (${h.healthScore}): ${h.thesisSummary.slice(0, 200)}`
    })
    .join('\n')

  return [
    `## Current Macro Regime: ${regime.regime} (${regime.confidence} confidence)`,
    regime.rationale,
    `Key indicators: ${regime.keyIndicators.join('; ')}`,
    '',
    '## Dependency Graph Edges',
    edgeSummary,
    '',
    '## Company Health Snapshot',
    healthSummary,
  ].join('\n')
}

export async function analyzePropagation(
  regime: MacroRegime,
  graph: GraphJSON,
  health: CompanyHealth[],
  options: { client?: Anthropic } = {},
): Promise<PropagationSignal[]> {
  const client = options.client ?? new Anthropic()
  const today  = new Date().toISOString().slice(0, 10)
  const now    = new Date().toISOString()

  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [PROPAGATE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_propagation_signals' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: stripLoneSurrogates(formatContext(regime, graph, health)), cache_control: { type: 'ephemeral' } }],
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  return validatedPropagationInput(toolUse.input).map(s => ({
    id:            randomUUID(),
    date:          today,
    sourceTicker:  s.sourceTicker,
    targetTicker:  s.targetTicker,
    signalType:    s.signalType,
    direction:     s.direction,
    magnitude:     s.magnitude,
    sentiment:     s.sentiment,
    description:   s.description,
    evidenceQuote: s.evidenceQuote,
    createdAt:     now,
  }))
}
