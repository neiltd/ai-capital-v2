// Tax-loss harvesting analyzer.
//
// Reads positions + trade log from scenario-simulator's portfolio.db.
// Identifies:
//   1. Year-to-date realized gains / losses
//   2. Current underwater positions that could be harvested for tax offset
//   3. Wash sale risk — sells within last 30 days where re-buying triggers IRS Section 1091
//   4. Strategy-aware: tax-locked positions (THAIESG/RMF/SSF) are skipped
//
// Output:
//   - tax/report.md       — human-readable summary
//   - tax/harvest.json    — structured payload consumed by the briefing prompt
//
// Tax-jurisdiction note: Thai individual residents are EXEMPT from capital
// gains tax on SET equities (under the personal income tax code). For Thai
// equities the harvest "opportunity" is informational only — real cash savings
// only materialize on US-equity losses if filing US taxes.

import 'dotenv/config'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { formatReport } from './tax-harvest-report.js'

interface Position {
  ticker:        string
  assetClass:    string
  currency:      string
  strategy:      string
  shares:        number
  avgCost:       number
  currentPrice:  number
  unrealizedPnl: number
}

interface TradeEntry {
  date:         string
  ticker:       string
  action:       'buy' | 'sell'
  shares:       number
  price:        number
  reason:       string
}

export interface HarvestOpportunity {
  ticker:           string
  assetClass:       string
  currency:         string
  strategy:         string
  unrealizedLoss:   number  // negative number in position currency
  unrealizedLossUSD:number  // converted via FX if THB
  shares:           number
  taxJurisdiction:  'us' | 'thai-exempt' | 'thai-taxable' | 'tax-locked'
  harvestable:      boolean
  washSaleRisk:     boolean
  notes:            string
}

export interface WashSaleAlert {
  ticker:           string
  soldAt:           string
  soldShares:       number
  soldPrice:        number
  doNotRebuyBefore: string
  daysRemaining:    number
}

export interface TaxHarvestJSON {
  schemaVersion:    '1.0'
  generatedAt:      string
  fxRateUsdThb:     number | null
  realizedYTD: {
    gainsUSD:      number
    lossesUSD:     number
    netTaxableUSD: number
    trades:        number
  }
  harvestOpportunities: HarvestOpportunity[]
  washSaleAlerts:       WashSaleAlert[]
  summary:              string
}

const PORTFOLIO_DB = join(process.cwd(), '..', 'scenario-simulator', 'data', 'portfolio.db')
const REPORT_PATH  = join(process.cwd(), 'tax', 'report.md')
const JSON_PATH    = join(process.cwd(), 'tax', 'harvest.json')

const WASH_SALE_DAYS = 30
const MIN_HARVEST_USD = 100  // skip trivial losses

// ── Classification ───────────────────────────────────────────────────────────

function classifyJurisdiction(p: Position): HarvestOpportunity['taxJurisdiction'] {
  if (p.strategy === 'tax_locked') return 'tax-locked'
  if (p.assetClass === 'us_equity' || p.assetClass === 'gold') return 'us'
  if (p.assetClass === 'th_equity') return 'thai-exempt'
  if (p.assetClass === 'th_fund')   return 'thai-taxable'
  return 'us'
}

// ── FX ───────────────────────────────────────────────────────────────────────

async function fetchUsdThb(): Promise<number | null> {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/THB=X?interval=1d&range=5d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) return null
    const data = await res.json() as { chart: { result?: Array<{ meta: { regularMarketPrice?: number } }> } }
    return data.chart.result?.[0]?.meta.regularMarketPrice ?? null
  } catch { return null }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const db = new Database(PORTFOLIO_DB, { readonly: true })
  const positions = db.prepare(`
    SELECT ticker, asset_class AS assetClass, currency, strategy,
           shares, avg_cost AS avgCost, current_price AS currentPrice,
           unrealized_pnl AS unrealizedPnl
    FROM positions
    WHERE shares > 0
  `).all() as Position[]

  const trades = db.prepare(`
    SELECT date, ticker, action, shares, price, reason
    FROM trade_log
    ORDER BY date DESC, id DESC
  `).all() as TradeEntry[]
  db.close()

  const fx = await fetchUsdThb()
  console.log(`[tax] ${positions.length} positions, ${trades.length} trades in log, FX=${fx ?? 'unknown'}`)

  // ── 1. Year-to-date realized P&L (USD-equivalent) ──────────────────────
  const yearStart = `${new Date().getUTCFullYear()}-01-01`
  const ytdTrades = trades.filter(t => t.date >= yearStart && t.action === 'sell')

  // Build avg-cost lookup from current position file (approximate — true cost
  // basis would need full buy history; this works for current-year sells off
  // the current position's avg_cost)
  const avgCostByTicker = new Map(positions.map(p => [p.ticker, p.avgCost]))

  let gainsUSD  = 0
  let lossesUSD = 0
  for (const t of ytdTrades) {
    const avgCost = avgCostByTicker.get(t.ticker)
    if (avgCost == null) continue
    const realized = (t.price - avgCost) * t.shares
    // Convert if THB-quoted (price symbol implies currency)
    const realizedUSD = (t.ticker.endsWith('.BK') || t.ticker.startsWith('K-') || t.ticker.startsWith('SCB') || t.ticker.startsWith('PFM'))
      ? (fx ? realized / fx : realized)
      : realized
    if (realizedUSD >= 0) gainsUSD += realizedUSD
    else                  lossesUSD += realizedUSD
  }
  const netTaxableUSD = gainsUSD + lossesUSD

  // ── 2. Harvest opportunities ───────────────────────────────────────────
  const harvestOpportunities: HarvestOpportunity[] = []
  for (const p of positions) {
    if (p.unrealizedPnl >= 0) continue  // not underwater
    const jurisdiction = classifyJurisdiction(p)
    const unrealizedLossUSD = p.currency === 'THB' && fx ? p.unrealizedPnl / fx : p.unrealizedPnl
    if (Math.abs(unrealizedLossUSD) < MIN_HARVEST_USD) continue

    // Wash-sale check: any sell of this ticker in last 30 days?
    const recentSell = trades.find(t =>
      t.ticker === p.ticker &&
      t.action === 'sell' &&
      daysAgo(t.date) <= WASH_SALE_DAYS,
    )

    const harvestable =
      jurisdiction === 'us' ||
      jurisdiction === 'thai-taxable'

    let notes = ''
    if (jurisdiction === 'thai-exempt') {
      notes = 'Thai SET equity — capital gains/losses NOT taxable for Thai resident individuals; harvest provides no cash tax benefit'
    } else if (jurisdiction === 'tax-locked') {
      notes = 'Tax-locked vehicle (THAIESG/RMF/SSF/PFM) — selling triggers tax clawback that destroys economic rationale'
    } else if (jurisdiction === 'us') {
      notes = `US-equity loss of $${Math.abs(unrealizedLossUSD).toFixed(0)} can offset realized gains (currently $${gainsUSD.toFixed(0)} YTD)`
    } else if (jurisdiction === 'thai-taxable') {
      notes = 'Thai mutual fund (not tax-locked) — capital gains are taxable; loss can offset other taxable fund gains'
    }
    if (recentSell) notes += `; ⚠️ WASH SALE: sold same ticker on ${recentSell.date}`

    harvestOpportunities.push({
      ticker:           p.ticker,
      assetClass:       p.assetClass,
      currency:         p.currency,
      strategy:         p.strategy,
      unrealizedLoss:   p.unrealizedPnl,
      unrealizedLossUSD,
      shares:           p.shares,
      taxJurisdiction:  jurisdiction,
      harvestable,
      washSaleRisk:     !!recentSell,
      notes,
    })
  }
  harvestOpportunities.sort((a, b) => a.unrealizedLossUSD - b.unrealizedLossUSD)

  // ── 3. Wash-sale alerts on RECENT SELLS (don't rebuy yet) ──────────────
  const washSaleAlerts: WashSaleAlert[] = []
  for (const t of trades) {
    if (t.action !== 'sell') continue
    const days = daysAgo(t.date)
    if (days > WASH_SALE_DAYS) break  // sorted desc — older than 30d, stop
    // Only US-equity wash sale rule applies; Thai SET doesn't have it
    const isUS = !t.ticker.endsWith('.BK') && !t.ticker.startsWith('K-') && !t.ticker.startsWith('SCB') && !t.ticker.startsWith('PFM')
    if (!isUS) continue
    const reboundDate = new Date(t.date)
    reboundDate.setUTCDate(reboundDate.getUTCDate() + WASH_SALE_DAYS)
    washSaleAlerts.push({
      ticker:           t.ticker,
      soldAt:           t.date,
      soldShares:       t.shares,
      soldPrice:        t.price,
      doNotRebuyBefore: reboundDate.toISOString().slice(0, 10),
      daysRemaining:    Math.max(0, WASH_SALE_DAYS - days),
    })
  }

  // ── Summary line for the briefing prompt ───────────────────────────────
  const harvestableTotal = harvestOpportunities
    .filter(o => o.harvestable && !o.washSaleRisk)
    .reduce((s, o) => s + Math.abs(o.unrealizedLossUSD), 0)
  const summary = [
    `YTD realized USD: gains $${gainsUSD.toFixed(0)}, losses $${lossesUSD.toFixed(0)}, net taxable $${netTaxableUSD.toFixed(0)}`,
    `Harvestable losses available (excludes Thai-exempt, tax-locked, wash-sale-blocked): $${harvestableTotal.toFixed(0)}`,
    washSaleAlerts.length > 0 ? `${washSaleAlerts.length} active wash-sale window(s)` : 'No active wash-sale windows',
  ].join(' | ')

  const payload: TaxHarvestJSON = {
    schemaVersion:        '1.0',
    generatedAt:          new Date().toISOString().slice(0, 10),
    fxRateUsdThb:         fx,
    realizedYTD: {
      gainsUSD,
      lossesUSD,
      netTaxableUSD,
      trades: ytdTrades.length,
    },
    harvestOpportunities,
    washSaleAlerts,
    summary,
  }

  mkdirSync(join(process.cwd(), 'tax'), { recursive: true })
  writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2), 'utf-8')
  writeFileSync(REPORT_PATH, formatReport(payload), 'utf-8')

  console.log(`\nReport:  ${REPORT_PATH}`)
  console.log(`JSON:    ${JSON_PATH}`)
  console.log(`Summary: ${summary}`)
}

function daysAgo(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

run().catch(err => { console.error(err); process.exit(1) })
