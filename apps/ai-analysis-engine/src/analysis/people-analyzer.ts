// src/analysis/people-analyzer.ts
//
// Extracts executive / key-people events (role changes, hires, statements,
// large insider trades) from recent ingested documents for portfolio tickers.
//
// Uses Claude Haiku for cheap, fast structured extraction. Tool-use forces a
// JSON shape so downstream consumers don't have to parse free text.
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { createLanceStore, type LanceStore } from '@common/db'
import { join } from 'path'

const DEFAULT_LANCE_PATH = join(process.cwd(), '../capital-intelligence-ingestion/data/lancedb')

export type PeopleEventType =
  | 'role_change'        // CEO/exec hire or departure
  | 'key_hire'           // notable hire from a competitor
  | 'public_statement'   // material public statement by an executive
  | 'insider_trade'      // share purchase/sale by insider
  | 'other'

export interface PeopleEvent {
  id:            string
  ticker:        string
  company:       string
  personName:    string
  personRole:    string         // e.g. "CEO", "CCO", "President of AI Research"
  eventType:     PeopleEventType
  headline:      string         // 1-line plain-English summary
  detail:        string         // 2-3 sentence context with magnitude / impact
  publishedDate: string         // ISO date of source document
  source:        string         // source type from ingestion (news, sec_filing, ...)
  url:           string | null
  evidenceQuote: string | null
  impact:        'high' | 'medium' | 'low'
  createdAt:     string
}

interface RawChunkRow {
  id:            string
  ticker:        string
  company:       string
  source:        string
  docType:       string
  publishedDate: string
  url:           string
  content:       string
}

/** Pull recent chunks (last `days` days) for a ticker via the unified vector store. */
async function fetchRecentChunks(
  vectorStore: LanceStore,
  ticker: string,
  days: number,
  limit: number,
): Promise<RawChunkRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  // filterByTicker returns ALL chunks for the ticker; date-filter in JS, then cap.
  // (PG backend: SELECT *; LanceDB backend: .query().where().toArray())
  const chunks = await vectorStore.filterByTicker(ticker)

  const filtered: RawChunkRow[] = []
  for (const c of chunks) {
    let pub: Date | null = null
    try { pub = new Date(c.publishedDate) } catch { /* skip */ }
    if (!pub || isNaN(pub.getTime())) continue
    if (pub < cutoff) continue
    filtered.push({
      id:            c.id,
      ticker:        c.ticker,
      company:       c.company,
      source:        c.source,
      docType:       c.docType,
      publishedDate: c.publishedDate,
      url:           c.url ?? '',
      content:       c.content ?? '',
    })
  }

  // Sort newest first, cap
  filtered.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate))
  return filtered.slice(0, limit)
}

const EXTRACT_SYSTEM = `You scan a single news/filing excerpt about ONE company and extract any KEY PEOPLE EVENT it describes.

A "key people event" means one of:
- role_change: A CEO, CFO, CTO, CISO, COO, President, board chair, or other named C-suite/SVP-level executive joins, leaves, is hired, is fired, is promoted, or steps down.
- key_hire: A high-profile individual (recognizable name in the industry) joins, especially if from a competitor.
- public_statement: A named executive of the company makes a material public statement that could move the stock or signal strategy (earnings call quote, product strategy declaration, layoff announcement, M&A signal, regulatory stance).
- insider_trade: A named insider buys or sells shares, with disclosed dollar value of at least $500,000 USD (or equivalent).
- other: Something that clearly affects perception of company leadership but doesn't fit above.

If the excerpt does NOT contain a key people event, call the tool with hasEvent=false. Do not invent details.
Be strict: a generic mention of "CEO" without a name is NOT enough. The person must be named.`

const EXTRACT_TOOL = {
  name: 'record_people_event',
  description: 'Record whether the excerpt contains a key-people event and, if so, the structured details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      hasEvent: { type: 'boolean', description: 'true if the excerpt contains a key-people event' },
      personName: { type: 'string', description: 'Full name of the person, or empty string' },
      personRole: { type: 'string', description: 'Role/title at the company, e.g. "CEO", "CCO", "Head of AI Research"' },
      eventType: {
        type: 'string',
        enum: ['role_change', 'key_hire', 'public_statement', 'insider_trade', 'other'],
      },
      headline: { type: 'string', description: 'One-line plain-English summary, under 120 chars' },
      detail: { type: 'string', description: '2-3 sentence context. Include dollar amount for insider trades.' },
      evidenceQuote: { type: 'string', description: 'A short quote (under 200 chars) from the excerpt that supports the extraction, or empty string' },
      impact: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = likely market-moving / strategy-defining; medium = noteworthy; low = minor' },
    },
    required: ['hasEvent', 'personName', 'personRole', 'eventType', 'headline', 'detail', 'evidenceQuote', 'impact'],
  },
}

interface ExtractedShape {
  hasEvent:      boolean
  personName:    string
  personRole:    string
  eventType:     PeopleEventType
  headline:      string
  detail:        string
  evidenceQuote: string
  impact:        'high' | 'medium' | 'low'
}

async function extractFromChunk(
  haiku: Anthropic,
  chunk: RawChunkRow,
): Promise<ExtractedShape | null> {
  // Trim aggressively — we only need surface context
  const excerpt = chunk.content.slice(0, 2000)
  try {
    const resp = await haiku.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: EXTRACT_SYSTEM,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'record_people_event' },
      messages: [{
        role: 'user',
        content: `Company: ${chunk.company} (${chunk.ticker})\nSource: ${chunk.source} / ${chunk.docType}\nDate: ${chunk.publishedDate}\n\nExcerpt:\n${excerpt}`,
      }],
    })
    const toolUse = resp.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') return null
    const input = toolUse.input as Partial<ExtractedShape>
    if (!input.hasEvent) return null
    return {
      hasEvent:      true,
      personName:    String(input.personName ?? '').trim(),
      personRole:    String(input.personRole ?? '').trim(),
      eventType:     (input.eventType ?? 'other') as PeopleEventType,
      headline:      String(input.headline ?? '').trim(),
      detail:        String(input.detail ?? '').trim(),
      evidenceQuote: String(input.evidenceQuote ?? '').trim(),
      impact:        (input.impact ?? 'medium') as 'high' | 'medium' | 'low',
    }
  } catch (err) {
    console.warn(`  [people] extraction failed for ${chunk.ticker} chunk ${chunk.id}:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** De-duplicate events that describe the same person+event-type for the same ticker. */
function dedupe(events: PeopleEvent[]): PeopleEvent[] {
  const seen = new Set<string>()
  const out: PeopleEvent[] = []
  for (const e of events) {
    const key = `${e.ticker}|${e.personName.toLowerCase()}|${e.eventType}|${e.headline.toLowerCase().slice(0, 60)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

export interface AnalyzePeopleOptions {
  /** Portfolio tickers to extract people events for. */
  portfolioTickers: string[]
  /** Day window — defaults to 7. */
  days?:            number
  /** Max chunks scanned per ticker — defaults to 12 (LLM cost control). */
  maxChunksPerTicker?: number
  lanceDbPath?:     string
}

export async function analyzePeople(
  options: AnalyzePeopleOptions,
): Promise<PeopleEvent[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('  [people] ANTHROPIC_API_KEY not set — skipping people extraction')
    return []
  }
  if (options.portfolioTickers.length === 0) return []

  const days               = options.days ?? 7
  const maxChunksPerTicker = options.maxChunksPerTicker ?? 12
  const lanceDbPath        = options.lanceDbPath ?? DEFAULT_LANCE_PATH

  let vectorStore: LanceStore
  try {
    vectorStore = await createLanceStore(lanceDbPath)
  } catch (err) {
    console.warn(`  [people] vector store unavailable at ${lanceDbPath}:`, err instanceof Error ? err.message : err)
    return []
  }

  const haiku = new Anthropic({ apiKey })
  const events: PeopleEvent[] = []
  const now = new Date().toISOString()

  let chunksScanned = 0
  for (const ticker of options.portfolioTickers) {
    let chunks: RawChunkRow[] = []
    try {
      chunks = await fetchRecentChunks(vectorStore, ticker, days, maxChunksPerTicker)
    } catch (err) {
      console.warn(`  [people] LanceDB query failed for ${ticker}:`, err instanceof Error ? err.message : err)
      continue
    }
    if (chunks.length === 0) continue

    for (const chunk of chunks) {
      chunksScanned++
      const extracted = await extractFromChunk(haiku, chunk)
      if (!extracted || !extracted.hasEvent || !extracted.personName) continue

      events.push({
        id:            randomUUID(),
        ticker:        chunk.ticker,
        company:       chunk.company,
        personName:    extracted.personName,
        personRole:    extracted.personRole,
        eventType:     extracted.eventType,
        headline:      extracted.headline,
        detail:        extracted.detail,
        publishedDate: chunk.publishedDate,
        source:        chunk.source,
        url:           chunk.url || null,
        evidenceQuote: extracted.evidenceQuote || null,
        impact:        extracted.impact,
        createdAt:     now,
      })
    }
  }

  // vectorStore.close() is a no-op for the pgvector backend (shared pool) and
  // GCs the LanceDB connection for the local backend; either way, just call it.
  vectorStore.close()

  const deduped = dedupe(events)
  // Sort: high impact first, then by date desc
  const impactRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
  deduped.sort((a, b) => {
    const ai = impactRank[a.impact] ?? 3
    const bi = impactRank[b.impact] ?? 3
    if (ai !== bi) return ai - bi
    return b.publishedDate.localeCompare(a.publishedDate)
  })

  console.log(`  [people] scanned ${chunksScanned} chunks across ${options.portfolioTickers.length} tickers → ${deduped.length} event(s)`)
  return deduped
}
