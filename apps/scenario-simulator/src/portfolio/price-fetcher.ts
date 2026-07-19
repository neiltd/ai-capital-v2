// Thai mutual/RMF/ThaiESG fund NAVs (e.g. K-VIETNAM, K-ESGSI-ThaiESG) aren't
// on Yahoo Finance at all — they're not exchange-listed, so every Yahoo
// lookup 404s. Finnomena's public (no-auth) API serves real daily NAV for
// these; short_code -> fund_id comes from a lookup table the user pulled
// from Finnomena's own fund master list (see data/finnomena-fund-ids.json —
// ~7150 funds, load-bearing but not exhaustive: employer-specific provident
// funds like PFM009 aren't public retail funds and won't be in it or on
// Finnomena at all, so they correctly fail this lookup and fall through to
// returning null, same as any other unpriceable ticker).
import finnomenaFundIds from './finnomena-fund-ids.json' with { type: 'json' }

const FUND_ID_BY_TICKER = finnomenaFundIds as Record<string, string>

// Finnomena's official fund codes use inconsistent casing (e.g.
// "K-ESGSI-ThaiESG"), while this app's tickers are stored all-caps
// ("K-ESGSI-THAIESG") — a case-sensitive lookup silently misses for any
// fund whose real code isn't already all-caps. Build a case-insensitive
// index once at module load so ticker casing never matters here.
const FUND_ID_BY_TICKER_UPPER: Record<string, string> = {}
for (const [key, value] of Object.entries(FUND_ID_BY_TICKER)) {
  FUND_ID_BY_TICKER_UPPER[key.toUpperCase()] = value
}

async function fetchFinnomenaPrice(ticker: string): Promise<number | null> {
  const fundId = FUND_ID_BY_TICKER_UPPER[ticker.toUpperCase()]
  if (!fundId) return null
  const url = `https://www.finnomena.com/fn3/api/fund/v2/public/funds/${encodeURIComponent(fundId)}/latest`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' } })
    if (!res.ok) {
      console.warn(`Finnomena price fetch failed for ${ticker} (fund_id ${fundId}): HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { status: boolean; data?: { value?: number } }
    const nav = data.status ? data.data?.value : undefined
    if (typeof nav === 'number' && nav > 0) return nav
    console.warn(`Finnomena price fetch returned no usable NAV for ${ticker} (fund_id ${fundId})`)
    return null
  } catch (error) {
    console.warn(`Finnomena price fetch error for ${ticker}:`, error)
    return null
  }
}

async function fetchPrice(ticker: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      // Yahoo has no listing for Thai mutual/RMF/ThaiESG fund codes — try
      // Finnomena's NAV feed before giving up.
      const finnomenaPrice = await fetchFinnomenaPrice(ticker)
      if (finnomenaPrice !== null) return finnomenaPrice
      console.warn(`Price fetch failed for ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: {
        result: Array<{
          meta: { regularMarketPrice?: number; previousClose?: number }
          timestamp: number[]
          indicators: { quote: Array<{ close: (number | null)[] }> }
        }> | null
        error?: { code: string; description: string }
      }
    }
    if (data.chart.error) {
      console.warn(`Price fetch error for ${ticker}: ${data.chart.error.description}`)
      return null
    }
    const result = data.chart.result?.[0]
    if (!result) return null
    const previousClose = result.meta.previousClose

    // Sanity check — Yahoo occasionally returns a garbage regularMarketPrice
    // (bad upstream tick, stale cache, ticker collision). A >60% single-day
    // move against the same response's previousClose is implausible for the
    // kind of equities this system trades; reject rather than silently book
    // it. This is exactly the class of bug that corrupted the KLAC discovery
    // position on 2026-06-02 (avg_cost $2003 vs a real price near $230) —
    // caught only a month later because nothing validated the fetch.
    function plausible(price: number): boolean {
      if (!previousClose || previousClose <= 0) return true // nothing to compare against
      return Math.abs(price - previousClose) / previousClose <= 0.6
    }

    // Prefer live market price, fall back to last close
    const live = result.meta.regularMarketPrice
    if (live && live > 0) {
      if (!plausible(live)) {
        console.warn(`Price fetch rejected for ${ticker}: regularMarketPrice ${live} implausible vs previousClose ${previousClose}`)
        return null
      }
      return live
    }
    const closes = result.indicators.quote[0]?.close ?? []
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        const c = closes[i] as number
        if (!plausible(c)) {
          console.warn(`Price fetch rejected for ${ticker}: last close ${c} implausible vs previousClose ${previousClose}`)
          return null
        }
        return c
      }
    }
    return null
  } catch (error) {
    console.warn(`Price fetch error for ${ticker}:`, error)
    return null
  }
}

export async function fetchPrices(tickers: string[]): Promise<Record<string, number>> {
  if (tickers.length === 0) return {}
  const unique = [...new Set(tickers.filter(t => t && t.length > 0))]
  const results = await Promise.all(
    unique.map(async ticker => ({ ticker, price: await fetchPrice(ticker) }))
  )
  const result: Record<string, number> = {}
  for (const { ticker, price } of results) {
    if (price !== null) result[ticker] = price
  }
  return result
}

export interface PricesWithFx {
  prices:   Record<string, number>
  /** USD/THB exchange rate from Yahoo Finance THB=X (THB per 1 USD). null if unavailable. */
  usdThb:   number | null
  fetchedAt: string
}

/**
 * Fetches Yahoo Finance quotes for the given symbols. If `includeFx` is true
 * (or any THB-quoted asset is detected via .BK / =X / known proxy tickers),
 * also fetches USD/THB so the caller can show values in both currencies.
 */
export async function fetchPricesAndFx(
  symbols: string[],
  options: { includeFx?: boolean } = {},
): Promise<PricesWithFx> {
  const all = [...new Set(symbols.filter(s => s && s.length > 0))]
  const wantFx = options.includeFx ?? all.some(s =>
    s.endsWith('.BK') || s === 'THB=X' || s === '000300.SS' || s === '^VNINDEX' || s === '^NSEI'
  )

  const toFetch = wantFx && !all.includes('THB=X') ? [...all, 'THB=X'] : all
  const prices  = await fetchPrices(toFetch)
  const usdThb  = prices['THB=X'] ?? null
  // Remove THB=X from the returned price map; callers expect only asset prices.
  if ('THB=X' in prices) delete prices['THB=X']

  return { prices, usdThb, fetchedAt: new Date().toISOString() }
}
