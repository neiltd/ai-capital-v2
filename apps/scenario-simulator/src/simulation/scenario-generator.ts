import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { Scenario, AnalysisJSON, GraphJSON } from '../types.js'

const SYSTEM_PROMPT = `You are a forward-looking technology investment strategist.
Generate scenarios using the generate_scenarios tool based on the provided macro regime, propagation signals, and dependency graph.
Ground each scenario in specific company health signals and dependency relationships — avoid generic market commentary.
For daily runs, produce exactly three scenarios of types: best, base, disruption.
For what-if runs, produce exactly one scenario of type: whatif.`

const GENERATE_SCENARIOS_TOOL: Anthropic.Tool = {
  name: 'generate_scenarios',
  description: 'Generate forward-looking scenarios based on current macro regime and propagation signals',
  input_schema: {
    type: 'object',
    properties: {
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scenarioType:     { type: 'string', enum: ['best', 'base', 'disruption', 'whatif'] },
            title:            { type: 'string', description: 'Short label, e.g. AI Acceleration Continues' },
            narrative:        { type: 'string', description: '2-3 paragraph forward-looking description' },
            timeHorizon:      { type: 'string', description: 'e.g. 3-6 months' },
            probability:      { type: 'integer', minimum: 0, maximum: 100 },
            regimeTransition: { type: ['string', 'null'], description: 'Target regime label if regime shifts, null if unchanged' },
            triggers:         { type: 'array', items: { type: 'string' }, description: '3-5 specific events that cause this scenario' },
          },
          required: ['scenarioType', 'title', 'narrative', 'timeHorizon', 'probability', 'regimeTransition', 'triggers'],
        },
      },
    },
    required: ['scenarios'],
  },
}

function formatAnalysis(analysis: AnalysisJSON, graph: GraphJSON): string {
  const { latestRegime: r, latestSignals, companySummaries } = analysis
  const signals = latestSignals.length
    ? latestSignals.map(s => `  ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}, ${s.magnitude}, ${s.sentiment}): ${s.description}`).join('\n')
    : '  None'
  const health = companySummaries.map(c => `  ${c.ticker}: ${c.healthScore}`).join('\n')
  const edges = graph.edges.slice(0, 20).map(e => `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]: ${e.description.slice(0, 100)}`).join('\n')
  return [
    `## Current Regime: ${r.regime} (${r.confidence} confidence)`,
    r.rationale,
    `Key Indicators:\n${r.keyIndicators.map(i => `  - ${i}`).join('\n')}`,
    `\n## Propagation Signals (${latestSignals.length}):\n${signals}`,
    `\n## Company Health:\n${health}`,
    `\n## Key Dependency Edges:\n${edges || '  None'}`,
  ].join('\n')
}

export async function generateScenarios(
  analysis: AnalysisJSON,
  graph: GraphJSON,
  options: { trigger?: string; runId: string; client?: Anthropic },
): Promise<Scenario[]> {
  const client  = options.client ?? new Anthropic()
  const today   = new Date().toISOString().slice(0, 10)
  const now     = new Date().toISOString()
  const context = formatAnalysis(analysis, graph)

  const userContent = options.trigger
    ? `Given this what-if trigger: "${options.trigger}"\n\nCurrent state:\n${context}`
    : `Generate three scenarios (best, base, disruption) from this current state:\n\n${context}`

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:      [GENERATE_SCENARIOS_TOOL],
    tool_choice: { type: 'tool', name: 'generate_scenarios' },
    messages:   [{ role: 'user', content: [{ type: 'text', text: userContent, cache_control: { type: 'ephemeral' } }] }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    scenarios: Array<{
      scenarioType: string; title: string; narrative: string; timeHorizon: string
      probability: number; regimeTransition: string | null; triggers: string[]
    }>
  }

  return input.scenarios.map(s => ({
    id:               randomUUID(),
    runId:            options.runId,
    date:             today,
    scenarioType:     s.scenarioType as Scenario['scenarioType'],
    title:            s.title,
    narrative:        s.narrative,
    timeHorizon:      s.timeHorizon,
    probability:      s.probability,
    regimeTransition: typeof s.regimeTransition === 'string' ? s.regimeTransition : null,
    triggers:         s.triggers,
    createdAt:        now,
  }))
}
