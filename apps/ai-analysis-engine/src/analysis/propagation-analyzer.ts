import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { CompanyHealth, MacroRegime, PropagationSignal, GraphJSON } from '../types.js'

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

const PROPAGATE_TOOL: Anthropic.Tool = {
  name: 'propose_propagation_signals',
  description: 'Identify which dependency relationships are currently transmitting signals',
  input_schema: {
    type: 'object',
    properties: {
      signals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceTicker:  { type: 'string' },
            targetTicker:  { type: 'string' },
            signalType:    { type: 'string', enum: ['supply_chain', 'customer', 'technology', 'competitive'] },
            direction:     { type: 'string', enum: ['upstream', 'downstream'] },
            magnitude:     { type: 'string', enum: ['strong', 'moderate', 'weak'] },
            sentiment:     { type: 'string', enum: ['positive', 'negative', 'neutral'] },
            description:   { type: 'string' },
            evidenceQuote: { type: 'string' },
          },
          required: ['sourceTicker', 'targetTicker', 'signalType', 'direction', 'magnitude', 'sentiment', 'description'],
        },
      },
    },
    required: ['signals'],
  },
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
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [PROPAGATE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_propagation_signals' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: formatContext(regime, graph, health), cache_control: { type: 'ephemeral' } }],
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as { signals: Array<Record<string, unknown>> }

  return (input.signals ?? []).map(s => ({
    id:            randomUUID(),
    date:          today,
    sourceTicker:  s.sourceTicker as string,
    targetTicker:  s.targetTicker as string,
    signalType:    s.signalType as PropagationSignal['signalType'],
    direction:     s.direction as PropagationSignal['direction'],
    magnitude:     s.magnitude as PropagationSignal['magnitude'],
    sentiment:     s.sentiment as PropagationSignal['sentiment'],
    description:   s.description as string,
    evidenceQuote: (s.evidenceQuote as string | undefined) ?? null,
    createdAt:     now,
  }))
}
