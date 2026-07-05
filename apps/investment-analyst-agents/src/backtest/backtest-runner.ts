// Backtest the briefing agent's recommendations against actual price action.
//
// For each archived prediction in archive/predictions.jsonl:
//   1. For each action (buy/trim/hold/exit) at conviction (high/medium/low)
//   2. Look up actual price N days later (7d, 30d, 90d windows)
//   3. Score whether the action's directional bet was correct
//   4. Aggregate accuracy by signal type / conviction / scenario
//
// Outputs a markdown report at backtest/report.md so you know which signals
// to trust and how much to weight them in real decisions.

import 'dotenv/config'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { formatReport } from './backtest-report.js'

interface ActionRecord {
  ticker:              string
  scenarioType:        string
  action:              string
  conviction:          'high' | 'medium' | 'low'
  allocationChangePct: number
}

interface PredictionRecord {
  date:       string  // YYYY-MM-DD
  regime:     string
  confidence: string
  actions:    ActionRecord[]
}

export interface BacktestRow {
  date:        string
  ticker:      string
  action:      string
  conviction:  string
  scenarioType:string
  pctChange:   number  // allocation change recommended
  priceAtCall: number
  priceLater:  number
  windowDays:  number
  return:      number  // % return over window
  correct:     boolean | null  // null = informational only (e.g. 'watch')
}

const ARCHIVE_PATH = join(process.cwd(), 'archive', 'predictions.jsonl')
const REPORT_PATH  = join(process.cwd(), 'backtest', 'report.md')
const CALIB_PATH   = join(process.cwd(), 'backtest', 'calibration.json')
const WINDOWS      = [7, 30, 90] as const

// ── Yahoo Finance historical price fetch ─────────────────────────────────────

async function fetchHistoricalClose(ticker: string, date: string): Promise<number | null> {
  const day = new Date(date)
  if (isNaN(day.getTime())) return null
  // Fetch a 7-day window centered on the target date so we always land on a trading day
  const start = Math.floor((day.getTime() - 3 * 86_400_000) / 1000)
  const end   = Math.floor((day.getTime() + 4 * 86_400_000) / 1000)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const data = await res.json() as {
      chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ close: (number | null)[] }> } }>; error?: { code: string } }
    }
    if (data.chart.error || !data.chart.result?.length) return null
    const result = data.chart.result[0]
    const closes  = result.indicators.quote[0]?.close ?? []
    const targetTs = day.getTime() / 1000
    // Find the trading day at or just before the target date
    let bestIdx = -1
    let bestDiff = Infinity
    for (let i = 0; i < result.timestamp.length; i++) {
      if (result.timestamp[i] > targetTs) continue
      const diff = Math.abs(targetTs - result.timestamp[i])
      if (diff < bestDiff && closes[i] != null) {
        bestDiff = diff
        bestIdx = i
      }
    }
    return bestIdx >= 0 ? closes[bestIdx] : null
  } catch {
    return null
  }
}

// ── Correctness scoring ──────────────────────────────────────────────────────

function scoreAction(action: string, returnPct: number): boolean | null {
  // 'watch' or 'monitor' are informational — no directional bet to score
  const a = action.toLowerCase()
  if (a === 'watch' || a === 'monitor' || a === 'hold') {
    // Hold is correct if price stayed within ±5% (no big missed move)
    if (a === 'hold') return Math.abs(returnPct) < 5
    return null
  }
  // Bullish actions are correct if price went up
  if (a === 'buy' || a === 'add' || a === 'accumulate') return returnPct > 0
  // Bearish actions are correct if price went down
  if (a === 'sell' || a === 'trim' || a === 'exit' || a === 'reduce') return returnPct < 0
  return null  // unknown action
}

// ── Main backtest loop ───────────────────────────────────────────────────────

async function run() {
  if (!existsSync(ARCHIVE_PATH)) {
    console.error(`No predictions archive at ${ARCHIVE_PATH}`)
    process.exit(1)
  }

  const lines = readFileSync(ARCHIVE_PATH, 'utf-8').split('\n').filter(Boolean)
  const predictions: PredictionRecord[] = lines.map(line => JSON.parse(line))
  console.log(`[backtest] Loaded ${predictions.length} prediction record(s)`)

  const rows: BacktestRow[] = []
  const today = Date.now()
  let skipped = 0

  for (const pred of predictions) {
    for (const window of WINDOWS) {
      const callDate = new Date(pred.date)
      const laterDate = new Date(callDate.getTime() + window * 86_400_000)
      // Skip windows that haven't matured yet
      if (laterDate.getTime() > today) { skipped++; continue }

      for (const a of pred.actions) {
        // Only score 'base' scenario actions — they're the model's most likely path
        if (a.scenarioType !== 'base') continue

        const priceAt    = await fetchHistoricalClose(a.ticker, pred.date)
        const priceLater = await fetchHistoricalClose(a.ticker, laterDate.toISOString().slice(0, 10))
        if (priceAt == null || priceLater == null) { skipped++; continue }

        const returnPct = ((priceLater - priceAt) / priceAt) * 100
        const correct   = scoreAction(a.action, returnPct)

        rows.push({
          date:         pred.date,
          ticker:       a.ticker,
          action:       a.action,
          conviction:   a.conviction,
          scenarioType: a.scenarioType,
          pctChange:    a.allocationChangePct,
          priceAtCall:  priceAt,
          priceLater,
          windowDays:   window,
          return:       returnPct,
          correct,
        })
      }
    }
  }

  console.log(`[backtest] Scored ${rows.length} call(s), skipped ${skipped}`)

  const report = formatReport(rows, predictions.length)
  mkdirSync(join(process.cwd(), 'backtest'), { recursive: true })
  writeFileSync(REPORT_PATH, report, 'utf-8')

  // Structured calibration for the briefing prompt to ingest.
  const calibration = computeCalibration(rows, predictions.length)
  writeFileSync(CALIB_PATH, JSON.stringify(calibration, null, 2), 'utf-8')

  console.log(`\nReport: ${REPORT_PATH}`)
  console.log(`Calibration JSON: ${CALIB_PATH}`)
}

interface CalibStats { accuracy: number; calls: number; avgReturn: number }
interface CalibrationJSON {
  generatedAt:          string
  predictionsAnalyzed:  number
  scoredCalls:          number
  windows:              number[]
  byAction:             Record<string, Record<string, CalibStats>>
  byConviction:         Record<string, Record<string, CalibStats>>
  calibrationInverted:  boolean       // true if high < medium accuracy
  highConvictionPenalty:number        // medium accuracy - high accuracy (positive = problem)
  bestEdge:             { signal: string; accuracy: number } | null
  worstSignal:          { signal: string; accuracy: number } | null
}

function computeCalibration(rows: BacktestRow[], totalPredictions: number): CalibrationJSON {
  const scoredRows = rows.filter(r => r.correct !== null)
  const windows = Array.from(new Set(rows.map(r => r.windowDays))).sort((a, b) => a - b)

  function bucket(filter: (r: BacktestRow) => boolean): CalibStats {
    const subset = scoredRows.filter(filter)
    if (subset.length === 0) return { accuracy: 0, calls: 0, avgReturn: 0 }
    return {
      calls:     subset.length,
      accuracy:  subset.filter(r => r.correct).length / subset.length,
      avgReturn: subset.reduce((s, r) => s + r.return, 0) / subset.length,
    }
  }

  const actions = Array.from(new Set(scoredRows.map(r => r.action)))
  const byAction: Record<string, Record<string, CalibStats>> = {}
  for (const a of actions) {
    byAction[a] = {}
    for (const w of windows) {
      byAction[a][`${w}d`] = bucket(r => r.action === a && r.windowDays === w)
    }
  }

  const byConviction: Record<string, Record<string, CalibStats>> = {}
  for (const c of ['high', 'medium', 'low']) {
    byConviction[c] = {}
    for (const w of windows) {
      byConviction[c][`${w}d`] = bucket(r => r.conviction === c && r.windowDays === w)
    }
  }

  // Use the shortest available window for inversion check (most data)
  const shortest = `${Math.min(...windows)}d`
  const high = byConviction.high?.[shortest]?.accuracy ?? 0
  const med  = byConviction.medium?.[shortest]?.accuracy ?? 0
  const calibrationInverted   = high < med && (byConviction.high?.[shortest]?.calls ?? 0) > 0 && (byConviction.medium?.[shortest]?.calls ?? 0) > 0
  const highConvictionPenalty = med - high

  // Best edge = action with highest accuracy and >= 3 calls
  const allActionStats = Object.entries(byAction)
    .flatMap(([a, byW]) => Object.entries(byW).map(([w, s]) => ({ signal: `${a} (${w})`, ...s })))
    .filter(s => s.calls >= 3)
    .sort((x, y) => y.accuracy - x.accuracy)
  const bestEdge    = allActionStats[0] ? { signal: allActionStats[0].signal, accuracy: allActionStats[0].accuracy } : null
  const worstSignal = allActionStats.at(-1) ? { signal: allActionStats.at(-1)!.signal, accuracy: allActionStats.at(-1)!.accuracy } : null

  return {
    generatedAt:           new Date().toISOString().slice(0, 10),
    predictionsAnalyzed:   totalPredictions,
    scoredCalls:           scoredRows.length,
    windows,
    byAction,
    byConviction,
    calibrationInverted,
    highConvictionPenalty,
    bestEdge,
    worstSignal,
  }
}

run().catch(err => { console.error(err); process.exit(1) })
