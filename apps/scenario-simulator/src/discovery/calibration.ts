// Discovery calibration loop (P3 — see
// docs/discovery-agent-enhancement-proposal-2026-07-06.md). Mirrors the
// main briefing's self-calibration pattern (backtest-runner.ts →
// calibration.json → briefing-agent.ts's SELF-CALIBRATION RULE), which has
// demonstrable teeth there (calibrationInverted: true, 18.5pp penalty,
// visibly changed briefing output). Discovery had no equivalent — a 0-100
// score that never gets checked against realized outcome. The 2026-07-06
// reset (closePosition() + benchmark capture at open/close) makes this
// possible for the first time; there is no historical data before that.
import type { DiscoveryPosition, DiscoveryClosedPosition } from './types.js'

export type ScoreBand = '90+' | '80-89' | '70-79'

// Below this many observations in a band, render "insufficient data" rather
// than a percentage that looks precise but isn't — the honest-emptiness rule
// from the proposal. Matches P3's explicit guidance to resist acting on n=3.
export const MIN_N_FOR_VERDICT = 5

export interface BandStats {
  n: number
  winRate: number | null       // closed positions only; null if n === 0
  avgReturnPct: number | null  // realized return, closed positions only
  avgReturnVsSpyPct: number | null // realized return minus SPY return over the same holding period; null if benchmarks unavailable
}

export interface ProvisionalBandStats {
  n: number
  avgUnrealizedReturnPct: number | null
  avgUnrealizedVsSpyPct: number | null
}

export interface DiscoveryCalibration {
  generatedAt: string
  closedPositionsAnalyzed: number
  openPositionsProvisional: number
  byScoreBand: Record<ScoreBand, BandStats>
  byConviction: Record<'high' | 'medium' | 'low', BandStats>
  provisionalByScoreBand: Record<ScoreBand, ProvisionalBandStats>
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return '90+'
  if (score >= 80) return '80-89'
  return '70-79'
}

function returnPct(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function closedStatsFor(positions: DiscoveryClosedPosition[]): BandStats {
  const n = positions.length
  if (n === 0) return { n: 0, winRate: null, avgReturnPct: null, avgReturnVsSpyPct: null }

  const returns = positions.map(p => returnPct(p.avgCost, p.exitPrice))
  const wins = positions.filter(p => p.exitPrice > p.avgCost).length

  const vsSpy = positions
    .filter(p => p.benchmarkPriceAtOpen != null && p.benchmarkPriceAtClose != null && p.benchmarkPriceAtOpen > 0)
    .map(p => returnPct(p.avgCost, p.exitPrice) - returnPct(p.benchmarkPriceAtOpen!, p.benchmarkPriceAtClose!))

  return {
    n,
    winRate: wins / n,
    avgReturnPct: mean(returns),
    avgReturnVsSpyPct: vsSpy.length > 0 ? mean(vsSpy) : null,
  }
}

function provisionalStatsFor(positions: DiscoveryPosition[], currentSpyPrice: number | null): ProvisionalBandStats {
  const n = positions.length
  if (n === 0) return { n: 0, avgUnrealizedReturnPct: null, avgUnrealizedVsSpyPct: null }

  const returns = positions
    .filter(p => p.currentPrice > 0)
    .map(p => returnPct(p.avgCost, p.currentPrice))

  const vsSpy = currentSpyPrice != null
    ? positions
        .filter(p => p.currentPrice > 0 && p.benchmarkPriceAtOpen != null && p.benchmarkPriceAtOpen > 0)
        .map(p => returnPct(p.avgCost, p.currentPrice) - returnPct(p.benchmarkPriceAtOpen!, currentSpyPrice))
    : []

  return {
    n,
    avgUnrealizedReturnPct: mean(returns),
    avgUnrealizedVsSpyPct: vsSpy.length > 0 ? mean(vsSpy) : null,
  }
}

export function computeCalibration(
  closedPositions: DiscoveryClosedPosition[],
  openPositions: DiscoveryPosition[],
  currentSpyPrice: number | null,
): DiscoveryCalibration {
  const bands: ScoreBand[] = ['90+', '80-89', '70-79']
  const byScoreBand = {} as Record<ScoreBand, BandStats>
  const provisionalByScoreBand = {} as Record<ScoreBand, ProvisionalBandStats>
  for (const band of bands) {
    byScoreBand[band] = closedStatsFor(closedPositions.filter(p => scoreBand(p.score) === band))
    provisionalByScoreBand[band] = provisionalStatsFor(openPositions.filter(p => scoreBand(p.score) === band), currentSpyPrice)
  }

  const convictions: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low']
  const byConviction = {} as Record<'high' | 'medium' | 'low', BandStats>
  for (const c of convictions) {
    // Positions closed before adjustedConviction existed have it as null and
    // are excluded from this breakdown (still counted in byScoreBand).
    byConviction[c] = closedStatsFor(closedPositions.filter(p => p.adjustedConviction === c))
  }

  return {
    generatedAt: new Date().toISOString(),
    closedPositionsAnalyzed: closedPositions.length,
    openPositionsProvisional: openPositions.length,
    byScoreBand,
    byConviction,
    provisionalByScoreBand,
  }
}

function fmtPct(n: number | null): string {
  if (n == null) return 'n/a'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

/**
 * Prompt-injectable calibration block, mirroring briefing-agent.ts's
 * calibrationBlock style. Honest-emptiness rule: any band with n below
 * MIN_N_FOR_VERDICT renders "insufficient data — do not adjust" instead of a
 * real-looking percentage.
 */
export function formatCalibrationBlock(calibration: DiscoveryCalibration): string {
  const bandLines = (['90+', '80-89', '70-79'] as ScoreBand[]).map(band => {
    const s = calibration.byScoreBand[band]
    if (s.n < MIN_N_FOR_VERDICT) {
      return `  - Score ${band}: n=${s.n} — insufficient data, do not adjust`
    }
    return `  - Score ${band} (n=${s.n}): win rate ${(s.winRate! * 100).toFixed(0)}%, avg return ${fmtPct(s.avgReturnPct)}, vs SPY ${fmtPct(s.avgReturnVsSpyPct)}`
  })

  const provisionalLines = (['90+', '80-89', '70-79'] as ScoreBand[]).map(band => {
    const s = calibration.provisionalByScoreBand[band]
    if (s.n === 0) return null
    return `  - Score ${band} (n=${s.n} open, provisional): unrealized ${fmtPct(s.avgUnrealizedReturnPct)}, vs SPY ${fmtPct(s.avgUnrealizedVsSpyPct)}`
  }).filter(Boolean)

  const anyVerdict = (['90+', '80-89', '70-79'] as ScoreBand[]).some(b => calibration.byScoreBand[b].n >= MIN_N_FOR_VERDICT)
  const bestBand = anyVerdict
    ? (['90+', '80-89', '70-79'] as ScoreBand[])
        .filter(b => calibration.byScoreBand[b].n >= MIN_N_FOR_VERDICT)
        .sort((a, b) => (calibration.byScoreBand[b].avgReturnVsSpyPct ?? -Infinity) - (calibration.byScoreBand[a].avgReturnVsSpyPct ?? -Infinity))[0]
    : null

  return [
    `\nDiscovery Self-Calibration (from closed paper positions — no historical data before the 2026-07-06 reset):`,
    `Closed positions analyzed: ${calibration.closedPositionsAnalyzed} | Open (provisional): ${calibration.openPositionsProvisional}`,
    ``,
    `Closed-trade performance by light-filter score band:`,
    ...bandLines,
    ...(provisionalLines.length > 0 ? ['', `Open-position unrealized performance (provisional — not realized, do not treat as a verdict):`, ...provisionalLines] : []),
    ``,
    anyVerdict && bestBand
      ? `Score band with the strongest closed-trade edge so far: ${bestBand} — this is a thin sample, weight it lightly, not as proof.`
      : `Not enough closed trades yet in any band to draw a calibration conclusion — score on fundamentals, not on this section.`,
  ].join('\n')
}
