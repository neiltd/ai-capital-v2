import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { DiscoveryScenario, DiscoveryAction, ScoredCandidate } from './types.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a forward-looking technology investment strategist. Your role is to generate scenario analysis for potential portfolio additions. Ground your analysis in the current macro regime and the specific signals around the ticker. Be precise about probabilities (best + base + disruption should sum to roughly 100%). Generate exactly 3 scenarios: best, base, and disruption.`

interface RawScenario {
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  narrative: string
  timeHorizon: string
  probability: number
  regimeTransition: string | null
  triggers: string[]
}

interface RawAction {
  recommendation: 'buy' | 'watch'
  conviction: 'high' | 'medium' | 'low'
  rationale: string
}

export interface AnalysisResult {
  scenarios: DiscoveryScenario[]
  action: DiscoveryAction
}

export async function analyzeCandidate(
  candidate: ScoredCandidate,
  currentPrice: number,
  macroRegime: string,
  macroSignals: string
): Promise<AnalysisResult | null> {
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'analyze_discovery_ticker',
        description: 'Generate 3 scenarios and a buy/watch recommendation for a discovery candidate',
        input_schema: {
          type: 'object',
          properties: {
            scenarios: {
              type: 'array',
              description: 'Exactly 3 scenarios: best, base, disruption',
              items: {
                type: 'object',
                properties: {
                  scenarioType:     { type: 'string', enum: ['best', 'base', 'disruption'] },
                  title:            { type: 'string' },
                  narrative:        { type: 'string', description: '2-3 paragraph forward-looking description' },
                  timeHorizon:      { type: 'string' },
                  probability:      { type: 'integer', minimum: 0, maximum: 100 },
                  regimeTransition: { type: ['string', 'null'] },
                  triggers:         { type: 'array', items: { type: 'string' } },
                },
                required: ['scenarioType', 'title', 'narrative', 'timeHorizon', 'probability', 'regimeTransition', 'triggers'],
              },
            },
            action: {
              type: 'object',
              properties: {
                recommendation: { type: 'string', enum: ['buy', 'watch'] },
                conviction:     { type: 'string', enum: ['high', 'medium', 'low'] },
                rationale:      { type: 'string', description: '1-2 sentences explaining the recommendation' },
              },
              required: ['recommendation', 'conviction', 'rationale'],
            },
          },
          required: ['scenarios', 'action'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'analyze_discovery_ticker' },
    messages: [
      {
        role: 'user',
        content: [
          `Ticker: ${candidate.ticker} — ${candidate.company}`,
          `Light filter score: ${candidate.score}/100`,
          `Light filter rationale: ${candidate.rationale}`,
          `Current price: $${currentPrice.toFixed(2)}`,
          `Current macro regime: ${macroRegime}`,
          `Key macro signals:\n${macroSignals}`,
        ].join('\n'),
      },
    ],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return null

  const input = toolUse.input as { scenarios: RawScenario[]; action: RawAction }
  if (!input.scenarios || !input.action) return null
  if (input.scenarios.length !== 3) return null

  const scenarios: DiscoveryScenario[] = input.scenarios.map(s => ({
    id: randomUUID(),
    ticker: candidate.ticker,
    date: today,
    scenarioType: s.scenarioType,
    title: s.title,
    narrative: s.narrative,
    timeHorizon: s.timeHorizon,
    probability: s.probability,
    regimeTransition: s.regimeTransition ?? null,
    triggers: s.triggers ?? [],
    createdAt: now,
  }))

  const action: DiscoveryAction = {
    ticker: candidate.ticker,
    recommendation: input.action.recommendation,
    conviction: input.action.conviction,
    rationale: input.action.rationale,
  }

  return { scenarios, action }
}
