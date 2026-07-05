import type { Candle, Pivot } from '../types.js'

export function computeZigzag(candles: Candle[], threshold: number): Pivot[] {
  if (candles.length < 2) return []

  const pivots: Pivot[] = []
  let dir: 1 | -1 = 1   // 1 = up (tracking highs), -1 = down (tracking lows)
  let extIdx = 0
  let extPrice = candles[0].close

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (dir === 1) {
      if (c.high > extPrice) {
        extPrice = c.high
        extIdx = i
      } else if (c.close < extPrice * (1 - threshold)) {
        pivots.push({ date: candles[extIdx].date, price: extPrice, type: 'high' })
        dir = -1
        extPrice = c.low
        extIdx = i
      }
    } else {
      if (c.low < extPrice) {
        extPrice = c.low
        extIdx = i
      } else if (c.close > extPrice * (1 + threshold)) {
        pivots.push({ date: candles[extIdx].date, price: extPrice, type: 'low' })
        dir = 1
        extPrice = c.high
        extIdx = i
      }
    }
  }

  // Trailing unconfirmed pivot at current extreme
  pivots.push({
    date:  candles[extIdx].date,
    price: extPrice,
    type:  dir === 1 ? 'high' : 'low',
  })

  return pivots
}
