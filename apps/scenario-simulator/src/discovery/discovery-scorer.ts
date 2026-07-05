import Anthropic from '@anthropic-ai/sdk'
import type { DiscoveryCandidate, ScoredCandidate } from './types.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a technology investment analyst screening stocks for portfolio fit. The investor focuses on AI infrastructure, semiconductors, and emerging tech. Score each ticker 0–100 based on: recent news signal strength, sector fit, momentum, and data availability. Be conservative — only score ≥ 70 if there is a clear, specific reason to investigate further.`

interface ScoreEntry {
  ticker: string
  score: number
  rationale: string
}

export async function scoreCandidates(
  candidates: DiscoveryCandidate[],
  macroRegime: string,
  realPortfolioTickers: string[],
  openDiscoveryTickers: string[]
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return []

  const candidateList = candidates
    .map(c => `- ${c.ticker} (${c.company}) [source: ${c.source}]${c.newsSnippet ? ` — "${c.newsSnippet}"` : ''}`)
    .join('\n')

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
        name: 'score_candidates',
        description: 'Score each discovery candidate 0–100 for investment investigation priority',
        input_schema: {
          type: 'object',
          properties: {
            scores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ticker:    { type: 'string' },
                  score:     { type: 'integer', minimum: 0, maximum: 100 },
                  rationale: { type: 'string', description: 'One sentence explaining the score' },
                },
                required: ['ticker', 'score', 'rationale'],
              },
            },
          },
          required: ['scores'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'score_candidates' },
    messages: [
      {
        role: 'user',
        content: [
          `Current macro regime: ${macroRegime}`,
          `Real portfolio tickers (already held, avoid scoring up close substitutes): ${realPortfolioTickers.join(', ') || 'none'}`,
          `Already-open discovery positions (skip re-scoring): ${openDiscoveryTickers.join(', ') || 'none'}`,
          `Candidates to score:\n${candidateList}`,
        ].join('\n\n'),
      },
    ],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return []

  const input = toolUse.input as { scores: ScoreEntry[] }
  if (!input.scores || !Array.isArray(input.scores)) return []

  // Build lookup for source/company
  const candidateMap = new Map(candidates.map(c => [c.ticker, c]))

  return input.scores
    .filter(s => s.ticker && typeof s.score === 'number')
    .map(s => {
      const candidate = candidateMap.get(s.ticker)
      return {
        ticker: s.ticker,
        company: candidate?.company ?? s.ticker,
        source: candidate?.source ?? 'companies_table' as const,
        score: Math.min(100, Math.max(0, Math.round(s.score))),
        rationale: s.rationale,
      }
    })
}
