import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync } from 'fs'
import { createTradePortfolio } from '../portfolio/trade-portfolio.js'
import type { WavesJSON } from '../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '../../data/trades.db')
const WAVES_PATH = join(__dirname, '../../data/waves.json')

// ANSI color helpers
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

function colorize(text: string, positive: boolean): string {
  return (positive ? GREEN : RED) + text + RESET
}

// ---------- Flag parsing ----------

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.slice(2, eqIdx)
        const value = arg.slice(eqIdx + 1)
        flags[key] = value
      } else {
        // --key value
        const key = arg.slice(2)
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[i + 1]
          i++
        } else {
          flags[key] = 'true'
        }
      }
    }
  }
  return flags
}

function requireFlags(flags: Record<string, string>, required: string[]): void {
  const missing = required.filter(k => flags[k] === undefined || flags[k] === '')
  if (missing.length > 0) {
    console.error(`Missing required flags: ${missing.map(k => `--${k}`).join(', ')}`)
    printUsage()
    process.exit(1)
  }
}

function printUsage(): void {
  console.error(`
Usage:
  npm run trade -- open  --ticker=<TICKER> --entry=<price> --stop=<price> --target=<price> --shares=<n>
  npm run trade -- close --id=<uuid> --price=<closePrice>
  npm run trade -- list
`.trim())
}

// ---------- Current price lookup ----------

function getCurrentPrices(): Record<string, number> {
  if (!existsSync(WAVES_PATH)) return {}
  try {
    const data: WavesJSON = JSON.parse(readFileSync(WAVES_PATH, 'utf8'))
    const prices: Record<string, number> = {}
    for (const asset of data.assets) {
      if (asset.candles && asset.candles.length > 0) {
        prices[asset.ticker] = asset.candles[asset.candles.length - 1].close
      }
    }
    return prices
  } catch {
    return {}
  }
}

// ---------- Subcommands ----------

function cmdOpen(flags: Record<string, string>): void {
  requireFlags(flags, ['ticker', 'entry', 'stop', 'target', 'shares'])

  const ticker = flags.ticker.trim().toUpperCase()
  if (!ticker) {
    printUsage()
    console.error('--ticker must be a non-empty value')
    process.exit(1)
  }

  const entryPrice = parseFloat(flags.entry)
  const stopLoss = parseFloat(flags.stop)
  const target = parseFloat(flags.target)
  const shares = parseFloat(flags.shares)

  if ([entryPrice, stopLoss, target, shares].some(isNaN)) {
    console.error('All numeric flags (--entry, --stop, --target, --shares) must be valid numbers.')
    process.exit(1)
  }

  if (shares <= 0) {
    printUsage()
    console.error('--shares must be a positive number')
    process.exit(1)
  }

  const portfolio = createTradePortfolio(DB_PATH)
  let success = false
  try {
    const trade = portfolio.openTrade({
      ticker,
      signal: 'buy',
      entryPrice,
      stopLoss,
      target,
      shares,
      openedAt: new Date().toISOString(),
    })
    console.log(
      `Opened trade: ${trade.id} | BUY ${shares} ${ticker} @ $${entryPrice} | Stop $${stopLoss} | Target $${target}`
    )
    success = true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${msg}`)
  } finally {
    portfolio.close()
  }
  if (!success) process.exit(1)
}

function cmdClose(flags: Record<string, string>): void {
  requireFlags(flags, ['id', 'price'])

  const id = flags.id
  const closePrice = parseFloat(flags.price)

  if (isNaN(closePrice)) {
    console.error('--price must be a valid number.')
    process.exit(1)
  }

  const portfolio = createTradePortfolio(DB_PATH)
  let success = false
  try {
    const trade = portfolio.closeTrade(id, closePrice)
    const pnl = trade.pnl ?? 0
    const pnlStr = pnl >= 0
      ? colorize(`+$${pnl.toFixed(2)}`, true)
      : colorize(`-$${Math.abs(pnl).toFixed(2)}`, false)
    console.log(`Closed trade: ${trade.ticker} | ${trade.signal.toUpperCase()} | P&L: ${pnlStr}`)
    success = true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${msg}`)
  } finally {
    portfolio.close()
  }
  if (!success) process.exit(1)
}

function cmdList(): void {
  const portfolio = createTradePortfolio(DB_PATH)
  try {
    const positions = portfolio.getOpenPositions()
    if (positions.length === 0) {
      console.log('No open positions.')
      return
    }

    const prices = getCurrentPrices()

    // Header
    const header = [
      'ID'.padEnd(8),
      'Ticker'.padEnd(8),
      'Signal'.padEnd(6),
      'Entry'.padStart(10),
      'Stop'.padStart(10),
      'Target'.padStart(10),
      'Shares'.padStart(8),
      'CurPrice'.padStart(10),
      'UnrealPnL'.padStart(12),
    ].join('  ')
    console.log(header)
    console.log('-'.repeat(header.length))

    for (const pos of positions) {
      const curPrice = prices[pos.ticker]
      const curPriceStr = curPrice !== undefined ? `$${curPrice.toFixed(2)}` : 'N/A'

      let unrealPnLStr = 'N/A'
      if (curPrice !== undefined) {
        const unrealPnL = pos.signal === 'buy'
          ? (curPrice - pos.entryPrice) * pos.shares
          : (pos.entryPrice - curPrice) * pos.shares
        unrealPnLStr = unrealPnL >= 0
          ? colorize(`+$${unrealPnL.toFixed(2)}`, true)
          : colorize(`-$${Math.abs(unrealPnL).toFixed(2)}`, false)
      }

      const row = [
        pos.id.slice(0, 8).padEnd(8),
        pos.ticker.padEnd(8),
        pos.signal.padEnd(6),
        `$${pos.entryPrice}`.padStart(10),
        `$${pos.stopLoss}`.padStart(10),
        `$${pos.target}`.padStart(10),
        `${pos.shares}`.padStart(8),
        curPriceStr.padStart(10),
        unrealPnLStr,
      ].join('  ')
      console.log(row)
    }
  } finally {
    portfolio.close()
  }
}

// ---------- Main ----------

const args = process.argv.slice(2)
const subcommand = args[0]
const flags = parseFlags(args.slice(1))

switch (subcommand) {
  case 'open':
    cmdOpen(flags)
    break
  case 'close':
    cmdClose(flags)
    break
  case 'list':
    cmdList()
    break
  default:
    console.error(`Unknown subcommand: ${subcommand ?? '(none)'}`)
    printUsage()
    process.exit(1)
}
