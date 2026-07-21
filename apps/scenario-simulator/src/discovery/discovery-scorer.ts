import Anthropic from '@anthropic-ai/sdk'
import type { DiscoveryCandidate, ScoredCandidate } from './types.js'

const client = new Anthropic()

// No sector bias here on purpose — a prompt that names favored themes directly
// produces a one-theme paper book (verified: 15 of 16 positions in the
// 2026-06 cohort were "AI infrastructure" under the old wording, and that
// concentration was the proposal's own root-cause finding for why the cohort
// measured sector beta instead of stock-picking skill). Diversification is
// scored explicitly via the theme-weight context below, not baked into the
// system prompt's framing of what's interesting.
const SYSTEM_PROMPT = `You are an investment analyst screening stocks across all sectors for portfolio fit. Score each ticker 0–100 based on: recent news signal strength, momentum, data availability, and — critically — marginal diversification value given the theme-weight context you're given. A candidate in an already-crowded theme should score lower than an equally strong candidate in an underrepresented one, all else equal. Be conservative — only score ≥ 70 if there is a clear, specific reason to investigate further.`

interface ScoreEntry {
  ticker: string
  score: number
  rationale: string
}

export async function scoreCandidates(
  candidates: DiscoveryCandidate[],
  macroRegime: string,
  realPortfolioTickers: string[],
  openDiscoveryTickers: string[],
  themeContext: string = '',
  calibrationContext: string = '',
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return []

  const candidateList = candidates
    .map(c => `- ${c.ticker} (${c.company}) [source: ${c.source}]${c.newsSnippet ? ` — "${c.newsSnippet}"` : ''}`)
    .join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    // 4096 was silently truncating the tool call for ~90+ weekly candidates
    // (stop_reason: max_tokens mid-JSON → input.scores fails the array check
    // → scoreCandidates returns [] → 0 positions ever opened, every week
    // since launch). 8192 gives ~180-candidate headroom at the observed
    // ~45 tokens/candidate rate.
    max_tokens: 8192,
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
          themeContext || 'Theme-weight context: unavailable this run — score on fundamentals alone.',
          calibrationContext,
          `Candidates to score:\n${candidateList}`,
        ].filter(Boolean).join('\n\n'),
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
    // Drop any ticker Claude returns that wasn't in the candidate set instead
    // of fabricating a fallback candidate for it — a hallucinated ticker that
    // happens to resolve on Yahoo could otherwise get bought.
    .filter(s => s.ticker && typeof s.score === 'number' && candidateMap.has(s.ticker))
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
