import Anthropic from '@anthropic-ai/sdk'
import type { ExtractionResult, RelType, Strength } from '../types.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an investment research assistant specializing in technology supply chains and competitive dynamics.
Given document excerpts about two companies, identify any dependency relationships between them.

Respond ONLY with valid JSON in this exact format:
{
  "relationships": [
    {
      "from": "TICKER_A",
      "to": "TICKER_B",
      "type": "supply_chain|customer|technology|competitive",
      "strength": "strong|moderate|weak",
      "description": "one sentence describing the relationship",
      "evidence_quote": "exact quote from the documents supporting this",
      "reasoning": "why you classified it this way"
    }
  ]
}

Relationship type definitions:
- supply_chain: from depends on to for manufacturing or supply of components/services
- customer: from is a paying customer of to
- technology: from's products run on or are built on to's technology
- competitive: from and to compete in overlapping markets

Return {"relationships": []} if no relationships are found.
Only include relationships clearly supported by the provided text.`

export async function extractRelationships(
  tickerA: string,
  companyA: string,
  tickerB: string,
  companyB: string,
  chunks: Array<{ id: string; content: string }>,
): Promise<ExtractionResult> {
  if (chunks.length === 0) return { relationships: [] }

  const chunkText = chunks
    .slice(0, 10)
    .map((c, i) => `[Excerpt ${i + 1}]\n${c.content}`)
    .join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Companies: ${tickerA} (${companyA}) and ${tickerB} (${companyB})\n\nDocument excerpts:\n${chunkText}\n\nIdentify any dependency relationships between ${tickerA} and ${tickerB} based solely on the excerpts above.`,
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  try {
    const parsed = JSON.parse(text)
    const relationships = (parsed.relationships ?? []).map((r: any) => ({
      from:          r.from          as string,
      to:            r.to            as string,
      type:          r.type          as RelType,
      strength:      r.strength      as Strength,
      description:   r.description   as string,
      evidenceQuote: r.evidence_quote as string,
      reasoning:     r.reasoning     as string,
    }))
    return { relationships }
  } catch {
    return { relationships: [] }
  }
}
