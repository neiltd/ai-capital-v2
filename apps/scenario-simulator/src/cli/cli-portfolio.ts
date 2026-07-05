import 'dotenv/config'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, readFileSync } from 'fs'
import { createPortfolioStore } from '../portfolio/portfolio-store.js'
import { fetchPrices, fetchPricesAndFx } from '../portfolio/price-fetcher.js'
import type { AssetClass, Currency } from '../types.js'

// Anchor paths to the package root (this file's location) rather than cwd.
// Running `pnpm portfolio …` from the workspace root used to create an orphan
// `data/portfolio.db` at the root because cwd-based resolution put it there
// instead of in `apps/scenario-simulator/data/`. With this fix the trade log
// always writes to the canonical SQLite that tax-harvest reads.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA_DIR     = join(PACKAGE_ROOT, 'data')
const GRAPH_PATH   = join(PACKAGE_ROOT, '..', 'dependency-graph-engine', 'data', 'graph.json')
mkdirSync(DATA_DIR, { recursive: true })

const args    = process.argv.slice(2)
const command = args[0]
const store   = createPortfolioStore(join(DATA_DIR, 'portfolio.db'))

const VALID_CLASSES: AssetClass[]    = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']
const VALID_CURRENCIES: Currency[]   = ['USD', 'THB']

// Default proxy symbols for Thai funds / gold so users don't need --symbol every time.
const DEFAULT_PROXY_SYMBOL: Record<string, string> = {
  SCBCEH:     '000300.SS',
  'K-VIETNAM':'^VNINDEX',
  KVIETNAM:   '^VNINDEX',
  'KFINDIA-A':'^NSEI',
  KFINDIA:    '^NSEI',
  GOLD_MTS:   'GC=F',
}

interface ParsedArgs {
  positional: string[]
  flags:      Record<string, string>
}

function parseArgs(raw: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = raw[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function inferAssetClass(ticker: string): AssetClass {
  const upper = ticker.toUpperCase()
  if (upper.startsWith('CASH_')) return 'cash'
  if (upper.startsWith('GOLD'))  return 'gold'
  if (upper.endsWith('.BK'))     return 'th_equity'
  if (upper in DEFAULT_PROXY_SYMBOL) return 'th_fund'
  return 'us_equity'
}

function inferCurrency(assetClass: AssetClass, ticker: string): Currency {
  if (assetClass === 'us_equity') return 'USD'
  if (ticker.toUpperCase() === 'CASH_USD') return 'USD'
  return 'THB'
}

function inferPriceSymbol(assetClass: AssetClass, ticker: string): string {
  if (assetClass === 'cash') return ''
  const upper = ticker.toUpperCase()
  if (upper in DEFAULT_PROXY_SYMBOL) return DEFAULT_PROXY_SYMBOL[upper]
  if (assetClass === 'us_equity' || assetClass === 'th_equity') return ticker
  return ''
}

function lookupCompany(ticker: string): string {
  try {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
    const node  = (graph.nodes as Array<{ ticker: string; company: string }>).find(n => n.ticker === ticker)
    if (node) return node.company
  } catch { /* fallback */ }
  return ticker
}

function classLabel(c: AssetClass): string {
  switch (c) {
    case 'us_equity': return 'US Equity'
    case 'th_equity': return 'Thai Equity'
    case 'th_fund':   return 'Asian Fund'
    case 'gold':      return 'Gold'
    case 'cash':      return 'Cash'
  }
}

async function run() {
  const { positional, flags } = parseArgs(args.slice(1))

  if (command === 'set') {
    const [ticker, sharesStr, avgCostStr] = positional
    if (!ticker || !sharesStr || !avgCostStr) {
      console.error('Usage: npm run portfolio -- set <TICKER> <shares> <avgCost> [--class <c>] [--currency <c>] [--symbol <yahoo>]')
      console.error('  classes:    us_equity | th_equity | th_fund | gold | cash')
      console.error('  currencies: USD | THB')
      process.exit(1)
    }
    const shares  = parseFloat(sharesStr)
    const avgCost = parseFloat(avgCostStr)
    if (isNaN(shares) || isNaN(avgCost)) {
      console.error('shares and avgCost must be numbers')
      process.exit(1)
    }

    const explicitClass = flags['class'] as AssetClass | undefined
    if (explicitClass && !VALID_CLASSES.includes(explicitClass)) {
      console.error(`Invalid --class. Must be one of: ${VALID_CLASSES.join(', ')}`)
      process.exit(1)
    }
    const explicitCurrency = flags['currency'] as Currency | undefined
    if (explicitCurrency && !VALID_CURRENCIES.includes(explicitCurrency)) {
      console.error(`Invalid --currency. Must be one of: ${VALID_CURRENCIES.join(', ')}`)
      process.exit(1)
    }

    const assetClass  = explicitClass    ?? inferAssetClass(ticker)
    const currency    = explicitCurrency ?? inferCurrency(assetClass, ticker)
    const priceSymbol = flags['symbol']  ?? inferPriceSymbol(assetClass, ticker)
    const company     = assetClass === 'us_equity' ? lookupCompany(ticker) : ticker

    await store.upsertPosition(ticker, company, shares, avgCost, { assetClass, currency, priceSymbol })

    const symLabel = priceSymbol ? ` priced via ${priceSymbol}` : ' (manual price)'
    const priceTag = currency === 'THB' ? `฿${avgCost.toFixed(2)}` : `$${avgCost.toFixed(2)}`
    console.log(`Position set: ${ticker} — ${shares} ${classLabel(assetClass)} @ ${priceTag} avg (${currency})${symLabel}`)

  } else if (command === 'remove') {
    const [ticker] = positional
    if (!ticker) {
      console.error('Usage: npm run portfolio -- remove <TICKER>')
      process.exit(1)
    }
    await store.removePosition(ticker.toUpperCase())
    console.log(`Position removed: ${ticker.toUpperCase()}`)

  } else if (command === 'strategy') {
    // npm run portfolio -- strategy <TICKER> <tactical|dca|tax_locked>
    const [ticker, strategyArg] = positional
    const VALID: Array<'tactical' | 'dca' | 'tax_locked'> = ['tactical', 'dca', 'tax_locked']
    if (!ticker || !strategyArg || !VALID.includes(strategyArg as typeof VALID[number])) {
      console.error(`Usage: npm run portfolio -- strategy <TICKER> <${VALID.join('|')}>`)
      console.error('  tactical   — default; brief can recommend exit on weak short-term signal')
      console.error('  dca        — long-term DCA; brief only recommends exit on broken thesis')
      console.error('  tax_locked — tax-deduction lock-in; brief never recommends exit, only "add" or "pause"')
      process.exit(1)
    }
    await store.setStrategy(ticker.toUpperCase(), strategyArg as typeof VALID[number])
    console.log(`Strategy set: ${ticker.toUpperCase()} → ${strategyArg}`)

  } else if (command === 'log') {
    // npm run portfolio -- log <buy|sell> <TICKER> <shares> <price> [reason...]
    const [action, ticker, sharesStr, priceStr, ...reasonParts] = positional
    if (!action || !ticker || !sharesStr || !priceStr || !['buy', 'sell'].includes(action)) {
      console.error('Usage: npm run portfolio -- log <buy|sell> <TICKER> <shares> <price> [reason]')
      process.exit(1)
    }
    const shares = parseFloat(sharesStr)
    const price  = parseFloat(priceStr)
    if (isNaN(shares) || isNaN(price)) {
      console.error('shares and price must be numbers')
      process.exit(1)
    }
    const reason = reasonParts.join(' ')
    await store.logTrade(action as 'buy' | 'sell', ticker, shares, price, reason)
    console.log(`Trade logged: ${action.toUpperCase()} ${shares} ${ticker.toUpperCase()} @ $${price.toFixed(4)}${reason ? ` — "${reason}"` : ''}`)

  } else if (command === 'review') {
    const log = await store.getTradeLog()
    if (log.length === 0) {
      console.log('No trades logged yet. Use: npm run portfolio -- log <buy|sell> <TICKER> <shares> <price> [reason]')
      return
    }

    // Fetch current prices for all unique tickers
    const tickers = [...new Set(log.map(t => t.ticker))]
    const prices  = await fetchPrices(tickers)
    if (Object.keys(prices).length > 0) await store.updateTradeCurrentPrices(prices)

    const fresh = await store.getTradeLog()

    console.log('\nTrade Decision Review\n')
    console.log('Date        Action  Ticker   Shares     Trade $     Now $       Change    Verdict  Reason')
    console.log('----------  ------  -------  ---------  ----------  ----------  --------  -------  -------')

    for (const t of fresh) {
      const now      = t.currentPrice > 0 ? `$${t.currentPrice.toFixed(2)}` : 'N/A'
      const pct      = t.currentPrice > 0 ? `${t.pctChange >= 0 ? '+' : ''}${t.pctChange.toFixed(1)}%` : 'N/A'

      // For buys: good if price went UP (you bought low). For sells: good if price went DOWN (you sold high).
      let verdict = '  —  '
      if (t.currentPrice > 0) {
        const good = t.action === 'buy' ? t.pctChange > 0 : t.pctChange < 0
        const great = t.action === 'buy' ? t.pctChange > 5 : t.pctChange < -5
        verdict = great ? '✓ GREAT' : good ? '✓ GOOD ' : t.pctChange === 0 ? ' FLAT  ' : '✗ MISS '
      }

      const reason = t.reason ? t.reason.slice(0, 30) : ''
      console.log(
        `${t.date}  ${t.action.toUpperCase().padEnd(6)}  ${t.ticker.padEnd(7)}  ${String(t.shares).padEnd(9)}  ` +
        `$${t.price.toFixed(4).padEnd(10)} ${now.padEnd(11)} ${pct.padEnd(9)} ${verdict}  ${reason}`
      )
    }
    console.log()

  } else if (command === 'show') {
    const positions = await store.getPositions()
    if (positions.length > 0) {
      // Cash positions hold their own price (1). Everything else uses priceSymbol.
      const symbols = positions
        .filter(p => p.assetClass !== 'cash' && p.priceSymbol)
        .map(p => p.priceSymbol)
      const { prices, usdThb } = await fetchPricesAndFx(symbols)

      // Map prices back onto tickers (priceSymbol may differ for funds/gold).
      const priceMap: Record<string, number> = {}
      for (const p of positions) {
        if (p.assetClass === 'cash') {
          priceMap[p.ticker] = 1
        } else if (p.priceSymbol && prices[p.priceSymbol] !== undefined) {
          priceMap[p.ticker] = prices[p.priceSymbol]
        }
      }
      if (Object.keys(priceMap).length > 0) await store.updatePrices(priceMap)

      if (usdThb) console.log(`FX: 1 USD = ${usdThb.toFixed(4)} THB`)
    }
    const fresh = await store.getPositions()
    if (fresh.length === 0) {
      console.log('No positions. Use: npm run portfolio -- set <TICKER> <shares> <avgCost>')
    } else {
      const totalValue = fresh.reduce((sum, p) => sum + p.currentValue, 0)
      const totalPnl   = fresh.reduce((sum, p) => sum + p.unrealizedPnl, 0)

      console.log('\nPortfolio:\n')
      console.log('Ticker    Class       Cur  Shares     Avg Cost     Price        Holding      P&L')
      console.log('--------  ----------  ---  ---------  -----------  -----------  -----------  -----------')
      for (const p of fresh) {
        const pnl = p.unrealizedPnl >= 0 ? `+${p.unrealizedPnl.toFixed(2)}` : `${p.unrealizedPnl.toFixed(2)}`
        console.log(
          `${p.ticker.padEnd(9)} ${classLabel(p.assetClass).padEnd(11)} ${p.currency.padEnd(4)} ${String(p.shares).padEnd(10)} ${p.avgCost.toFixed(2).padEnd(12)} ${p.currentPrice.toFixed(2).padEnd(12)} ${p.currentValue.toFixed(2).padEnd(12)} ${pnl}`
        )
      }
      const totalPnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : `${totalPnl.toFixed(2)}`
      console.log('--------  ----------  ---  ---------  -----------  -----------  -----------  -----------')
      console.log(`${'TOTAL*'.padEnd(9)} ${' '.padEnd(11)} ${' '.padEnd(4)} ${' '.padEnd(10)} ${' '.padEnd(12)} ${' '.padEnd(12)} ${totalValue.toFixed(2).padEnd(12)} ${totalPnlStr}`)
      console.log('* Total mixes currencies — see dashboard for currency-normalized totals.')
    }

  } else {
    console.log('Usage:')
    console.log('  npm run portfolio -- set <TICKER> <shares> <avgCost> [--class <c>] [--currency <c>] [--symbol <yahoo>]')
    console.log('  npm run portfolio -- remove <TICKER>')
    console.log('  npm run portfolio -- log <buy|sell> <TICKER> <shares> <price> [reason]')
    console.log('  npm run portfolio -- review')
    console.log('  npm run portfolio -- show')
    console.log('')
    console.log('Examples:')
    console.log('  npm run portfolio -- set NVDA 10 450                                     # US equity (default)')
    console.log('  npm run portfolio -- set SCB.BK 500 134.50 --class th_equity --currency THB')
    console.log('  npm run portfolio -- set KFINDIA-A 1000 12.50 --class th_fund --currency THB')
    console.log('  npm run portfolio -- set GOLD_MTS 2 69550 --class gold --currency THB')
    console.log('  npm run portfolio -- set CASH_THB 50000 1 --class cash --currency THB')
    console.log('  npm run portfolio -- set CASH_USD 5000 1 --class cash --currency USD')
  }
}

run()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => store.close())
