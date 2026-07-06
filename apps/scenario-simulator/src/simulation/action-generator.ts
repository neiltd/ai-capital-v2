import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { Scenario, Position, PortfolioAction } from '../types.js'

const SYSTEM_PROMPT = `You are a portfolio manager making position-aware recommendations.
Generate portfolio actions using the generate_portfolio_actions tool.
For each held position under each scenario, recommend: buy, hold, trim, or exit.
allocationChangePct MUST be consistent with action: buy → positive integer, hold → 0, trim → negative integer, exit → -100.
Base rationale on scenario-specific evidence, not generic advice.`

const GENERATE_ACTIONS_TOOL: Anthropic.Tool = {
  name: 'generate_portfolio_actions',
  description: 'Generate position-aware portfolio actions for each held ticker under each scenario',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scenarioType:        { type: 'string', description: 'Must be exactly the scenarioType value shown in the scenario block (e.g. "best", "base", "disruption")' },
            ticker:              { type: 'string' },
            action:              { type: 'string', enum: ['buy', 'hold', 'trim', 'exit'] },
            conviction:          { type: 'string', enum: ['high', 'medium', 'low'] },
            allocationChangePct: { type: 'integer', description: '+15 = add 15%, -30 = trim 30%, 0 = hold, -100 = exit' },
            rationale:           { type: 'string', description: '1-2 sentences referencing scenario-specific evidence' },
          },
          required: ['scenarioType', 'ticker', 'action', 'conviction', 'allocationChangePct', 'rationale'],
        },
      },
    },
    required: ['actions'],
  },
}

function formatScenarios(scenarios: Scenario[]): string {
  return scenarios.map(s =>
    `## ${s.title} (${s.probability}%, ${s.timeHorizon})\nscenarioType: "${s.scenarioType}"\n${s.narrative.slice(0, 400)}\nTriggers: ${s.triggers.join('; ')}\nRegime → ${s.regimeTransition ?? 'unchanged'}`
  ).join('\n\n')
}

// Values are in each position's native currency (currentValue is shares *
// current_price, never FX-converted — see scenario-simulator's portfolio-store).
// Mislabeling THB amounts with "$" made AOT.BK-style positions look ~33x
// larger than they are to the model. Label with the real currency and add a
// USD-equivalent for THB positions so cross-position size comparisons are sane.
function formatPositions(positions: Position[], usdThb: number | null): string {
  return positions.map(p => {
    const usdNote = p.currency === 'THB' && usdThb
      ? ` (~$${(p.currentValue / usdThb).toFixed(2)} USD)`
      : ''
    return `  ${p.ticker}: ${p.shares} shares @ avg ${p.currency} ${p.avgCost.toFixed(2)} | current ${p.currency} ${p.currentPrice.toFixed(2)} | value ${p.currency} ${p.currentValue.toFixed(2)}${usdNote} | P&L ${p.unrealizedPnl >= 0 ? '+' : ''}${p.currency} ${p.unrealizedPnl.toFixed(2)}`
  }).join('\n')
}

export async function generateActions(
  scenarios: Scenario[],
  positions: Position[],
  options: { runId: string; client?: Anthropic; usdThb?: number | null },
): Promise<PortfolioAction[]> {
  const client = options.client ?? new Anthropic()
  const now    = new Date().toISOString()

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8192,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools:      [GENERATE_ACTIONS_TOOL],
    tool_choice: { type: 'tool', name: 'generate_portfolio_actions' },
    messages: [{
      role:    'user',
      content: [{ type: 'text', text: `Scenarios:\n${formatScenarios(scenarios)}\n\nCurrent Portfolio:\n${formatPositions(positions, options.usdThb ?? null)}`, cache_control: { type: 'ephemeral' } }],
    }],
  })

  const toolUse = message.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Expected tool_use response from Claude')
  }

  const input = toolUse.input as {
    actions?: Array<{
      scenarioType: string; ticker: string; action: string; conviction: string
      allocationChangePct: number; rationale: string
    }>
  }

  if (!input.actions) {
    throw new Error(`Claude tool response missing 'actions' field. stop_reason: ${message.stop_reason}. Input keys: ${Object.keys(input).join(', ')}`)
  }

  const validActions    = new Set(['buy', 'hold', 'trim', 'exit'])
  const validConvictions = new Set(['high', 'medium', 'low'])

  const scenarioMap = new Map<string, string>(scenarios.map(s => [s.scenarioType, s.id]))

  return input.actions.map(a => ({
    id:                  randomUUID(),
    runId:               options.runId,
    scenarioId:          (() => {
      const id = scenarioMap.get(a.scenarioType)
      if (!id) throw new Error(`Unknown scenarioType from Claude: ${a.scenarioType}`)
      return id
    })(),
    ticker:              a.ticker,
    action:              validActions.has(a.action) ? a.action as PortfolioAction['action'] : (() => { throw new Error(`Invalid action from Claude: ${a.action}`) })(),
    conviction:          validConvictions.has(a.conviction) ? a.conviction as PortfolioAction['conviction'] : (() => { throw new Error(`Invalid conviction from Claude: ${a.conviction}`) })(),
    allocationChangePct: a.allocationChangePct,
    rationale:           a.rationale,
    createdAt:           now,
  }))
}
