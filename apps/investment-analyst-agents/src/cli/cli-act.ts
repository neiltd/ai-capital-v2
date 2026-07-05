import 'dotenv/config'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import Database from 'better-sqlite3'

const ROOT             = join(process.cwd(), '..')
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

  const db = new Database(PORTFOLIO_DB)
  db.pragma('journal_mode = WAL')

  try {
    const trades: object[] = []

    for (const act of activeActions) {
      const row = db.prepare('SELECT * FROM positions WHERE ticker = ?').get(act.ticker) as DbRow | undefined

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
          db.prepare(`
            INSERT INTO positions (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(act.ticker, act.ticker, shares, price, price, shares * price, 0, new Date().toISOString())
          console.log(`[act] BUY new: ${act.ticker} ${shares} shares @ $${price}`)
          trades.push({ date: today, ticker: act.ticker, action: 'buy', type: 'new', sharesBefore: 0, sharesAfter: shares, avgCostAfter: price, price, value: shares * price, conviction: act.conviction })
        } else {
          console.log(`[act] ${act.ticker} not in portfolio — skipping ${act.action}`)
        }
        continue
      }

      const price = prices[act.ticker] ?? row.current_price
      const now = new Date().toISOString()

      if (act.action === 'trim') {
        const trimFraction = Math.abs(act.allocationChangePct) / 100
        const sharesRemoved = row.shares * trimFraction
        const sharesAfter = parseFloat((row.shares - sharesRemoved).toFixed(6))
        if (sharesAfter < 0.0001) {
          db.prepare('DELETE FROM positions WHERE ticker = ?').run(act.ticker)
          console.log(`[act] TRIM→EXIT: ${act.ticker} trimmed to near-zero, removed`)
          trades.push({ date: today, ticker: act.ticker, action: 'exit', type: 'trim-full', sharesBefore: row.shares, sharesAfter: 0, price, value: 0, conviction: act.conviction })
        } else {
          db.prepare(`
            UPDATE positions SET
              shares         = ?,
              current_price  = ?,
              current_value  = ? * ?,
              unrealized_pnl = (? * ?) - (? * avg_cost),
              updated_at     = ?
            WHERE ticker = ?
          `).run(sharesAfter, price, sharesAfter, price, sharesAfter, price, sharesAfter, now, act.ticker)
          const value = parseFloat((sharesAfter * price).toFixed(2))
          console.log(`[act] TRIM ${act.allocationChangePct}%: ${act.ticker} ${row.shares.toFixed(4)} → ${sharesAfter.toFixed(4)} shares, value $${value}`)
          trades.push({ date: today, ticker: act.ticker, action: 'trim', pct: act.allocationChangePct, sharesBefore: row.shares, sharesAfter, avgCost: row.avg_cost, price, value, conviction: act.conviction, rationale: act.rationale.slice(0, 120) })
        }

      } else if (act.action === 'exit') {
        db.prepare('DELETE FROM positions WHERE ticker = ?').run(act.ticker)
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
        db.prepare(`
          UPDATE positions SET
            shares         = ?,
            avg_cost       = ?,
            current_price  = ?,
            current_value  = ? * ?,
            unrealized_pnl = (? * ?) - (? * ?),
            updated_at     = ?
          WHERE ticker = ?
        `).run(sharesAfter, newAvgCost, price, sharesAfter, price, sharesAfter, price, sharesAfter, newAvgCost, now, act.ticker)
        const value = parseFloat((sharesAfter * price).toFixed(2))
        console.log(`[act] BUY +${act.allocationChangePct}%: ${act.ticker} ${row.shares.toFixed(4)} → ${sharesAfter.toFixed(4)} shares @ avg $${newAvgCost}`)
        trades.push({ date: today, ticker: act.ticker, action: 'buy', pct: act.allocationChangePct, sharesBefore: row.shares, sharesAfter, avgCostAfter: newAvgCost, price, value, conviction: act.conviction, rationale: act.rationale.slice(0, 120) })
      }
    }

    // Re-export simulation.json with updated portfolio
    type PositionRow = { ticker: string; company: string; shares: number; avg_cost: number; current_price: number; current_value: number; unrealized_pnl: number; updated_at: string }
    const updatedPositions = (db.prepare('SELECT * FROM positions ORDER BY ticker').all() as PositionRow[]).map(r => ({
      ticker:        r.ticker,
      company:       r.company,
      shares:        r.shares,
      avgCost:       r.avg_cost,
      currentPrice:  r.current_price,
      currentValue:  r.current_value,
      unrealizedPnl: r.unrealized_pnl,
      updatedAt:     r.updated_at,
    }))

    const updatedSim = { ...sim, exportedAt: new Date().toISOString(), portfolio: updatedPositions }
    writeFileSync(SIMULATION_JSON, JSON.stringify(updatedSim, null, 2), 'utf-8')
    console.log(`[act] simulation.json updated`)

    // Append all trades to trade log
    for (const t of trades) {
      appendTradeLog(TRADE_LOG, t)
    }

    console.log(`[act] Done — ${trades.length} trade(s) executed, logged to ${TRADE_LOG}`)
  } finally {
    db.close()
  }
}

function appendTradeLog(path: string, entry: object) {
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
}

run().catch(err => { console.error('[act] Fatal:', err); process.exit(1) })
