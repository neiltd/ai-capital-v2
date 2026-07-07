import 'dotenv/config'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import Database from 'better-sqlite3'
import { usePostgres, getPool, closePool } from '@common/db'

const ROOT             = join(process.cwd(), '..')
// SQLite fallback only — see the note on loadDb() below. Production (Postgres)
// never touches this path.
const PORTFOLIO_DB     = join(ROOT, 'scenario-simulator/data/portfolio.db')
const SIMULATION_JSON  = join(ROOT, 'scenario-simulator/data/simulation.json')
const TRADE_LOG        = join(process.cwd(), 'data/trade-log.jsonl')
const FINANCIALDATA_KEY = process.env.FINANCIALDATA_API_KEY ?? ''

interface SimAction {
  id: string
  runId: string
  scenarioId: string
  ticker: string
  action: 'buy' | 'hold' | 'trim' | 'exit'
  conviction: string
  allocationChangePct: number
  rationale: string
  createdAt: string
}

interface SimScenario {
  id: string
  scenarioType: 'best' | 'base' | 'disruption' | 'whatif'
  probability: number
}

interface DbRow {
  ticker: string
  company: string
  shares: number
  avg_cost: number
  current_price: number
  current_value: number
  unrealized_pnl: number
  updated_at: string
}

async function fetchPrice(ticker: string): Promise<number | null> {
  if (!FINANCIALDATA_KEY) return null
  try {
    const url = `https://financialdata.net/api/v1/stock-prices?identifier=${encodeURIComponent(ticker)}&key=${encodeURIComponent(FINANCIALDATA_KEY)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json() as unknown
    const items: unknown[] = Array.isArray(data) ? data : ((data as { data?: unknown[] }).data ?? [])
    const latest = items[0] as { close?: number } | undefined
    return typeof latest?.close === 'number' ? latest.close : null
  } catch {
    return null
  }
}

async function fetchPrices(tickers: string[]): Promise<Record<string, number>> {
  const pairs = await Promise.all(tickers.map(async t => ({ t, p: await fetchPrice(t) })))
  const result: Record<string, number> = {}
  for (const { t, p } of pairs) { if (p !== null) result[t] = p }
  return result
}

// ── Portfolio data access ────────────────────────────────────────────────────
// Same usePostgres()-gated pattern as risk-runner.ts/correlation-runner.ts/
// tax-harvest-runner.ts — this file executes real trades, so it must never
// silently fall back to the stale local portfolio.db when Postgres (the live
// store) is the intended target.

interface ActStore {
  getPosition(ticker: string): Promise<DbRow | undefined>
  insertNewPosition(ticker: string, shares: number, price: number): Promise<void>
  trimPosition(ticker: string, sharesAfter: number, price: number): Promise<void>
  deletePosition(ticker: string): Promise<void>
  buyMorePosition(ticker: string, sharesAfter: number, newAvgCost: number, price: number): Promise<void>
  getAllPositions(): Promise<PositionRow[]>
  close(): Promise<void>
}

type PositionRow = {
  ticker: string; company: string; shares: number; avgCost: number
  currentPrice: number; currentValue: number; unrealizedPnl: number; updatedAt: string
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

function createPgActStore(): ActStore {
  const pool = getPool()
  return {
    async getPosition(ticker) {
      const { rows } = await pool.query<{
        ticker: string; company: string; shares: string; avg_cost: string
        current_price: string; current_value: string; unrealized_pnl: string; updated_at: Date
      }>('SELECT ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at FROM portfolio.positions WHERE ticker = $1', [ticker])
      const r = rows[0]
      if (!r) return undefined
      return {
        ticker: r.ticker, company: r.company, shares: num(r.shares), avg_cost: num(r.avg_cost),
        current_price: num(r.current_price), current_value: num(r.current_value),
        unrealized_pnl: num(r.unrealized_pnl), updated_at: r.updated_at.toISOString(),
      }
    },
    async insertNewPosition(ticker, shares, price) {
      await pool.query(
        `INSERT INTO portfolio.positions (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at)
         VALUES ($1, $1, $2, $3, $3, $2 * $3, 0, now())`,
        [ticker, shares, price],
      )
    },
    async trimPosition(ticker, sharesAfter, price) {
      await pool.query(
        `UPDATE portfolio.positions SET
           shares = $1, current_price = $2, current_value = $1 * $2,
           unrealized_pnl = ($1 * $2) - ($1 * avg_cost), updated_at = now()
         WHERE ticker = $3`,
        [sharesAfter, price, ticker],
      )
    },
    async deletePosition(ticker) {
      await pool.query('DELETE FROM portfolio.positions WHERE ticker = $1', [ticker])
    },
    async buyMorePosition(ticker, sharesAfter, newAvgCost, price) {
      await pool.query(
        `UPDATE portfolio.positions SET
           shares = $1, avg_cost = $2, current_price = $3, current_value = $1 * $3,
           unrealized_pnl = ($1 * $3) - ($1 * $2), updated_at = now()
         WHERE ticker = $4`,
        [sharesAfter, newAvgCost, price, ticker],
      )
    },
    async getAllPositions() {
      const { rows } = await pool.query<{
        ticker: string; company: string; shares: string; avg_cost: string
        current_price: string; current_value: string; unrealized_pnl: string; updated_at: Date
      }>('SELECT ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at FROM portfolio.positions ORDER BY ticker')
      return rows.map(r => ({
        ticker: r.ticker, company: r.company, shares: num(r.shares), avgCost: num(r.avg_cost),
        currentPrice: num(r.current_price), currentValue: num(r.current_value),
        unrealizedPnl: num(r.unrealized_pnl), updatedAt: r.updated_at.toISOString(),
      }))
    },
    async close() {
      // Shared pool — closed centrally in run()'s finally block via closePool().
    },
  }
}

function createSqliteActStore(): ActStore {
  // fileMustExist: true — see portfolio-store-sqlite.ts. This file executes
  // real trades; if the expected data/portfolio.db is missing (e.g. renamed
  // away as stale) it must error, not silently start writing into a fresh
  // empty database.
  const db = new Database(PORTFOLIO_DB, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  return {
    async getPosition(ticker) {
      return db.prepare('SELECT * FROM positions WHERE ticker = ?').get(ticker) as DbRow | undefined
    },
    async insertNewPosition(ticker, shares, price) {
      db.prepare(`
        INSERT INTO positions (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ticker, ticker, shares, price, price, shares * price, 0, new Date().toISOString())
    },
    async trimPosition(ticker, sharesAfter, price) {
      db.prepare(`
        UPDATE positions SET
          shares = ?, current_price = ?, current_value = ? * ?,
          unrealized_pnl = (? * ?) - (? * avg_cost), updated_at = ?
        WHERE ticker = ?
      `).run(sharesAfter, price, sharesAfter, price, sharesAfter, price, sharesAfter, new Date().toISOString(), ticker)
    },
    async deletePosition(ticker) {
      db.prepare('DELETE FROM positions WHERE ticker = ?').run(ticker)
    },
    async buyMorePosition(ticker, sharesAfter, newAvgCost, price) {
      db.prepare(`
        UPDATE positions SET
          shares = ?, avg_cost = ?, current_price = ?, current_value = ? * ?,
          unrealized_pnl = (? * ?) - (? * ?), updated_at = ?
        WHERE ticker = ?
      `).run(sharesAfter, newAvgCost, price, sharesAfter, price, sharesAfter, price, sharesAfter, newAvgCost, new Date().toISOString(), ticker)
    },
    async getAllPositions() {
      const rows = db.prepare('SELECT * FROM positions ORDER BY ticker').all() as PositionRowSqlite[]
      return rows.map(r => ({
        ticker: r.ticker, company: r.company, shares: r.shares, avgCost: r.avg_cost,
        currentPrice: r.current_price, currentValue: r.current_value,
        unrealizedPnl: r.unrealized_pnl, updatedAt: r.updated_at,
      }))
    },
    async close() { db.close() },
  }
}

type PositionRowSqlite = { ticker: string; company: string; shares: number; avg_cost: number; current_price: number; current_value: number; unrealized_pnl: number; updated_at: string }

function createActStore(): ActStore {
  return usePostgres() ? createPgActStore() : createSqliteActStore()
}

function hasActedToday(date: string): boolean {
  if (!existsSync(TRADE_LOG)) return false
  const lines = readFileSync(TRADE_LOG, 'utf-8').trim().split('\n').filter(Boolean)
  return lines.some(l => {
    try { return (JSON.parse(l) as { date?: string }).date === date } catch { return false }
  })
}

async function run() {
  const today = new Date().toISOString().slice(0, 10)
  console.log(`[act] Running portfolio actions for ${today}`)

  if (hasActedToday(today)) {
    console.log(`[act] Actions already applied for ${today} — skipping`)
    return
  }

  if (!existsSync(SIMULATION_JSON)) {
    console.error('[act] simulation.json not found — run npm run simulate first')
    process.exit(1)
  }

  const sim = JSON.parse(readFileSync(SIMULATION_JSON, 'utf-8')) as {
    scenarios: SimScenario[]
    actions: SimAction[]
    portfolio: unknown[]
  }

  // Use base scenario (highest probability among base-type)
  const baseScenario = sim.scenarios
    .filter(s => s.scenarioType === 'base')
    .sort((a, b) => b.probability - a.probability)[0]

  if (!baseScenario) {
    console.error('[act] No base scenario found in simulation.json')
    process.exit(1)
  }

  console.log(`[act] Using base scenario: ${baseScenario.id.slice(0, 8)}... (prob=${baseScenario.probability}%)`)

  // Filter to base scenario actions that are not hold
  const activeActions = sim.actions.filter(
    a => a.scenarioId === baseScenario.id && a.action !== 'hold'
  )

  if (activeActions.length === 0) {
    console.log('[act] No actionable steps in base scenario today — all hold')
    appendTradeLog(TRADE_LOG, { date: today, type: 'no-op', message: 'all hold in base scenario' })
    return
  }

  console.log(`[act] Actionable: ${activeActions.map(a => `${a.ticker}(${a.action})`).join(', ')}`)

  // Fetch current prices for affected tickers
  const tickers = activeActions.map(a => a.ticker)
  console.log(`[act] Fetching prices for: ${tickers.join(', ')}`)
  const prices = await fetchPrices(tickers)

  const store = createActStore()

  try {
    const trades: object[] = []

    for (const act of activeActions) {
      const row = await store.getPosition(act.ticker)

      if (!row) {
        // buy into a new position
        if (act.action === 'buy') {
          const price = prices[act.ticker]
          if (!price) {
            console.warn(`[act] No price for ${act.ticker} — skip buy`)
            continue
          }
          // Default allocation: $1000 for new positions
          const allocation = 1000
          const shares = parseFloat((allocation / price).toFixed(4))
          await store.insertNewPosition(act.ticker, shares, price)
          console.log(`[act] BUY new: ${act.ticker} ${shares} shares @ $${price}`)
          trades.push({ date: today, ticker: act.ticker, action: 'buy', type: 'new', sharesBefore: 0, sharesAfter: shares, avgCostAfter: price, price, value: shares * price, conviction: act.conviction })
        } else {
          console.log(`[act] ${act.ticker} not in portfolio — skipping ${act.action}`)
        }
        continue
      }

      const price = prices[act.ticker] ?? row.current_price

      if (act.action === 'trim') {
        const trimFraction = Math.abs(act.allocationChangePct) / 100
        const sharesRemoved = row.shares * trimFraction
        const sharesAfter = parseFloat((row.shares - sharesRemoved).toFixed(6))
        if (sharesAfter < 0.0001) {
          await store.deletePosition(act.ticker)
          console.log(`[act] TRIM→EXIT: ${act.ticker} trimmed to near-zero, removed`)
          trades.push({ date: today, ticker: act.ticker, action: 'exit', type: 'trim-full', sharesBefore: row.shares, sharesAfter: 0, price, value: 0, conviction: act.conviction })
        } else {
          await store.trimPosition(act.ticker, sharesAfter, price)
          const value = parseFloat((sharesAfter * price).toFixed(2))
          console.log(`[act] TRIM ${act.allocationChangePct}%: ${act.ticker} ${row.shares.toFixed(4)} → ${sharesAfter.toFixed(4)} shares, value $${value}`)
          trades.push({ date: today, ticker: act.ticker, action: 'trim', pct: act.allocationChangePct, sharesBefore: row.shares, sharesAfter, avgCost: row.avg_cost, price, value, conviction: act.conviction, rationale: act.rationale.slice(0, 120) })
        }

      } else if (act.action === 'exit') {
        await store.deletePosition(act.ticker)
        const exitValue = parseFloat((row.shares * price).toFixed(2))
        console.log(`[act] EXIT: ${act.ticker} ${row.shares.toFixed(4)} shares @ $${price} = $${exitValue}`)
        trades.push({ date: today, ticker: act.ticker, action: 'exit', sharesBefore: row.shares, sharesAfter: 0, price, value: exitValue, conviction: act.conviction, rationale: act.rationale.slice(0, 120) })

      } else if (act.action === 'buy') {
        const addFraction = act.allocationChangePct / 100
        const addValue = row.current_value * addFraction
        if (!price || price <= 0) {
          console.warn(`[act] No price for ${act.ticker} — skip buy`)
          continue
        }
        const addShares = parseFloat((addValue / price).toFixed(6))
        const sharesAfter = parseFloat((row.shares + addShares).toFixed(6))
        const newAvgCost = parseFloat(((row.shares * row.avg_cost + addShares * price) / sharesAfter).toFixed(4))
        await store.buyMorePosition(act.ticker, sharesAfter, newAvgCost, price)
        const value = parseFloat((sharesAfter * price).toFixed(2))
        console.log(`[act] BUY +${act.allocationChangePct}%: ${act.ticker} ${row.shares.toFixed(4)} → ${sharesAfter.toFixed(4)} shares @ avg $${newAvgCost}`)
        trades.push({ date: today, ticker: act.ticker, action: 'buy', pct: act.allocationChangePct, sharesBefore: row.shares, sharesAfter, avgCostAfter: newAvgCost, price, value, conviction: act.conviction, rationale: act.rationale.slice(0, 120) })
      }
    }

    // Re-export simulation.json with updated portfolio
    const updatedPositions = await store.getAllPositions()

    const updatedSim = { ...sim, exportedAt: new Date().toISOString(), portfolio: updatedPositions }
    writeFileSync(SIMULATION_JSON, JSON.stringify(updatedSim, null, 2), 'utf-8')
    console.log(`[act] simulation.json updated`)

    // Append all trades to trade log
    for (const t of trades) {
      appendTradeLog(TRADE_LOG, t)
    }

    console.log(`[act] Done — ${trades.length} trade(s) executed, logged to ${TRADE_LOG}`)
  } finally {
    await store.close()
  }
}

function appendTradeLog(path: string, entry: object) {
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
}

run()
  .catch(err => { console.error('[act] Fatal:', err); process.exit(1) })
  .finally(() => { if (usePostgres()) return closePool() })
