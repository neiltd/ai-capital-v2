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
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { usePostgres, getPool, closePool } from '@common/db'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { alertsPath, loadAlerts, saveAlerts, reconcile, type Observation, type Evaluated } from '../alerts/alert-store.js'

const DATA_DIR        = join(process.cwd(), 'data')
const PORTFOLIO_DB    = join(DATA_DIR, 'portfolio.db')
const INGESTION_DB    = join(process.cwd(), '../capital-intelligence-ingestion/data/sqlite.db')
const ALERTS_PATH     = alertsPath()

const PRICE_DROP_THRESHOLD     = -0.05  // -5% intraday
const NEWS_VELOCITY_THRESHOLD  = 3      // articles in last 6 hours
const NEWS_WINDOW_HOURS        = 6

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

// ── News velocity ────────────────────────────────────────────────────────────

function articleCountSince(ingestionDb: Database.Database, ticker: string, sinceIso: string): number {
  const row = ingestionDb.prepare(
    'SELECT COUNT(*) AS n FROM documents WHERE ticker = ? AND fetched_at > ?'
  ).get(ticker, sinceIso) as { n: number } | undefined
  return row?.n ?? 0
}

// When DATABASE_URL is set, ingestion writes documents to Postgres
// (capital.documents) and the local sqlite.db goes stale — counting from the
// file would silently report 0 articles forever. Mirror the store selection.
async function articleCountSincePg(ticker: string, sinceIso: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT COUNT(*)::int AS n FROM capital.documents WHERE ticker = $1 AND fetched_at > $2',
    [ticker, sinceIso],
  )
  return (rows[0] as { n: number } | undefined)?.n ?? 0
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!usePostgres() && !existsSync(PORTFOLIO_DB)) {
    console.error(`Portfolio DB not found at ${PORTFOLIO_DB}`)
    process.exit(1)
  }
  mkdirSync(DATA_DIR, { recursive: true })
  const portfolioStore = createPortfolioStore(PORTFOLIO_DB, { fileMustExist: true })
  const positions = (await portfolioStore.getPositions())
    .filter(p => p.assetClass !== 'cash' && p.priceSymbol && p.shares > 0)
  await portfolioStore.close()

  const sinceIso = new Date(Date.now() - NEWS_WINDOW_HOURS * 3_600_000).toISOString()
  const ingestionAvailable = !usePostgres() && existsSync(INGESTION_DB)
  // Postgres always answers; the SQLite path only if the file is there.
  const newsAvailable = usePostgres() || ingestionAvailable
  const ingestionDb = ingestionAvailable ? new Database(INGESTION_DB, { readonly: true }) : null
  const countArticles = async (ticker: string): Promise<number> => {
    if (usePostgres()) return articleCountSincePg(ticker, sinceIso)
    return ingestionDb ? articleCountSince(ingestionDb, ticker, sinceIso) : 0
  }

  const observations: Observation[] = []
  const evaluated: Evaluated[] = []
  for (const p of positions) {
    // Every position is evaluated every run. The old cooldown `continue`d here,
    // BEFORE the price was fetched, so a transport concern was gating detection.
    const { current, priorClose } = await fetchIntradayPrice(p.priceSymbol)
    const articleCount = await countArticles(p.ticker)

    let intradayChange = 0
    if (current != null && priorClose != null && priorClose > 0) {
      intradayChange = (current - priorClose) / priorClose
      if (intradayChange <= PRICE_DROP_THRESHOLD) {
        observations.push({
          rule_id: 'price_drop', instrument: p.ticker, direction: 'down',
          // A drop past twice the threshold is materially worse than one that
          // grazes it; the record should say so rather than flattening both.
          severity: intradayChange <= PRICE_DROP_THRESHOLD * 2 ? 'critical' : 'warning',
          observed_value: intradayChange, threshold: PRICE_DROP_THRESHOLD,
          evidence: { company: p.company, currency: p.currency, currentPrice: current, priorClose, source: 'yahoo:chart' },
        })
      }
      // A4 — the PRICE rule was genuinely checked for this instrument.
      evaluated.push({ rule_id: 'price_drop', instrument: p.ticker })
    }
    // A4 — news evidence is only trustworthy when a store was actually
    // available. In the SQLite fallback with the ingestion DB absent,
    // countArticles returns 0, which must NOT read as "no news, resolve it".
    if (newsAvailable) evaluated.push({ rule_id: 'news_velocity', instrument: p.ticker })
    if (articleCount >= NEWS_VELOCITY_THRESHOLD) {
      observations.push({
        rule_id: 'news_velocity', instrument: p.ticker, direction: 'elevated',
        severity: articleCount >= NEWS_VELOCITY_THRESHOLD * 2 ? 'critical' : 'warning',
        observed_value: articleCount, threshold: NEWS_VELOCITY_THRESHOLD,
        evidence: { company: p.company, windowHours: NEWS_WINDOW_HOURS, source: usePostgres() ? 'pg:articles' : 'sqlite:articles' },
      })
    }

  }
  if (ingestionDb) ingestionDb.close()

  // THE AUTHORITATIVE OUTPUT. Written before, and independently of, any
  // notification. The record states that a condition existed; it says nothing
  // about delivery, and nothing downstream may make it conditional on delivery.
  const rec = reconcile(loadAlerts(ALERTS_PATH), observations, evaluated)
  saveAlerts(ALERTS_PATH, rec.file)
  console.log(
    `[alerts] Checked ${positions.length} positions · ${rec.opened.length} opened, ` +
    `${rec.continuing.length} continuing, ${rec.resolved.length} resolved · recorded in ${ALERTS_PATH}`,
  )

}

run()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => { void closePool() })
