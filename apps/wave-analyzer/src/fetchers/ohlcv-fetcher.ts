import type { Candle } from '../types.js'

export async function fetchOHLCV(ticker: string): Promise<Candle[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      console.warn(`[ohlcv] ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: {
        result: Array<{
          timestamp: number[]
          indicators: {
            quote: Array<{
              open:   (number | null)[]
              high:   (number | null)[]
              low:    (number | null)[]
              close:  (number | null)[]
              volume: (number | null)[]
            }>
          }
        }> | null
      }
    }
    const result = data.chart.result?.[0]
    if (!result) return null

    const { timestamp, indicators } = result
    const q = indicators.quote[0]
    const candles: Candle[] = []

    for (let i = 0; i < timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]
      if (o == null || h == null || l == null || c == null || v == null) continue
      candles.push({
        date:   new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
        open:   o, high: h, low: l, close: c, volume: v,
      })
    }
    return candles
  } catch (err) {
    console.warn(`[ohlcv] ${ticker}: fetch error`, err)
    return null
  }
}
