// Portfolio risk metrics dashboard.
//
// Computes standard portfolio-level risk indicators from 90 days of daily
// returns: annualized volatility, Sharpe ratio, max drawdown, 1-day 95% VAR,
// and beta vs S&P 500 (VOO). Output is consumed by the briefing prompt so
// recommendations are aware of current risk exposure.

import 'dotenv/config'
import { join } from 'path'
import { writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { formatReport } from './risk-report.js'

// Writes to a temp file then renames into place. A same-filesystem rename is
// atomic and doesn't require the destination inode to already be in a good
// state — this sidesteps the EDEADLK errors direct writeFileSync hit against
// risk.json/report.md (leftover iCloud dataless-file state from before the
// repo moved to Projects.nosync).
function writeFileAtomic(path: string, data: string): void {
  const tmpPath = `${path}.tmp.${process.pid}`
  writeFileSync(tmpPath, data, 'utf-8')
  renameSync(tmpPath, path)
}

interface Position {
  ticker:       string
  priceSymbol:  string
  currentValue: number
  currency:     string
}

export interface RiskMetricsJSON {
  schemaVersion:        '1.0'
  generatedAt:          string
  windowDays:           number
  benchmark:            string
  portfolioValueUSD:    number
  portfolioVolatility:  number  // annualized stdev of daily returns
  portfolioReturn:      number  // total return over window
  sharpeRatio:          number  // annualized; risk-free assumed 4.5% (10Y proxy)
  maxDrawdown:          number  // worst peak-to-trough over window
  oneDayVAR95:          number  // 95% confidence one-day Value-at-Risk (USD)
  portfolioBeta:        number  // beta vs benchmark
  perTicker: Array<{
    ticker:        string
    weight:        number      // % of portfolio value
    volatility:    number
    totalReturn:   number
    beta:          number
    correlation:   number      // vs benchmark
  }>
  summary: string
}

const PORTFOLIO_DB = join(process.cwd(), '..', 'scenario-simulator', 'data', 'portfolio.db')
const REPORT_PATH  = join(process.cwd(), 'risk', 'report.md')
const JSON_PATH    = join(process.cwd(), 'risk', 'risk.json')

const WINDOW_DAYS = 90
const BENCHMARK   = 'VOO'
const RISK_FREE_RATE_ANNUAL = 0.045  // ~10Y Treasury proxy

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCloses(symbol: string): Promise<number[]> {
  const end   = Math.floor(Date.now() / 1000)
  const start = end - WINDOW_DAYS * 86_400
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return []
    const data = await res.json() as {
      chart: { result?: Array<{ indicators: { quote: Array<{ close: (number | null)[] }> } }> }
    }
    const closes = data.chart.result?.[0]?.indicators.quote[0]?.close ?? []
    return closes.filter((c): c is number => c != null)
  } catch { return [] }
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue
    out.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  return out
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 5) return 0
  const va = a.slice(-n), vb = b.slice(-n)
  const ma = va.reduce((s, x) => s + x, 0) / n
  const mb = vb.reduce((s, x) => s + x, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const xa = va[i] - ma, xb = vb[i] - mb
    num += xa * xb; da += xa * xa; db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

function beta(asset: number[], market: number[]): number {
  const n = Math.min(asset.length, market.length)
  if (n < 5) return 0
  const va = asset.slice(-n), vm = market.slice(-n)
  const ma = va.reduce((s, x) => s + x, 0) / n
  const mm = vm.reduce((s, x) => s + x, 0) / n
  let covar = 0, varm = 0
  for (let i = 0; i < n; i++) {
    covar += (va[i] - ma) * (vm[i] - mm)
    varm  += (vm[i] - mm) * (vm[i] - mm)
  }
  if (varm === 0) return 0
  return covar / varm
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0]
  let worst = 0
  for (const c of closes) {
    if (c > peak) peak = c
    const dd = (c - peak) / peak
    if (dd < worst) worst = dd
  }
  return worst  // negative number
}

function var95(returns: number[], portfolioValue: number): number {
  if (returns.length === 0) return 0
  // Sort returns ascending; 5th percentile = 1-day 95% VAR
  const sorted = [...returns].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.05)
  const tail = sorted[Math.max(0, idx)]
  return Math.abs(tail) * portfolioValue  // dollar loss
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!existsSync(PORTFOLIO_DB)) {
    console.error(`Portfolio DB not found at ${PORTFOLIO_DB}`)
    process.exit(1)
  }
  const db = new Database(PORTFOLIO_DB, { readonly: true })
  const positions = db.prepare(`
    SELECT ticker, price_symbol AS priceSymbol, current_value AS currentValue, currency
    FROM positions
    WHERE asset_class != 'cash' AND price_symbol != '' AND current_value > 0
  `).all() as Position[]
  db.close()

  console.log(`[risk] ${positions.length} positions with price symbols (window: ${WINDOW_DAYS}d, benchmark: ${BENCHMARK})`)

  // Fetch price series in parallel
  const benchClosesPromise = fetchCloses(BENCHMARK)
  const seriesEntries = await Promise.all(positions.map(async p => {
    const closes = await fetchCloses(p.priceSymbol)
    return { position: p, closes }
  }))
  const benchClosesRaw = await benchClosesPromise
  const benchReturns   = dailyReturns(benchClosesRaw)

  if (benchReturns.length === 0) {
    console.error('[risk] Failed to fetch benchmark returns — aborting')
    process.exit(1)
  }

  const totalValueUSD = positions.reduce((s, p) => s + p.currentValue, 0)

  const perTicker: RiskMetricsJSON['perTicker'] = []
  const portfolioReturnsByDay: Map<number, number> = new Map()

  for (const { position, closes } of seriesEntries) {
    if (closes.length < 10) continue
    const rets = dailyReturns(closes)
    const weight = position.currentValue / totalValueUSD
    perTicker.push({
      ticker:        position.ticker,
      weight,
      volatility:    stdev(rets) * Math.sqrt(252),  // annualized
      totalReturn:   (closes[closes.length - 1] - closes[0]) / closes[0],
      beta:          beta(rets, benchReturns),
      correlation:   pearson(rets, benchReturns),
    })
    // Aggregate weighted return per-day for portfolio metrics
    const n = Math.min(rets.length, benchReturns.length)
    for (let i = 0; i < n; i++) {
      const day = benchReturns.length - n + i
      portfolioReturnsByDay.set(day, (portfolioReturnsByDay.get(day) ?? 0) + weight * rets[rets.length - n + i])
    }
  }

  const portfolioReturns = Array.from(portfolioReturnsByDay.values())
  const portVol         = stdev(portfolioReturns) * Math.sqrt(252)
  const portTotalReturn = portfolioReturns.reduce((s, r) => s + r, 0)
  const annualizedReturn = portTotalReturn * (252 / portfolioReturns.length)
  const sharpe          = portVol > 0 ? (annualizedReturn - RISK_FREE_RATE_ANNUAL) / portVol : 0

  // Synthetic portfolio "close series" for max drawdown — start at 1, compound returns
  const portCloses: number[] = [1]
  for (const r of portfolioReturns) portCloses.push(portCloses[portCloses.length - 1] * (1 + r))
  const maxDD = maxDrawdown(portCloses)

  const dailyVAR = var95(portfolioReturns, totalValueUSD)

  const portBeta = beta(portfolioReturns, benchReturns)

  const summary = [
    `Portfolio value ~$${totalValueUSD.toFixed(0)} (analyzed)`,
    `Vol (ann) ${(portVol * 100).toFixed(1)}%`,
    `Sharpe ${sharpe.toFixed(2)}`,
    `Max DD ${(maxDD * 100).toFixed(1)}%`,
    `1d-95% VAR $${dailyVAR.toFixed(0)}`,
    `Beta vs ${BENCHMARK} ${portBeta.toFixed(2)}`,
  ].join(' | ')

  const payload: RiskMetricsJSON = {
    schemaVersion:       '1.0',
    generatedAt:         new Date().toISOString().slice(0, 10),
    windowDays:          WINDOW_DAYS,
    benchmark:           BENCHMARK,
    portfolioValueUSD:   totalValueUSD,
    portfolioVolatility: portVol,
    portfolioReturn:     portTotalReturn,
    sharpeRatio:         sharpe,
    maxDrawdown:         maxDD,
    oneDayVAR95:         dailyVAR,
    portfolioBeta:       portBeta,
    perTicker:           perTicker.sort((a, b) => b.weight - a.weight),
    summary,
  }

  mkdirSync(join(process.cwd(), 'risk'), { recursive: true })
  writeFileAtomic(JSON_PATH, JSON.stringify(payload, null, 2))
  writeFileAtomic(REPORT_PATH, formatReport(payload))

  console.log(`\nReport: ${REPORT_PATH}`)
  console.log(`JSON:   ${JSON_PATH}`)
  console.log(`Summary: ${summary}`)
}

run().catch(err => { console.error(err); process.exit(1) })
