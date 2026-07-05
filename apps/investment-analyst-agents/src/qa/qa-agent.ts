import Anthropic from '@anthropic-ai/sdk'
import type { SimulationJSON, GraphJSON } from '../types.js'

const SYSTEM_PROMPT = `You are an investment analyst assistant.
Answer questions grounded strictly in the provided briefing and data.
Cite specific evidence — tickers, signals, graph edges, scenario narratives.
Do not invent tickers, edges, or relationships not present in the data.
If a question requires real-time price data not available in context, say so explicitly.`

function formatQAContext(
  briefing:   string,
  simulation: SimulationJSON,
  graph:      GraphJSON,
  profile:    string,
): string {
  const portfolio = simulation.portfolio.map(p =>
    `  ${p.ticker}: ${p.shares} shares @ $${p.avgCost.toFixed(2)} | current $${p.currentPrice.toFixed(2)}`
  ).join('\n') || '  None'

  const edges = graph.edges.map(e =>
    `  ${e.from} → ${e.to} [${e.type}, ${e.strength}]: ${e.description.slice(0, 100)}`
  ).join('\n') || '  None'

  return [
    profile ? `## Investor Profile\n${profile}` : '',
    `## Today's Briefing\n${briefing}`,
    `## Portfolio Positions\n${portfolio}`,
    `## Dependency Graph Edges\n${edges}`,
  ].filter(Boolean).join('\n\n')
}

export async function askQuestion(
  question:  string,
  briefing:  string,
  context:   { simulation: SimulationJSON; graph: GraphJSON; profile: string },
  history:   Array<{ role: 'user' | 'assistant'; content: string }>,
  options:   { client?: Anthropic } = {},
): Promise<string> {
  const client = options.client ?? new Anthropic()

  const systemContext = formatQAContext(briefing, context.simulation, context.graph, context.profile)

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user',      content: `Context:\n${systemContext}` },
    { role: 'assistant', content: 'Understood. I have read the briefing, portfolio positions, and dependency graph. Ask your questions.' },
    ...history,
    { role: 'user',      content: question },
  ]

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  })

  const block = message.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Expected text response from Claude')
  return block.text
}
