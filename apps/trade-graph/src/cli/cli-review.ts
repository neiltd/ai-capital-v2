#!/usr/bin/env node
// Manual review + override of ticker dependencies. LLM output (source='llm')
// is the default; this CLI lets you add `source='manual'` rows that override
// or augment it, and drop bad rows.
//
// Re-running `pnpm deps` wipes only source='llm' for the affected tickers,
// so manual overrides persist.
//
// Usage:
//   pnpm review --ticker NVDA                      # list current deps
//   pnpm review --ticker NVDA --rm <dep_id>        # drop one row
//   pnpm review --ticker NVDA --add CHN:semis:1:"Memory + mature-node supply"
//   pnpm review --ticker NVDA --add CHN:semis:1:taiwan_strait:"Direct"
//   pnpm review --portfolio-exposure CHN           # tickers exposed to a country
//   pnpm review --portfolio-exposure hormuz        # tickers exposed to a chokepoint

import { getPool } from '@common/db'
import { createTradeStore }    from '../store/trade-store.js'
import { COMMODITY_CATEGORIES, type CommodityCategory } from '../types.js'
import { CHOKEPOINTS }         from '../data/chokepoints.js'

const VALID_COMMODITIES = new Set<string>(COMMODITY_CATEGORIES)
const VALID_CHOKEPOINTS = new Set(CHOKEPOINTS.map(c => c.id))

interface AddSpec {
  countryIso3:  string
  commodity:    CommodityCategory
  criticality:  1 | 2 | 3 | 4 | 5
  chokepointId: string | null
  rationale:    string
}

/** Parse `COUNTRY:commodity:criticality[:chokepoint]:rationale`. The rationale
 *  is everything after the last required colon — letting it contain colons. */
function parseAddSpec(spec: string): AddSpec {
  // Strict order: COUNTRY, commodity, criticality, [chokepoint], rationale.
  const parts = spec.split(':')
  if (parts.length < 4) throw new Error(`bad spec — need at least COUNTRY:commodity:criticality:rationale`)
  const countryIso3 = parts[0].toUpperCase()
  const commodity   = parts[1].toLowerCase()
  const criticality = parseInt(parts[2], 10)

  let chokepointId: string | null = null
  let rationaleStart = 3
  // If field 4 matches a known chokepoint id, treat it as such; otherwise it's
  // the start of the rationale.
  if (VALID_CHOKEPOINTS.has(parts[3])) {
    chokepointId = parts[3]
    rationaleStart = 4
  }
  const rationale = parts.slice(rationaleStart).join(':').trim()

  if (countryIso3.length !== 3) throw new Error(`country_iso3 must be 3 chars (got "${countryIso3}")`)
  if (!VALID_COMMODITIES.has(commodity)) throw new Error(`commodity not valid (got "${commodity}")`)
  if (![1, 2, 3, 4, 5].includes(criticality)) throw new Error(`criticality must be 1-5 (got ${criticality})`)
  if (!rationale) throw new Error('rationale required')

  return {
    countryIso3,
    commodity: commodity as CommodityCategory,
    criticality: criticality as 1 | 2 | 3 | 4 | 5,
    chokepointId,
    rationale,
  }
}

interface CliOptions {
  ticker:            string | null
  rmId:              string | null
  addSpec:           string | null
  portfolioExposure: string | null
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  let ticker: string | null = null
  let rmId:   string | null = null
  let addSpec: string | null = null
  let portfolioExposure: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ticker')    ticker = args[++i]
    else if (args[i] === '--rm')   rmId   = args[++i]
    else if (args[i] === '--add')  addSpec = args[++i]
    else if (args[i] === '--portfolio-exposure') portfolioExposure = args[++i]
  }
  return { ticker, rmId, addSpec, portfolioExposure }
}

async function listForTicker(ticker: string): Promise<void> {
  const store = createTradeStore()
  const deps = await store.depsForTicker(ticker)
  if (deps.length === 0) {
    console.log(`${ticker}: no dependencies yet — run \`pnpm deps --ticker ${ticker}\``)
    return
  }
  console.log(`${ticker} — ${deps.length} dependencies (sorted by criticality):`)
  for (const d of deps) {
    const choke = d.chokepointId ? ` via ${d.chokepointId}` : ''
    const tag   = d.source === 'manual' ? '[MANUAL]' : '[llm]'
    console.log(`  ${tag} ${d.id}`)
    console.log(`         crit=${d.criticality}  ${d.countryIso3}/${d.commodity}${choke}`)
    console.log(`         — ${d.rationale ?? '(no rationale)'}`)
  }
}

async function portfolioExposure(target: string): Promise<void> {
  const store = createTradeStore()
  // Try chokepoint id first, then fall back to country iso3.
  if (VALID_CHOKEPOINTS.has(target)) {
    const tickers = await store.tickersDependentOnChokepoint(target)
    console.log(`Chokepoint ${target}: ${tickers.length} tickers exposed`)
    for (const t of tickers) console.log(`  ${t}`)
    return
  }
  const upper = target.toUpperCase()
  const tickers = await store.tickersDependentOnCountry(upper)
  console.log(`Country ${upper}: ${tickers.length} tickers exposed`)
  for (const t of tickers) console.log(`  ${t}`)
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (trade-graph is pgvector-native).')
    process.exit(1)
  }
  const opts = parseArgs()

  if (opts.portfolioExposure) {
    await portfolioExposure(opts.portfolioExposure)
    return
  }

  if (!opts.ticker) {
    console.error('--ticker <TICKER> is required (unless using --portfolio-exposure).')
    process.exit(1)
  }

  if (opts.rmId) {
    const pool = getPool()
    const res = await pool.query(
      `delete from trade.ticker_dependencies where id = $1 and ticker = $2`,
      [opts.rmId, opts.ticker],
    )
    console.log(`removed ${res.rowCount} row(s)`)
    await listForTicker(opts.ticker)
    return
  }

  if (opts.addSpec) {
    const spec = parseAddSpec(opts.addSpec)
    const store = createTradeStore()
    await store.upsertTickerDependency({
      ticker:       opts.ticker,
      countryIso3:  spec.countryIso3,
      commodity:    spec.commodity,
      chokepointId: spec.chokepointId,
      criticality:  spec.criticality,
      rationale:    spec.rationale,
      source:       'manual',
    })
    console.log(`added manual dep for ${opts.ticker}`)
    await listForTicker(opts.ticker)
    return
  }

  await listForTicker(opts.ticker)
}

main().catch(err => { console.error(err); process.exit(1) })
