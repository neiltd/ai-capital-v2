import type { EconomicIndicator, IndicatorCategory, Trend } from '../types.js'

interface FredSeriesConfig {
  seriesId:  string
  label:     string
  category:  IndicatorCategory
  unit:      string
  frequency: 'monthly' | 'quarterly'  // monthly: YoY=12 periods back; quarterly: YoY=4 periods back
}

export const FRED_SERIES: FredSeriesConfig[] = [
  { seriesId: 'CPIAUCSL',   label: 'CPI YoY %',            category: 'inflation', unit: 'Percent',   frequency: 'monthly'   },
  { seriesId: 'JTSJOL',     label: 'JOLTS Job Openings',   category: 'labour',    unit: 'Thousands', frequency: 'monthly'   },
  { seriesId: 'UNRATE',     label: 'Unemployment Rate',    category: 'labour',    unit: 'Percent',   frequency: 'monthly'   },
  { seriesId: 'UMCSENT',    label: 'Consumer Sentiment',   category: 'consumer',  unit: 'Index',     frequency: 'monthly'   },
  { seriesId: 'DRCCLACBS',  label: 'CC Delinquency Rate',  category: 'credit',    unit: 'Percent',   frequency: 'quarterly' },
  { seriesId: 'DRSFRMACBS', label: 'Mortgage Delinquency', category: 'credit',    unit: 'Percent',   frequency: 'quarterly' },
]

function computeTrend(latest: number, previous: number): Trend {
  const diff = latest - previous
  const relativeDiff = Math.abs(previous) > 0.001 ? Math.abs(diff / previous) : Math.abs(diff)
  if (relativeDiff < 0.005) return 'stable'
  return diff > 0 ? 'rising' : 'falling'
}

function pctChange(latest: number, base: number): number | null {
  if (Math.abs(base) < 0.0001) return null
  return ((latest - base) / Math.abs(base)) * 100
}

export async function fetchFredSeries(
  seriesId:  string,
  label:     string,
  category:  IndicatorCategory,
  unit:      string,
  frequency: 'monthly' | 'quarterly',
): Promise<EconomicIndicator | null> {
  const key = process.env.FRED_API_KEY ?? ''
  const limit = 14  // covers 14 months or 14 quarters — enough for both YoY and QoQ
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&sort_order=desc&limit=${limit}&file_type=json`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[fred] ${seriesId}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { observations: Array<{ date: string; value: string }> }
    const valid = data.observations.filter(o => o.value !== '.').map(o => parseFloat(o.value))
    if (valid.length < 1) return null

    const value    = valid[0]
    const trend    = valid[1] != null ? computeTrend(value, valid[1]) : 'stable'
    const yoyIdx   = frequency === 'monthly' ? 12 : 4
    const changeQoQ = valid[1]     != null ? pctChange(value, valid[1])     : null
    const changeYoY = valid[yoyIdx] != null ? pctChange(value, valid[yoyIdx]) : null

    const releaseDate = data.observations.filter(o => o.value !== '.')[0]?.date ?? ''

    return { seriesId, label, category, value, releaseDate, unit, trend, changeQoQ, changeYoY }
  } catch (err) {
    console.warn(`[fred] ${seriesId}: fetch error`, err)
    return null
  }
}

export async function fetchAllFredSeries(): Promise<EconomicIndicator[]> {
  const results = await Promise.all(
    FRED_SERIES.map(s => fetchFredSeries(s.seriesId, s.label, s.category, s.unit, s.frequency))
  )
  return results.filter((r): r is EconomicIndicator => r !== null)
}
