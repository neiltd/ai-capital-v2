#!/usr/bin/env node
// LLM-derived supply-chain dependencies for the watchlist.
//
// Usage:
//   pnpm deps --dry-run                  # show prompt + parsed output for first 3 tickers
//   pnpm deps --ticker NVDA              # one specific ticker
//   pnpm deps --limit 10                 # first 10 tickers only
//   pnpm deps                            # full watchlist (116 tickers, ~$1 in Haiku)
//
// Re-running is idempotent per ticker: existing rows with source='llm' for the
// same ticker are deleted before the new ones are inserted. Manual overrides
// (source='manual') are preserved.

import Anthropic from '@anthropic-ai/sdk'
import { config as loadEnv } from 'dotenv'

import { createTradeStore }                    from '../store/trade-store.js'
import { readWatchlist }                       from '../data/watchlist.js'
import { COMMODITY_CATEGORIES, type CommodityCategory, type TickerDependency } from '../types.js'
import { CHOKEPOINTS }                         from '../data/chokepoints.js'
import { getPool }                             from '@common/db'

loadEnv()

const VALID_COMMODITIES = new Set<string>(COMMODITY_CATEGORIES)
const VALID_CHOKEPOINTS = new Set<string>(CHOKEPOINTS.map(c => c.id))
const PROMPT_MODEL      = 'claude-haiku-4-5-20251001'
const MAX_TOKENS        = 1024

const SYSTEM_PROMPT = `You are a supply-chain analyst. For any given public company,
list its 3-5 most critical international supply-chain dependencies — the inputs
or markets whose disruption would materially hurt the company's revenue or
margins within 6 months.

Output a single JSON array, no commentary, no markdown fences. Each element:
{
  "country_iso3":  "USA" | "CHN" | "TWN" | ... ,           // ISO 3166-1 alpha-3
  "commodity":     "energy" | "semis" | "pharma" | "food" | "industrial_metals" |
                   "vehicles" | "agriculture" | "chemicals" | "textiles" | "other",
  "chokepoint_id": "hormuz" | "suez" | "malacca" | "panama" | "bab_el_mandeb" |
                   "bosphorus" | "cape_of_good_hope" | "drake" | "taiwan_strait" |
                   "english_channel" | null,                // null if no maritime chokepoint
  "criticality":   1 | 2 | 3 | 4 | 5,                       // 1=lethal, 5=mild
  "rationale":     "one sentence explaining the dependency"
}

Hard rules:
- Output 3 to 5 entries. Never fewer than 3.
- country_iso3 must be a valid ISO3 code.
- commodity must be one of the 10 listed values.
- chokepoint_id is null unless the dependency clearly rides a specific maritime route.
- No prose outside the JSON array.`

interface ParsedDep {
  country_iso3:  string
  commodity:     string
  chokepoint_id: string | null
  criticality:   number
  rationale:     string
}

function extractJsonArray(text: string): ParsedDep[] {
  // Be tolerant: trim code fences, find the first '[' to last ']'.
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const start = stripped.indexOf('[')
  const end   = stripped.lastIndexOf(']')
  if (start < 0 || end < 0) throw new Error('no JSON array found in response')
  return JSON.parse(stripped.slice(start, end + 1)) as ParsedDep[]
}

function validateDep(d: unknown, ticker: string, idx: number): TickerDependency['source'] extends never ? never : ParsedDep {
  const dep = d as ParsedDep
  const errs: string[] = []

  if (!dep.country_iso3 || typeof dep.country_iso3 !== 'string' || dep.country_iso3.length !== 3) {
    errs.push(`country_iso3 invalid: ${dep.country_iso3}`)
  }
  if (!VALID_COMMODITIES.has(dep.commodity)) {
    errs.push(`commodity not in enum: ${dep.commodity}`)
  }
  if (dep.chokepoint_id !== null && dep.chokepoint_id !== undefined && !VALID_CHOKEPOINTS.has(dep.chokepoint_id)) {
    errs.push(`chokepoint_id not in enum: ${dep.chokepoint_id}`)
  }
  if (!Number.isInteger(dep.criticality) || dep.criticality < 1 || dep.criticality > 5) {
    errs.push(`criticality not 1-5: ${dep.criticality}`)
  }
  if (!dep.rationale || typeof dep.rationale !== 'string') {
    errs.push('rationale missing')
  }
  if (errs.length > 0) throw new Error(`${ticker} dep[${idx}]: ${errs.join(', ')}`)
  return dep
}

interface CliOptions {
  dryRun:   boolean
  ticker:   string | null
  limit:    number
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  let dryRun = false
  let ticker: string | null = null
  let limit  = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true
    else if (args[i] === '--ticker') ticker = args[++i]
    else if (args[i] === '--limit')  limit = parseInt(args[++i], 10)
  }
  return { dryRun, ticker, limit }
}

async function deriveForTicker(
  client: Anthropic,
  entry: { ticker: string; company: string; themes: string },
): Promise<ParsedDep[]> {
  const userMsg = `Ticker: ${entry.ticker}\nCompany: ${entry.company}\nThemes: ${entry.themes || 'n/a'}`
  const res = await client.messages.create({
    model:     PROMPT_MODEL,
    max_tokens: MAX_TOKENS,
    system:    SYSTEM_PROMPT,
    messages:  [{ role: 'user', content: userMsg }],
  })
  const text = res.content.find(b => b.type === 'text')?.text ?? ''
  const parsed = extractJsonArray(text)
  parsed.forEach((d, i) => validateDep(d, entry.ticker, i))
  return parsed
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (trade-graph is pgvector-native).')
    process.exit(1)
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required.')
    process.exit(1)
  }

  const opts = parseArgs()
  const watchlist = readWatchlist()
  let entries = opts.ticker
    ? watchlist.filter(e => e.ticker === opts.ticker)
    : watchlist
  if (opts.limit > 0) entries = entries.slice(0, opts.limit)
  if (opts.dryRun && opts.limit === 0 && !opts.ticker) entries = entries.slice(0, 3)

  if (entries.length === 0) {
    console.error('no tickers matched')
    process.exit(1)
  }

  const client = new Anthropic({ apiKey })
  const store  = createTradeStore()
  const pool   = getPool()

  // Pre-fetch the country ISO3 set so we can skip deps the LLM emits for
  // countries we haven't seeded yet (otherwise the insert hits a FK error).
  const countryRows = await pool.query<{ iso3: string }>(`select iso3 from trade.countries`)
  const knownCountries = new Set(countryRows.rows.map(r => r.iso3))

  console.log(`[deps] ${opts.dryRun ? 'DRY RUN' : 'LIVE'} — ${entries.length} ticker(s), model=${PROMPT_MODEL}`)
  console.log(`[deps] ${knownCountries.size} countries seeded; deps with unknown iso3 will be skipped`)

  let okCount = 0
  let failCount = 0
  let totalDeps = 0
  let skippedUnknownCountry = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    try {
      const deps = await deriveForTicker(client, entry)
      console.log(`[${i + 1}/${entries.length}] ${entry.ticker.padEnd(10)} ${deps.length} deps: ${deps.map(d => `${d.country_iso3}/${d.commodity}(${d.criticality})`).join(', ')}`)

      const insertable = deps.filter(d => {
        if (!knownCountries.has(d.country_iso3)) {
          skippedUnknownCountry++
          return false
        }
        return true
      })

      if (!opts.dryRun) {
        // Wipe existing LLM-sourced rows for this ticker; preserve manual.
        await pool.query(
          `delete from trade.ticker_dependencies where ticker = $1 and source = 'llm'`,
          [entry.ticker],
        )
        for (const d of insertable) {
          await store.upsertTickerDependency({
            ticker:        entry.ticker,
            countryIso3:   d.country_iso3,
            commodity:     d.commodity as CommodityCategory,
            chokepointId:  d.chokepoint_id ?? null,
            criticality:   d.criticality as 1 | 2 | 3 | 4 | 5,
            rationale:     d.rationale,
            source:        'llm',
          })
        }
      }
      okCount++
      totalDeps += insertable.length
    } catch (err) {
      console.log(`[${i + 1}/${entries.length}] ${entry.ticker.padEnd(10)} FAILED: ${(err as Error).message}`)
      failCount++
    }
  }

  console.log(`\n[deps] done — ${okCount} ok / ${failCount} failed; ${totalDeps} dependencies ${opts.dryRun ? 'parsed (NOT INSERTED)' : 'inserted'}; ${skippedUnknownCountry} skipped (country not seeded).`)
}

main().catch(err => { console.error(err); process.exit(1) })
