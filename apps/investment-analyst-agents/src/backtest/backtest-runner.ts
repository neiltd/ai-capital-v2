// Backtest the briefing agent's recommendations against actual price action.
//
// WHERE THE HISTORY COMES FROM. `cli-brief` writes every prediction to
// `briefing.predictions` whenever `DATABASE_URL` is set, so in production that
// table IS the corpus and `archive/predictions.jsonl` is a legacy file that
// stops being written the moment Postgres is configured. Reading the JSONL in
// production therefore scored a frozen snapshot, and on a checkout without the
// ignored file it exited 1 before scoring anything. Postgres is now the source
// of record whenever it is selected, and the JSONL remains only for the
// offline/legacy path where no `DATABASE_URL` exists.
//
// For each archived prediction:
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
import { closePool, getPool, usePostgres } from '@common/db'
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

export async function fetchHistoricalClose(ticker: string, date: string): Promise<number | null> {
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
      chart: {
        result?: Array<{
          timestamp: number[]
          indicators: {
            quote:    Array<{ close: (number | null)[] }>
            adjclose: Array<{ adjclose: (number | null)[] }>
          }
        }>
        error?: { code: string }
      }
    }
    if (data.chart.error || !data.chart.result?.length) return null
    const result = data.chart.result[0]
    // adjclose (split/dividend-adjusted), not raw close — a corporate action
    // inside the scored window would otherwise show up as a fake price cliff.
    // See docs/superpowers/specs/2026-07-15-backtest-signal-decay-design.md
    const closes  = result.indicators.adjclose[0]?.adjclose ?? []
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

// ── WHERE THE PREDICTION CORPUS COMES FROM ──────────────────────────────────

/**
 * ONE RECORD, VALIDATED AT THE BOUNDARY.
 *
 * Both sources are outside this module's control: a JSONB column somebody else
 * wrote and a legacy file on disk. The scorer reads `date` and, per action,
 * `ticker`, `scenarioType`, `action`, `conviction` and `allocationChangePct`, so
 * every one of those is checked here rather than trusted and crashed on later.
 *
 * ERRORS NAME THE FIELD, NEVER THE VALUE. These rows carry portfolio positions
 * and model reasoning; an exception that pasted the record into a log or a CI
 * transcript would leak them. The location plus the expected shape is enough to
 * fix the data, and is all that is said.
 */
function validatedPrediction(raw: unknown, where: string): PredictionRecord {
  const bad = (field: string, expected: string): never => {
    throw new Error(`${where}: ${field} is not ${expected}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad('the record', 'an object')
  }
  const r = raw as Record<string, unknown>
  if (typeof r.date !== 'string' || r.date === '') bad('date', 'a non-empty string')
  if (typeof r.regime !== 'string') bad('regime', 'a string')
  if (typeof r.confidence !== 'string') bad('confidence', 'a string')
  if (!Array.isArray(r.actions)) bad('actions', 'an array')

  const actions = (r.actions as unknown[]).map((a, i): ActionRecord => {
    const at = (field: string, expected: string): never =>
      bad(`actions[${String(i)}].${field}`, expected)
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      return at('', 'an object') as never
    }
    const o = a as Record<string, unknown>
    if (typeof o.ticker !== 'string' || o.ticker === '') at('ticker', 'a non-empty string')
    if (typeof o.scenarioType !== 'string') at('scenarioType', 'a string')
    if (typeof o.action !== 'string') at('action', 'a string')
    if (o.conviction !== 'high' && o.conviction !== 'medium' && o.conviction !== 'low') {
      at('conviction', 'one of high, medium, low')
    }
    if (typeof o.allocationChangePct !== 'number' || !Number.isFinite(o.allocationChangePct)) {
      at('allocationChangePct', 'a finite number')
    }
    return {
      ticker: o.ticker as string,
      scenarioType: o.scenarioType as string,
      action: o.action as string,
      conviction: o.conviction as ActionRecord['conviction'],
      allocationChangePct: o.allocationChangePct as number,
    }
  })

  return {
    date: r.date as string,
    regime: r.regime as string,
    confidence: r.confidence as string,
    actions,
  }
}

/**
 * THE CORPUS, FROM WHICHEVER STORE IS ACTUALLY IN USE.
 *
 * FAIL CLOSED ONCE POSTGRES IS CHOSEN. `usePostgres()` selects the store before
 * a single row is read, and a query or validation failure from then on is
 * reported as itself. Falling back to the JSONL here would silently score a
 * stale snapshot and call it today's calibration - a wrong answer presented as
 * a right one, which is worse than no report at all.
 *
 * `date::text` because the scorer does its own date arithmetic on `YYYY-MM-DD`;
 * letting the driver hand back a `Date` would re-introduce a local-timezone
 * shift. `actions` is read as the JSONB value the writer stored, not re-parsed.
 */
export async function loadPredictions(archivePath: string): Promise<PredictionRecord[]> {
  if (usePostgres()) {
    try {
      const { rows } = await getPool().query<{
        date: string; regime: string; confidence: string; actions: unknown
      }>(
        `SELECT date::text AS date, regime, confidence, actions
           FROM briefing.predictions
          ORDER BY date`,
      )
      return rows.map((row, i) => validatedPrediction(row, `briefing.predictions row ${String(i + 1)}`))
    } finally {
      // OWNED HERE, SO CLOSED HERE, on the way out either way. Nothing else in
      // this command touches Postgres - the price lookups are HTTP.
      await closePool()
    }
  }

  // THE OFFLINE/LEGACY PATH, unchanged: only reachable when no DATABASE_URL is
  // configured, and only then is a missing file a reason to refuse.
  if (!existsSync(archivePath)) {
    throw new Error(`No predictions archive at ${archivePath}`)
  }
  const lines = readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean)
  return lines.map((line, i) => {
    const where = `${archivePath} line ${String(i + 1)}`
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`${where}: the line is not JSON`)
    }
    return validatedPrediction(parsed, where)
  })
}

// ── Main backtest loop ───────────────────────────────────────────────────────

async function run() {
  const predictions = await loadPredictions(ARCHIVE_PATH)
  console.log(
    `[backtest] Loaded ${predictions.length} prediction record(s) from ` +
    `${usePostgres() ? 'briefing.predictions' : ARCHIVE_PATH}`,
  )

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

  // Structured calibration computed first so its decay findings can be
  // rendered into the markdown report below.
  const calibration = computeCalibration(rows, predictions.length)

  const report = formatReport(rows, predictions.length, calibration.decaying, calibration.decayWindowPredictions)
  mkdirSync(join(process.cwd(), 'backtest'), { recursive: true })
  writeFileSync(REPORT_PATH, report, 'utf-8')
  writeFileSync(CALIB_PATH, JSON.stringify(calibration, null, 2), 'utf-8')

  console.log(`\nReport: ${REPORT_PATH}`)
  console.log(`Calibration JSON: ${CALIB_PATH}`)
}

export interface CalibStats { accuracy: number; calls: number; avgReturn: number }
export interface DecayEntry {
  signal:          string
  allTimeAccuracy: number
  recentAccuracy:  number
  allTimeCalls:    number
  recentCalls:     number
}
export interface CalibrationJSON {
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
  decayWindowPredictions: number
  decaying:               DecayEntry[]
}

export function computeCalibration(rows: BacktestRow[], totalPredictions: number): CalibrationJSON {
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

  // Signal decay: compare each bucket's all-time accuracy against just the
  // most recent RECENT_PREDICTIONS_WINDOW prediction dates. Flags only when
  // both slices have enough calls to be meaningful — with 44 predictions and
  // heavily skewed action counts (buy/trim: 5-17 calls total), a fixed
  // calendar window would produce noise on the thin buckets.
  const RECENT_PREDICTIONS_WINDOW = 15
  const MIN_CALLS_FOR_DECAY       = 3
  const DECAY_THRESHOLD_PP        = 15

  const recentDates = new Set(
    Array.from(new Set(scoredRows.map(r => r.date))).sort().slice(-RECENT_PREDICTIONS_WINDOW)
  )

  function bucketRecent(filter: (r: BacktestRow) => boolean): CalibStats {
    return bucket(r => filter(r) && recentDates.has(r.date))
  }

  function toDecayEntry(signal: string, allTime: CalibStats, recent: CalibStats): DecayEntry | null {
    if (allTime.calls < MIN_CALLS_FOR_DECAY || recent.calls < MIN_CALLS_FOR_DECAY) return null
    const dropPP = (allTime.accuracy - recent.accuracy) * 100
    if (dropPP < DECAY_THRESHOLD_PP) return null
    return {
      signal,
      allTimeAccuracy: allTime.accuracy,
      recentAccuracy:  recent.accuracy,
      allTimeCalls:    allTime.calls,
      recentCalls:     recent.calls,
    }
  }

  const decaying: DecayEntry[] = []
  for (const a of actions) {
    for (const w of windows) {
      const entry = toDecayEntry(
        `${a} (${w}d)`,
        byAction[a][`${w}d`],
        bucketRecent(r => r.action === a && r.windowDays === w),
      )
      if (entry) decaying.push(entry)
    }
  }
  for (const c of ['high', 'medium', 'low']) {
    for (const w of windows) {
      const entry = toDecayEntry(
        `${c} (${w}d)`,
        byConviction[c][`${w}d`],
        bucketRecent(r => r.conviction === c && r.windowDays === w),
      )
      if (entry) decaying.push(entry)
    }
  }
  decaying.sort((x, y) => (y.allTimeAccuracy - y.recentAccuracy) - (x.allTimeAccuracy - x.recentAccuracy))

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
    decayWindowPredictions: RECENT_PREDICTIONS_WINDOW,
    decaying,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(err => { console.error(err); process.exit(1) })
}
