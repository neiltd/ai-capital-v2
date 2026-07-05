import type { LiquidityIndicator, LiquiditySignal } from '../types.js'

interface SeriesConfig {
  seriesId:  string
  label:     string
  unit:      string
  limit:     number
  frequency: 'daily' | 'weekly' | 'monthly'
  // FRED delivers WALCL and WTREGEN in Millions; divide by 1000 to get Billions
  scaleToBillions?: boolean
}

const SERIES: SeriesConfig[] = [
  { seriesId: 'WALCL',     label: 'Fed Balance Sheet',        unit: 'Billions USD', limit: 56,  frequency: 'weekly',  scaleToBillions: true  },
  { seriesId: 'WTREGEN',   label: 'Treasury General Account', unit: 'Billions USD', limit: 56,  frequency: 'weekly',  scaleToBillions: true  },
  { seriesId: 'RRPONTSYD', label: 'Overnight Reverse Repo',   unit: 'Billions USD', limit: 365, frequency: 'daily'                          },
  { seriesId: 'M2SL',      label: 'M2 Money Supply',          unit: 'Billions USD', limit: 14,  frequency: 'monthly'                        },
]

export function computeSignal(
  seriesId: string,
  change4w: number | null,
  changeYoY: number | null,
): LiquiditySignal {
  // All change4w values are now % change
  if (seriesId === 'M2SL') {
    if (changeYoY == null) return 'neutral'
    if (changeYoY < -0.5) return 'draining'
    if (changeYoY > 1.0)  return 'injecting'
    return 'neutral'
  }
  if (change4w == null) return 'neutral'
  if (seriesId === 'WALCL') {
    // Fed balance sheet rarely moves ±1% in 4 weeks; ±0.5% is meaningful
    if (change4w < -0.5) return 'draining'
    if (change4w > 0.5)  return 'injecting'
    return 'neutral'
  }
  // WTREGEN and RRPONTSYD: sign is flipped (rising = more draining)
  if (change4w > 15)  return 'draining'
  if (change4w < -15) return 'injecting'
  return 'neutral'
}

function pctChange(latest: number, base: number): number | null {
  if (Math.abs(base) < 0.0001) return null
  return ((latest - base) / Math.abs(base)) * 100
}

async function fetchSeries(config: SeriesConfig): Promise<LiquidityIndicator | null> {
  const key = process.env.FRED_API_KEY ?? ''
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${config.seriesId}&api_key=${key}&sort_order=desc&limit=${config.limit}&file_type=json`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[liquidity] ${config.seriesId}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { observations: Array<{ date: string; value: string }> }
    const validObs = data.observations.filter(o => o.value !== '.')
    const rawValues = validObs.map(o => parseFloat(o.value))
    if (rawValues.length < 1) return null

    // Scale WALCL/WTREGEN from Millions → Billions for consistent display
    const scale  = config.scaleToBillions ? 1000 : 1
    const values = rawValues.map(v => v / scale)

    const value       = values[0]
    const releaseDate = validObs[0]?.date ?? ''

    const idx4w = config.frequency === 'weekly' ? 4
                : config.frequency === 'daily'  ? 28
                : null

    const idxYoY = config.frequency === 'weekly'  ? 52
                 : config.frequency === 'daily'   ? 365
                 : 12

    // change4w is now % change, consistent with changeYoY
    const change4w = idx4w != null && values[idx4w] != null
      ? pctChange(value, values[idx4w])
      : null

    const changeYoY = values[idxYoY] != null
      ? pctChange(value, values[idxYoY])
      : null

    const signal = computeSignal(config.seriesId, change4w, changeYoY)

    return { seriesId: config.seriesId, label: config.label, value, releaseDate, unit: config.unit, change4w, changeYoY, signal }
  } catch (err) {
    console.warn(`[liquidity] ${config.seriesId}: fetch error`, err)
    return null
  }
}

export async function fetchLiquidityIndicators(): Promise<LiquidityIndicator[]> {
  const results = await Promise.all(SERIES.map(fetchSeries))
  return results.filter((r): r is LiquidityIndicator => r !== null)
}
