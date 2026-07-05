import Anthropic from '@anthropic-ai/sdk'
import type { DiscoveryCandidate } from './types.js'
import type { NewsRow } from './ingestion-reader.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `Extract US-listed stock ticker symbols mentioned in the provided news documents. Only include tickers that appear to be publicly traded US equities with clear investment relevance. Do not include tickers already in the provided exclusion list.`

interface ExtractedMention {
  ticker: string
  company: string
  snippet: string
}

export async function extractTickers(
  news: NewsRow[],
  knownTickers: Set<string>
): Promise<DiscoveryCandidate[]> {
  if (news.length === 0) return []

  const newsText = news
    .map(n => `[${n.ticker} — ${n.company}] ${n.content}`)
    .join('\n\n')

  const exclusionList = Array.from(knownTickers).join(', ')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'extract_tickers',
        description: 'Return all US-listed stock tickers mentioned in the news with a short excerpt',
        input_schema: {
          type: 'object',
          properties: {
            mentions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ticker:  { type: 'string' },
                  company: { type: 'string' },
                  snippet: { type: 'string', description: '1-2 sentence excerpt mentioning this ticker' },
                },
                required: ['ticker', 'company', 'snippet'],
              },
            },
          },
          required: ['mentions'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_tickers' },
    messages: [
      {
        role: 'user',
        content: `Exclusion list (already tracked, skip these): ${exclusionList || 'none'}\n\nNews documents:\n${newsText}`,
      },
    ],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return []

  const input = toolUse.input as { mentions: ExtractedMention[] }
  if (!input.mentions || !Array.isArray(input.mentions)) return []

  return input.mentions
    .filter(m => m.ticker && m.company && !knownTickers.has(m.ticker))
    .map(m => ({
      ticker: m.ticker.toUpperCase(),
      company: m.company,
      source: 'news_mention' as const,
      newsSnippet: m.snippet,
    }))
}
