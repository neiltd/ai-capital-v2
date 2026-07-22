import 'dotenv/config'
import { fetchYahooAsset } from '../fetchers/yahoo-fetcher.js'
import { SECTOR_WATCHLIST } from '../watchlist/sector-tickers.js'
import type { MarketAsset } from '../types.js'

// On-demand sector-rotation check -- deliberately NOT wired into jobs.ts.
// Run whenever asked (`npm run watchlist`), never as part of the daily
// pipeline. Prints to stdout only; writes nothing to disk or Postgres.

const PCT = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const TREND = (t: MarketAsset['trend']) => t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→'

async function run() {
  console.log('[watchlist] Fetching sector ETFs...')

  const results = await Promise.all(
    SECTOR_WATCHLIST.map(c => fetchYahooAsset(c.ticker, c.label, c.category))
  )
  const assets = results.filter((a): a is MarketAsset => a !== null)

  if (assets.length === 0) {
    console.error('[watchlist] No sector data fetched -- all requests failed.')
    process.exit(1)
  }

  const sorted = [...assets].sort((a, b) => b.changePct5d - a.changePct5d)

  const rows = sorted.map((a, i) => ({
    rank:  `${i + 1}`,
    label: a.label,
    tick:  a.ticker,
    close: a.close.toFixed(2),
    d1:    PCT(a.changePct1d),
    d5:    PCT(a.changePct5d),
    d30:   PCT(a.changePct30d),
    tr:    TREND(a.trend),
  }))

  const w = {
    rank:  Math.max(...rows.map(r => r.rank.length), 2),
    label: Math.max(...rows.map(r => r.label.length), 'Sector'.length),
    tick:  Math.max(...rows.map(r => r.tick.length), 'Ticker'.length),
    close: Math.max(...rows.map(r => r.close.length), 'Close'.length),
    d1:    Math.max(...rows.map(r => r.d1.length), '1d'.length),
    d5:    Math.max(...rows.map(r => r.d5.length), '5d'.length),
    d30:   Math.max(...rows.map(r => r.d30.length), '30d'.length),
  }
  const pad = (s: string, len: number) => s.padEnd(len)

  console.log('')
  console.log(
    `${pad('#', w.rank)}  ${pad('Sector', w.label)}  ${pad('Ticker', w.tick)}  ${pad('Close', w.close)}  ${pad('1d', w.d1)}  ${pad('5d', w.d5)}  ${pad('30d', w.d30)}`
  )
  console.log('-'.repeat(w.rank + w.label + w.tick + w.close + w.d1 + w.d5 + w.d30 + 12))
  for (const r of rows) {
    console.log(
      `${pad(r.rank, w.rank)}  ${pad(r.label, w.label)}  ${pad(r.tick, w.tick)}  ${pad(r.close, w.close)}  ${pad(r.d1, w.d1)}  ${pad(r.d5, w.d5)}  ${pad(r.d30, w.d30)}  ${r.tr}`
    )
  }

  const top = sorted[0]
  const bottom = sorted[sorted.length - 1]
  const semis = assets.find(a => a.ticker === 'SMH')
  console.log('')
  console.log(`[watchlist] 5d leader:  ${top.label} (${top.ticker}) ${PCT(top.changePct5d)}`)
  console.log(`[watchlist] 5d laggard: ${bottom.label} (${bottom.ticker}) ${PCT(bottom.changePct5d)}`)
  if (semis) {
    const semisRank = sorted.findIndex(a => a.ticker === 'SMH') + 1
    console.log(`[watchlist] Semis (SMH) rank: ${semisRank}/${sorted.length} (${PCT(semis.changePct5d)} 5d, ${PCT(semis.changePct30d)} 30d)`)
  }
}

run().catch(err => { console.error('[watchlist] Fatal:', err); process.exit(1) })
