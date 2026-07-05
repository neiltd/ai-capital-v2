import type { MarketAsset, AssetCategory, Trend } from '../types.js'

interface YahooAssetConfig {
  ticker:   string
  label:    string
  category: AssetCategory
}

export const YAHOO_ASSETS: YahooAssetConfig[] = [
  // US Equity Indices
  { ticker: 'SPY',       label: 'S&P 500',       category: 'us-equity'     },
  { ticker: 'QQQ',       label: 'Nasdaq 100',    category: 'us-equity'     },
  { ticker: 'IWM',       label: 'Russell 2000',  category: 'us-equity'     },
  // Rates
  { ticker: '^TNX',      label: 'US 10Y Yield',  category: 'rates'         },
  { ticker: '^FVX',      label: 'US 5Y Yield',   category: 'rates'         },
  // Dollar
  { ticker: 'DX-Y.NYB',  label: 'Dollar Index',  category: 'dollar'        },
  // Commodities
  { ticker: 'CL=F',      label: 'WTI Crude Oil', category: 'commodities'   },
  { ticker: 'GC=F',      label: 'Gold',          category: 'commodities'   },
  { ticker: 'HG=F',      label: 'Copper',        category: 'commodities'   },
  // Volatility
  { ticker: '^VIX',      label: 'VIX',           category: 'volatility'    },
  // Global Equity
  { ticker: '^N225',     label: 'Nikkei 225',    category: 'global-equity' },
  { ticker: '^GDAXI',    label: 'DAX',           category: 'global-equity' },
  { ticker: '^HSI',      label: 'Hang Seng',     category: 'global-equity' },
  // Credit
  { ticker: 'HYG',       label: 'HYG',           category: 'credit'        },
]

const RATE_TICKERS = new Set(['^TNX', '^FVX'])

function computeTrend(changePct5d: number, ticker: string, change5dAbs: number): Trend {
  if (RATE_TICKERS.has(ticker)) {
    const bps = change5dAbs * 100
    if (bps > 5)  return 'rising'
    if (bps < -5) return 'falling'
    return 'stable'
  }
  if (changePct5d > 0.5)  return 'rising'
  if (changePct5d < -0.5) return 'falling'
  return 'stable'
}

export async function fetchYahooAsset(
  ticker: string,
  label: string,
  category: AssetCategory,
): Promise<MarketAsset | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=60d`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) {
      console.warn(`[yahoo] ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: { result: Array<{ indicators: { quote: Array<{ close: (number | null)[] }> } }> | null; error: unknown }
    }
    const result = data.chart.result?.[0]
    if (!result) return null

    const closes = (result.indicators.quote[0]?.close ?? []).filter((c): c is number => c !== null && c !== undefined)
    if (closes.length < 2) return null

    const close     = closes[closes.length - 1]
    const prev1d    = closes[closes.length - 2]
    const prev5d    = closes[Math.max(0, closes.length - 6)]
    const prev30d   = closes[Math.max(0, closes.length - 31)]

    const change1d     = close - prev1d
    const changePct1d  = (change1d / prev1d) * 100
    const changePct5d  = ((close - prev5d) / prev5d) * 100
    const changePct30d = ((close - prev30d) / prev30d) * 100
    const trend        = computeTrend(changePct5d, ticker, close - prev5d)

    return {
      ticker,
      label,
      category,
      close:        parseFloat(close.toFixed(4)),
      change1d:     parseFloat(change1d.toFixed(4)),
      changePct1d:  parseFloat(changePct1d.toFixed(2)),
      changePct5d:  parseFloat(changePct5d.toFixed(2)),
      changePct30d: parseFloat(changePct30d.toFixed(2)),
      trend,
    }
  } catch (err) {
    console.warn(`[yahoo] ${ticker}: fetch error`, err)
    return null
  }
}

export async function fetchAllYahooAssets(): Promise<MarketAsset[]> {
  const results = await Promise.all(
    YAHOO_ASSETS.map(a => fetchYahooAsset(a.ticker, a.label, a.category))
  )
  return results.filter((r): r is MarketAsset => r !== null)
}
