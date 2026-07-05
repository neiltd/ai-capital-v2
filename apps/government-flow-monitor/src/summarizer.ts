import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { BudgetSignal } from './types.js'
import type { RawBill } from './fetchers/budget-fetcher.js'

type BillCache = Record<string, BudgetSignal>

export function buildNarrativeKey(billNumber: string, date: string): string {
  return `${billNumber}:${date}`
}

export function mergeCacheEntry(key: string, cache: BillCache): BudgetSignal | null {
  return cache[key] ?? null
}

function loadCache(cachePath: string): BillCache {
  try {
    if (!existsSync(cachePath)) return {}
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch { return {} }
}

function saveCache(cachePath: string, cache: BillCache): void {
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache, null, 2))
}

export async function summarizeBill(
  bill: RawBill,
  watchlistTickers: string[],
  client: Anthropic,
): Promise<BudgetSignal> {
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    tools: [{
      name: 'extract_bill_signal',
      description: 'Extract structured investment signals from a congressional bill',
      input_schema: {
        type: 'object' as const,
        properties: {
          summary:         { type: 'string', description: '2-3 sentence plain-English summary' },
          relevantTickers: { type: 'array', items: { type: 'string' }, description: 'Watchlist tickers that benefit' },
          totalFunding:    { type: 'number', description: 'Total funding amount in dollars, or null' },
          keyProvisions:   { type: 'array', items: { type: 'string' }, description: '2-4 key provisions' },
        },
        required: ['summary', 'relevantTickers', 'keyProvisions'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_bill_signal' },
    system: 'You are a government spending analyst. Extract structured investment signals from congressional bill information.',
    messages: [{
      role: 'user',
      content: `Bill: ${bill.number} — ${bill.title}\nStatus: ${bill.status} as of ${bill.date}\nWatchlist companies: ${watchlistTickers.join(', ')}\n\nExtract: (1) 2-3 sentence plain-English summary, (2) which watchlist tickers benefit, (3) total funding if mentioned, (4) 2-4 key provisions.`,
    }],
  })

  const toolBlock = res.content.find(b => b.type === 'tool_use')
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    return {
      billNumber: bill.number, title: bill.title, congress: bill.congress,
      status: bill.status, date: bill.date,
      summary: bill.title, relevantTickers: [], totalFunding: null, keyProvisions: [],
    }
  }

  const input = toolBlock.input as any
  return {
    billNumber: bill.number, title: bill.title, congress: bill.congress,
    status: bill.status, date: bill.date,
    summary: input.summary ?? bill.title,
    relevantTickers: input.relevantTickers ?? [],
    totalFunding: input.totalFunding ?? null,
    keyProvisions: input.keyProvisions ?? [],
  }
}

export async function summarizeBills(
  bills: RawBill[],
  watchlistTickers: string[],
  cachePath: string,
): Promise<BudgetSignal[]> {
  if (bills.length === 0) return []

  const client = new Anthropic()
  const cache = loadCache(cachePath)
  const results: BudgetSignal[] = []
  let cacheUpdated = false

  for (const bill of bills) {
    const key = buildNarrativeKey(bill.number, bill.date)
    const cached = mergeCacheEntry(key, cache)
    if (cached) {
      results.push(cached)
      continue
    }
    try {
      const signal = await summarizeBill(bill, watchlistTickers, client)
      cache[key] = signal
      cacheUpdated = true
      results.push(signal)
    } catch (e) {
      console.error(`[govflow] Failed to summarize ${bill.number}:`, e)
    }
  }

  if (cacheUpdated) saveCache(cachePath, cache)
  return results
}
