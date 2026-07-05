#!/usr/bin/env node
// Drop-zone trade-flow intake. Reads CSV files from apps/trade-graph/drop/
// (configurable via TRADE_DROP_DIR), upserts each row into trade.flows, and
// moves processed files to drop/processed/<date>/ so re-runs don't double-count.
//
// CSV format (header required, period_quarter optional):
//   origin_iso3,dest_iso3,commodity,value_usd,period_year,period_quarter
//   USA,CHN,semis,12000000000,2025,
//   USA,JPN,vehicles,8000000000,2025,3
//
// commodity must be one of COMMODITY_CATEGORIES (see types.ts).
// period_quarter empty = annual aggregate.
// value_usd is whole dollars (integer); scientific notation accepted.

import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'

import { createTradeStore } from '../store/trade-store.js'
import { COMMODITY_CATEGORIES } from '../types.js'
import type { CommodityCategory, FlowSource, TradeFlow } from '../types.js'

const COMMODITY_SET = new Set<string>(COMMODITY_CATEGORIES)

interface ParsedRow {
  originIso3:    string
  destIso3:      string
  commodity:     CommodityCategory
  valueUsd:      bigint
  periodYear:    number
  periodQuarter: 1 | 2 | 3 | 4 | null
  source:        FlowSource
}

function parseCsv(content: string, fileSource: FlowSource): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = []
  const rows: ParsedRow[] = []
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.startsWith('#'))
  if (lines.length === 0) return { rows, errors }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const need = ['origin_iso3', 'dest_iso3', 'commodity', 'value_usd', 'period_year']
  for (const col of need) {
    if (!header.includes(col)) errors.push(`missing required column: ${col}`)
  }
  if (errors.length > 0) return { rows, errors }
  const col = (name: string) => header.indexOf(name)

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim())
    const origin   = parts[col('origin_iso3')]?.toUpperCase()
    const dest     = parts[col('dest_iso3')]?.toUpperCase()
    const com      = parts[col('commodity')]?.toLowerCase()
    const valueRaw = parts[col('value_usd')]
    const yearRaw  = parts[col('period_year')]
    const qRaw     = col('period_quarter') >= 0 ? parts[col('period_quarter')] : ''

    if (!origin || !dest || !com || !valueRaw || !yearRaw) {
      errors.push(`line ${i + 1}: empty required field`)
      continue
    }
    if (!COMMODITY_SET.has(com)) {
      errors.push(`line ${i + 1}: unknown commodity "${com}" — must be one of ${COMMODITY_CATEGORIES.join(',')}`)
      continue
    }

    // Accept scientific notation but persist as integer bigint.
    const valueNum = Number(valueRaw)
    if (!Number.isFinite(valueNum) || valueNum < 0) {
      errors.push(`line ${i + 1}: invalid value_usd "${valueRaw}"`)
      continue
    }
    const valueUsd = BigInt(Math.round(valueNum))

    const periodYear = parseInt(yearRaw, 10)
    if (!Number.isFinite(periodYear) || periodYear < 1900 || periodYear > 2100) {
      errors.push(`line ${i + 1}: invalid period_year "${yearRaw}"`)
      continue
    }

    let periodQuarter: 1 | 2 | 3 | 4 | null = null
    if (qRaw) {
      const q = parseInt(qRaw.replace(/^q/i, ''), 10)
      if (q < 1 || q > 4 || !Number.isFinite(q)) {
        errors.push(`line ${i + 1}: invalid period_quarter "${qRaw}"`)
        continue
      }
      periodQuarter = q as 1 | 2 | 3 | 4
    }

    rows.push({
      originIso3:    origin,
      destIso3:      dest,
      commodity:     com as CommodityCategory,
      valueUsd,
      periodYear,
      periodQuarter,
      source:        fileSource,
    })
  }
  return { rows, errors }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (trade-graph is pgvector-native).')
    process.exit(1)
  }

  const dropDir = process.env.TRADE_DROP_DIR ?? join(process.cwd(), 'drop')
  if (!existsSync(dropDir)) {
    console.log(`[ingest] drop dir does not exist — creating ${dropDir}`)
    mkdirSync(dropDir, { recursive: true })
    console.log('[ingest] place CSV files here and re-run. exiting.')
    return
  }

  const csvFiles = readdirSync(dropDir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .filter(f => statSync(join(dropDir, f)).isFile())
  if (csvFiles.length === 0) {
    console.log(`[ingest] no .csv files in ${dropDir} — nothing to do`)
    return
  }

  const store = createTradeStore()
  const processedDir = join(dropDir, 'processed', new Date().toISOString().slice(0, 10))
  mkdirSync(processedDir, { recursive: true })

  let totalInserted = 0
  let totalErrors   = 0

  for (const file of csvFiles) {
    const path = join(dropDir, file)
    const content = readFileSync(path, 'utf-8')
    // Source tag: the filename can encode origin (e.g. un_comtrade_2025.csv).
    const source: FlowSource =
      file.toLowerCase().includes('un_comtrade') ? 'un_comtrade'
      : file.toLowerCase().includes('imf_dots')  ? 'imf_dots'
      : 'dropzone'

    const { rows, errors } = parseCsv(content, source)
    if (errors.length > 0) {
      console.log(`[ingest] ${file}: ${errors.length} error(s) — skipping file`)
      for (const e of errors.slice(0, 5)) console.log(`  ${e}`)
      if (errors.length > 5) console.log(`  ... and ${errors.length - 5} more`)
      totalErrors += errors.length
      continue
    }

    const n = await store.upsertFlows(
      rows.map(r => ({
        originIso3:    r.originIso3,
        destIso3:      r.destIso3,
        commodity:     r.commodity,
        valueUsd:      r.valueUsd,
        periodYear:    r.periodYear,
        periodQuarter: r.periodQuarter,
        source:        r.source,
      })) satisfies Array<Omit<TradeFlow, 'id' | 'ingestedAt'>>,
    )
    console.log(`[ingest] ${file}: ${n} rows upserted (source=${source})`)
    totalInserted += n

    renameSync(path, join(processedDir, basename(file)))
  }

  console.log(`[ingest] done — ${totalInserted} flows upserted across ${csvFiles.length} file(s), ${totalErrors} parse error(s)`)
}

main().catch(err => { console.error(err); process.exit(1) })
