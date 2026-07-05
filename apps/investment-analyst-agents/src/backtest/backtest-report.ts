// Format backtest rows into a markdown report aggregating accuracy by
// signal type, conviction, time horizon, and action.

import type { BacktestRow } from './backtest-runner.js'

interface Bucket {
  total:       number  // rows where correct is non-null (excluded informational)
  correct:     number
  avgReturn:   number
  totalReturn: number
}

function emptyBucket(): Bucket {
  return { total: 0, correct: 0, avgReturn: 0, totalReturn: 0 }
}

function add(bucket: Bucket, row: BacktestRow) {
  if (row.correct === null) return
  bucket.total++
  if (row.correct) bucket.correct++
  bucket.totalReturn += row.return
  bucket.avgReturn = bucket.totalReturn / bucket.total
}

function accuracy(b: Bucket): string {
  if (b.total === 0) return 'n/a'
  return `${((b.correct / b.total) * 100).toFixed(1)}%`
}

function avgRet(b: Bucket): string {
  if (b.total === 0) return 'n/a'
  return `${b.avgReturn >= 0 ? '+' : ''}${b.avgReturn.toFixed(2)}%`
}

export function formatReport(rows: BacktestRow[], totalPredictions: number): string {
  const today = new Date().toISOString().slice(0, 10)

  // ── Aggregate by various dimensions ─────────────────────────────────────
  const byAction:     Record<string, Record<number, Bucket>> = {}
  const byConviction: Record<string, Record<number, Bucket>> = {}
  const overall:      Record<number, Bucket>                  = {}

  for (const r of rows) {
    overall[r.windowDays]      ??= emptyBucket()
    add(overall[r.windowDays], r)

    byAction[r.action]              ??= {}
    byAction[r.action][r.windowDays] ??= emptyBucket()
    add(byAction[r.action][r.windowDays], r)

    byConviction[r.conviction]              ??= {}
    byConviction[r.conviction][r.windowDays] ??= emptyBucket()
    add(byConviction[r.conviction][r.windowDays], r)
  }

  const windows = Array.from(new Set(rows.map(r => r.windowDays))).sort((a, b) => a - b)

  // ── Header ──────────────────────────────────────────────────────────────
  const out: string[] = [
    `# Briefing Backtest Report`,
    `**Generated:** ${today}`,
    `**Predictions analyzed:** ${totalPredictions}`,
    `**Scored calls (excluding informational holds/watches):** ${rows.filter(r => r.correct !== null).length}`,
    '',
    `> Methodology: each base-case action is scored against the actual price move`,
    `> over 7/30/90 day windows. Buy = correct if price ↑. Trim/Exit = correct if`,
    `> price ↓. Hold = correct if price within ±5%. Watch/Monitor = informational.`,
    '',
    '---',
    '',
  ]

  // ── Overall accuracy ────────────────────────────────────────────────────
  out.push('## Overall accuracy by window\n')
  out.push('| Window | Calls | Correct | Accuracy | Avg Return |')
  out.push('|---|---|---|---|---|')
  for (const w of windows) {
    const b = overall[w] ?? emptyBucket()
    out.push(`| ${w}d | ${b.total} | ${b.correct} | ${accuracy(b)} | ${avgRet(b)} |`)
  }
  out.push('')

  // ── By action type ──────────────────────────────────────────────────────
  out.push('## By action type\n')
  out.push('| Action | ' + windows.map(w => `${w}d accuracy`).join(' | ') + ' |')
  out.push('|---' + windows.map(() => '|---').join('') + '|')
  for (const action of Object.keys(byAction).sort()) {
    const cells = windows.map(w => accuracy(byAction[action][w] ?? emptyBucket()))
    out.push(`| ${action} | ${cells.join(' | ')} |`)
  }
  out.push('')

  // ── By conviction ───────────────────────────────────────────────────────
  out.push('## By conviction\n')
  out.push('| Conviction | ' + windows.map(w => `${w}d accuracy`).join(' | ') + ' |')
  out.push('|---' + windows.map(() => '|---').join('') + '|')
  for (const c of ['high', 'medium', 'low']) {
    const cells = windows.map(w => accuracy(byConviction[c]?.[w] ?? emptyBucket()))
    out.push(`| ${c} | ${cells.join(' | ')} |`)
  }
  out.push('')

  // ── Conviction calibration check ────────────────────────────────────────
  out.push('## Calibration — do "high" calls outperform "medium"?\n')
  out.push('| Window | High % | Medium % | Low % | Calibrated? |')
  out.push('|---|---|---|---|---|')
  for (const w of windows) {
    const h = byConviction.high?.[w] ?? emptyBucket()
    const m = byConviction.medium?.[w] ?? emptyBucket()
    const l = byConviction.low?.[w] ?? emptyBucket()
    const calibrated = (h.total === 0 || m.total === 0) ? '—'
      : (h.correct / h.total) >= (m.correct / m.total) ? '✅ Yes' : '❌ No (inverted)'
    out.push(`| ${w}d | ${accuracy(h)} | ${accuracy(m)} | ${accuracy(l)} | ${calibrated} |`)
  }
  out.push('')

  // ── Top winners / losers ────────────────────────────────────────────────
  const longWindow = Math.max(...windows)
  const longRows   = rows.filter(r => r.windowDays === longWindow && r.correct !== null)
  longRows.sort((a, b) => b.return - a.return)

  out.push(`## Top 10 best ${longWindow}d returns\n`)
  out.push('| Date | Ticker | Action | Conv. | Return | Correct? |')
  out.push('|---|---|---|---|---|---|')
  for (const r of longRows.slice(0, 10)) {
    out.push(`| ${r.date} | ${r.ticker} | ${r.action} | ${r.conviction} | ${avgRet({ total: 1, correct: 0, avgReturn: r.return, totalReturn: r.return })} | ${r.correct ? '✅' : '❌'} |`)
  }
  out.push('')

  out.push(`## Top 10 worst ${longWindow}d returns\n`)
  out.push('| Date | Ticker | Action | Conv. | Return | Correct? |')
  out.push('|---|---|---|---|---|---|')
  for (const r of longRows.slice(-10).reverse()) {
    out.push(`| ${r.date} | ${r.ticker} | ${r.action} | ${r.conviction} | ${avgRet({ total: 1, correct: 0, avgReturn: r.return, totalReturn: r.return })} | ${r.correct ? '✅' : '❌'} |`)
  }
  out.push('')

  // ── Recommendation ──────────────────────────────────────────────────────
  out.push('## Interpretation hints\n')
  out.push('- Accuracy <50% means the signal is worse than a coin flip → distrust or invert')
  out.push('- Calibration ❌ means high-conviction calls did NOT outperform medium → adjust the model')
  out.push('- Top winners/losers help spot systematic biases (e.g. always wrong on a sector)')
  out.push('')

  return out.join('\n')
}
