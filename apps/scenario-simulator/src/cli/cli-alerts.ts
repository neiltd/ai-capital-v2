// Intraday hot-ticker alerter.
//
// Run on a cron during market hours (e.g. every 30 min). For each currently-held
// position:
//   1. Fetch current Yahoo Finance price + prior close
//   2. Compute intraday % change vs prior close
//   3. Query the ingestion DB for article volume in the last 6 hours
//   4. If price drop >= 5% OR news volume > 3 articles, queue a LINE alert
//   5. De-dupe via data/alert-state.json (no repeat alerts within 60 min)
//
// Manual run: npm run alerts

import 'dotenv/config'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { sendLine } from '../notify/line.js'

const DATA_DIR        = join(process.cwd(), 'data')
const PORTFOLIO_DB    = join(DATA_DIR, 'portfolio.db')
const INGESTION_DB    = join(process.cwd(), '../capital-intelligence-ingestion/data/sqlite.db')
const STATE_PATH      = join(DATA_DIR, 'alert-state.json')

const PRICE_DROP_THRESHOLD     = -0.05  // -5% intraday
const NEWS_VELOCITY_THRESHOLD  = 3      // articles in last 6 hours
const REPEAT_ALERT_MIN_MINUTES = 60     // suppress same-ticker alerts within this window
const NEWS_WINDOW_HOURS        = 6

interface AlertState {
  [ticker: string]: { lastAlertedAt: string; lastAlertPrice: number }
}

interface TickerAlert {
  ticker:          string
  company:         string
  currentPrice:    number
  priorClose:      number
  intradayPctChange: number
  articleCount6h:  number
  reasons:         string[]  // why alerted (drop, news, both)
}

// ── Yahoo intraday price fetch (current + prior close) ───────────────────────

async function fetchIntradayPrice(symbol: string): Promise<{ current: number | null; priorClose: number | null }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return { current: null, priorClose: null }
    const data = await res.json() as {
      chart: {
        result?: Array<{
          meta: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number }
        }>
      }
    }
    const meta = data.chart.result?.[0]?.meta
    if (!meta) return { current: null, priorClose: null }
    return {
      current:    meta.regularMarketPrice ?? null,
      priorClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    }
  } catch { return { current: null, priorClose: null } }
}

// ── State persistence ────────────────────────────────────────────────────────

function loadState(): AlertState {
  if (!existsSync(STATE_PATH)) return {}
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as AlertState }
  catch { return {} }
}

function saveState(state: AlertState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

function minutesSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / 60_000
}

// ── News velocity ────────────────────────────────────────────────────────────

function articleCountSince(ingestionDb: Database.Database, ticker: string, sinceIso: string): number {
  const row = ingestionDb.prepare(
    'SELECT COUNT(*) AS n FROM documents WHERE ticker = ? AND fetched_at > ?'
  ).get(ticker, sinceIso) as { n: number } | undefined
  return row?.n ?? 0
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!existsSync(PORTFOLIO_DB)) {
    console.error(`Portfolio DB not found at ${PORTFOLIO_DB}`)
    process.exit(1)
  }
  mkdirSync(DATA_DIR, { recursive: true })
  const portfolioStore = createPortfolioStore(PORTFOLIO_DB)
  const positions = (await portfolioStore.getPositions())
    .filter(p => p.assetClass !== 'cash' && p.priceSymbol && p.shares > 0)
  await portfolioStore.close()

  const state = loadState()
  const sinceIso = new Date(Date.now() - NEWS_WINDOW_HOURS * 3_600_000).toISOString()
  const ingestionAvailable = existsSync(INGESTION_DB)
  const ingestionDb = ingestionAvailable ? new Database(INGESTION_DB, { readonly: true }) : null

  const alerts: TickerAlert[] = []
  for (const p of positions) {
    // Skip if recent alert already fired
    const last = state[p.ticker]
    if (last && minutesSince(last.lastAlertedAt) < REPEAT_ALERT_MIN_MINUTES) continue

    const { current, priorClose } = await fetchIntradayPrice(p.priceSymbol)
    const articleCount = ingestionDb ? articleCountSince(ingestionDb, p.ticker, sinceIso) : 0

    const reasons: string[] = []
    let intradayChange = 0
    if (current != null && priorClose != null && priorClose > 0) {
      intradayChange = (current - priorClose) / priorClose
      if (intradayChange <= PRICE_DROP_THRESHOLD) {
        reasons.push(`📉 Intraday ${(intradayChange * 100).toFixed(2)}%`)
      }
    }
    if (articleCount >= NEWS_VELOCITY_THRESHOLD) {
      reasons.push(`📰 ${articleCount} articles in last ${NEWS_WINDOW_HOURS}h`)
    }

    if (reasons.length > 0 && current != null) {
      alerts.push({
        ticker:           p.ticker,
        company:          p.company,
        currentPrice:     current,
        priorClose:       priorClose ?? 0,
        intradayPctChange: intradayChange,
        articleCount6h:   articleCount,
        reasons,
      })
      state[p.ticker] = { lastAlertedAt: new Date().toISOString(), lastAlertPrice: current }
    }
  }
  if (ingestionDb) ingestionDb.close()

  console.log(`[alerts] Checked ${positions.length} positions, ${alerts.length} alert(s) triggered`)

  if (alerts.length === 0) return

  const lines: string[] = [
    `🚨 Hot Ticker Alerts — ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })}`,
    ``,
  ]
  for (const a of alerts) {
    const changeSign = a.intradayPctChange >= 0 ? '+' : ''
    lines.push(
      `${a.ticker} (${a.company})`,
      `  Price: $${a.currentPrice.toFixed(2)} (${changeSign}${(a.intradayPctChange * 100).toFixed(2)}% vs prev close ${a.priorClose.toFixed(2)})`,
      `  Reasons: ${a.reasons.join(' · ')}`,
      ``,
    )
  }
  const message = lines.join('\n')

  await sendLine(message)
  saveState(state)
  console.log(`[alerts] LINE message sent (${alerts.length} alerts) and state updated`)
}

run().catch(err => { console.error(err); process.exit(1) })
