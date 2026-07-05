async function fetchPrice(ticker: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
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
    // Prefer live market price, fall back to last close
    const live = result.meta.regularMarketPrice
    if (live && live > 0) return live
    const closes = result.indicators.quote[0]?.close ?? []
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) return closes[i] as number
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
