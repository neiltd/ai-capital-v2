// Position correlation engine — flags hidden concentration risk.
//
// Reads current portfolio positions from scenario-simulator's portfolio.db,
// fetches ~90 days of daily closes from Yahoo Finance, computes pairwise
// Pearson correlation, identifies clusters of highly-correlated holdings, and
// surfaces concentration percentages.
//
// Output: correlation/report.md with the full matrix + concentration warnings.

import 'dotenv/config'
import { join } from 'path'
import { writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { formatReport } from './correlation-report.js'

// See risk-runner.ts for why this is atomic (rename, not direct write) —
// same class of EDEADLK failure hit this file's writes too.
function writeFileAtomic(path: string, data: string): void {
  const tmpPath = `${path}.tmp.${process.pid}`
  writeFileSync(tmpPath, data, 'utf-8')
  renameSync(tmpPath, path)
}

interface Position {
  ticker:       string
  assetClass:   string
  priceSymbol:  string
  currentValue: number
}

export interface PriceSeries {
  ticker: string
  dates:  string[]
  closes: number[]
}

export interface CorrelationCell {
  a:           string
  b:           string
  correlation: number
}

export interface Cluster {
  members:        string[]
  totalValueUSD:  number
  pctOfPortfolio: number
  avgCorrelation: number
}

const PORTFOLIO_DB = join(process.cwd(), '..', 'scenario-simulator', 'data', 'portfolio.db')
const REPORT_PATH  = join(process.cwd(), 'correlation', 'report.md')

const WINDOW_DAYS         = 90
const CORRELATION_THRESHOLD = 0.7   // Pairs >= this are "highly correlated"
const CONCENTRATION_WARN_PCT = 30   // Clusters > 30% of portfolio trigger flag

// ── Fetch positions ──────────────────────────────────────────────────────────

function loadPositions(): Position[] {
  if (!existsSync(PORTFOLIO_DB)) {
    console.error(`Portfolio DB not found at ${PORTFOLIO_DB}`)
    process.exit(1)
  }
  const db = new Database(PORTFOLIO_DB, { readonly: true })
  const rows = db.prepare(`
    SELECT ticker, asset_class AS assetClass, price_symbol AS priceSymbol, current_value AS currentValue
    FROM positions
    WHERE asset_class != 'cash' AND price_symbol != '' AND current_value > 0
    ORDER BY current_value DESC
  `).all() as Position[]
  db.close()
  return rows
}

// ── Fetch price history ──────────────────────────────────────────────────────

async function fetchPriceSeries(symbol: string): Promise<PriceSeries | null> {
  const end   = Math.floor(Date.now() / 1000)
  const start = end - WINDOW_DAYS * 86_400
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const data = await res.json() as {
      chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ close: (number | null)[] }> } }>; error?: { code: string } }
    }
    if (data.chart.error || !data.chart.result?.length) return null
    const r = data.chart.result[0]
    const closes: number[] = []
    const dates:  string[] = []
    const rawCloses = r.indicators.quote[0]?.close ?? []
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = rawCloses[i]
      if (c == null) continue
      closes.push(c)
      dates.push(new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10))
    }
    return { ticker: symbol, dates, closes }
  } catch {
    return null
  }
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function dailyReturns(closes: number[]): number[] {
  const ret: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) ret.push(0)
    else ret.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  return ret
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 5) return 0  // not enough data
  const va = a.slice(-n)
  const vb = b.slice(-n)
  const ma = va.reduce((s, x) => s + x, 0) / n
  const mb = vb.reduce((s, x) => s + x, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const xa = va[i] - ma
    const xb = vb[i] - mb
    num += xa * xb
    da  += xa * xa
    db  += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

// ── Cluster detection (greedy union-find on correlated pairs) ────────────────

function buildClusters(
  tickers: string[],
  pairs: CorrelationCell[],
  threshold: number,
): string[][] {
  const parent: Record<string, string> = {}
  for (const t of tickers) parent[t] = t
  const find = (x: string): string => parent[x] === x ? x : (parent[x] = find(parent[x]))
  const union = (a: string, b: string) => { parent[find(a)] = find(b) }
  for (const p of pairs) {
    if (p.correlation >= threshold) union(p.a, p.b)
  }
  const groups: Record<string, string[]> = {}
  for (const t of tickers) {
    const root = find(t)
    groups[root] ??= []
    groups[root].push(t)
  }
  return Object.values(groups).filter(g => g.length > 1)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const positions = loadPositions()
  console.log(`[correlation] ${positions.length} positions with price symbols`)

  // Fetch series in parallel (Yahoo Finance handles modest concurrency fine)
  const series: PriceSeries[] = []
  const symbolToTicker: Record<string, string> = {}
  await Promise.all(positions.map(async p => {
    symbolToTicker[p.priceSymbol] = p.ticker
    const s = await fetchPriceSeries(p.priceSymbol)
    if (s) {
      s.ticker = p.ticker  // store by portfolio ticker, not by price symbol
      series.push(s)
    } else {
      console.warn(`  [correlation] ${p.ticker} (${p.priceSymbol}): no price series`)
    }
  }))
  console.log(`[correlation] Fetched ${series.length} price series (window: ${WINDOW_DAYS}d)`)

  // Build return series
  const returns: Record<string, number[]> = {}
  for (const s of series) returns[s.ticker] = dailyReturns(s.closes)

  // Pairwise correlation
  const tickers = series.map(s => s.ticker)
  const pairs: CorrelationCell[] = []
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const a = tickers[i]
      const b = tickers[j]
      pairs.push({ a, b, correlation: pearson(returns[a], returns[b]) })
    }
  }
  pairs.sort((p, q) => Math.abs(q.correlation) - Math.abs(p.correlation))
  console.log(`[correlation] Computed ${pairs.length} pairwise correlations`)

  // Cluster detection
  const clusterGroups = buildClusters(tickers, pairs, CORRELATION_THRESHOLD)
  const positionsByTicker = Object.fromEntries(positions.map(p => [p.ticker, p]))
  const totalPortfolioValue = positions.reduce((s, p) => s + p.currentValue, 0)

  const clusters: Cluster[] = clusterGroups.map(members => {
    const totalValueUSD = members.reduce((s, t) => s + (positionsByTicker[t]?.currentValue ?? 0), 0)
    // Average correlation of all pairs within the cluster
    const inClusterPairs = pairs.filter(p => members.includes(p.a) && members.includes(p.b))
    const avgCorrelation = inClusterPairs.length
      ? inClusterPairs.reduce((s, p) => s + p.correlation, 0) / inClusterPairs.length
      : 0
    return {
      members,
      totalValueUSD,
      pctOfPortfolio: (totalValueUSD / totalPortfolioValue) * 100,
      avgCorrelation,
    }
  }).sort((a, b) => b.pctOfPortfolio - a.pctOfPortfolio)

  const report = formatReport({
    positions,
    series,
    pairs,
    clusters,
    totalPortfolioValue,
    windowDays: WINDOW_DAYS,
    correlationThreshold: CORRELATION_THRESHOLD,
    concentrationWarnPct: CONCENTRATION_WARN_PCT,
  })

  mkdirSync(join(process.cwd(), 'correlation'), { recursive: true })
  writeFileAtomic(REPORT_PATH, report)
  console.log(`\nReport: ${REPORT_PATH}`)
}

run().catch(err => { console.error(err); process.exit(1) })
