// Loader contract for /markets/waves. (Supersedes screens/specs/wave-signals.md.)
//
// Source: wave-analyzer/data/waves.json + wave-actions.json (daily, `npm run
// wave`). This is a genuinely SEPARATE agent from Discovery: Elliott-Wave /
// fib technical signals only — no news, no fundamentals, no scenario input.
// The screen is a **signal audit** (ROADMAP Phase 4 openly questions whether
// this layer earns its keep), not a trading terminal.
//
// Signal rule (src/actions/action-generator.ts::computeSignal):
//   wave 3 or 5 + confidence ≥ 50  → buy (direction up) / sell (direction down)
//   wave 2/4/A/B/C                 → watch
//   else / confidence < 50         → no-signal
//
// Sample values are the REAL 2026-07-06 run: 22 assets scanned (1 macro +
// 5 watchlist + 16 screener), 14 flashing (13 sell / 1 buy — VZ).
// GAP #21: typed WaveJSON envelope in @common/types; hit-rate/backtest
// aggregation; briefing-vs-wave conflict join (needs structured briefing #1).

export type WaveSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface WaveSignalVM {
  ticker: string
  label: string
  source: 'macro' | 'watchlist' | 'screener'
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number // 0–100
  signal: WaveSignal
  close: number
  entryZone: { low: number; high: number } | null
  stopLoss: number | null
  target: number | null
  riskReward: number | null
  fibPass: number
  fibTotal: number
  /** Haiku-generated 3-sentence trade rationale (cached by narrativeKey). */
  narrative: string
  held: boolean // in the real portfolio (or its proxy, e.g. GC=F ↔ GOLD_OZ)
  paper: boolean // in the discovery paper book
  /** Wave direction disagrees with the day's briefing action for this name. */
  conflict?: { briefingSays: string; note: string }
}

export interface WavesViewModel {
  exportedAt: string
  asOf: string
  universe: { macro: number; watchlist: number; screener: number; screenerUniverse: string }
  signals: WaveSignalVM[] // flashing: buy/sell
  watching: WaveSignalVM[] // watch / no-signal
  /** From trades.db closed rows — the audit numbers /markets/waves/trade details. */
  audit: { closed: number; hits: number; stopped: number; realizedPnlUsd: number }
}

export async function loadWaves(): Promise<WavesViewModel> {
  const all = ASSETS
  return {
    exportedAt: '2026-07-06T17:05:43.390Z',
    asOf: '2026-07-06',
    universe: { macro: 1, watchlist: 5, screener: 16, screenerUniverse: 'S&P 500 + liquid mid-caps' },
    signals: all.filter((a) => a.signal === 'buy' || a.signal === 'sell'),
    watching: all.filter((a) => a.signal === 'watch' || a.signal === 'no-signal'),
    audit: { closed: 4, hits: 2, stopped: 1, realizedPnlUsd: 247 },
  }
}

const z = (low: number, high: number) => ({ low, high })

function a(
  ticker: string, label: string, source: WaveSignalVM['source'],
  wave: string, dir: 'up' | 'down', confidence: number, signal: WaveSignal,
  close: number, entry: { low: number; high: number } | null,
  stop: number | null, target: number | null, rr: number | null,
  fibPass: number, narrative: string,
  flags: Partial<Pick<WaveSignalVM, 'held' | 'paper' | 'conflict'>> = {},
): WaveSignalVM {
  return {
    ticker, label, source, currentWave: wave, waveDirection: dir, confidence, signal,
    close, entryZone: entry, stopLoss: stop, target, riskReward: rr,
    fibPass, fibTotal: 6, narrative,
    held: false, paper: false, ...flags,
  }
}

// Real 2026-07-06 waves.json/wave-actions.json rows (narratives abridged).
const ASSETS: WaveSignalVM[] = [
  a('VZ', 'Verizon', 'screener', '5', 'up', 80, 'buy', 43.31, z(42.44, 44.18), 41.2, 47.8, 2.4, 5,
    'Wave 5 advance from the $41.20 wave-4 low is impulsive with volume confirmation; entry near the zone midpoint keeps risk defined against the wave-4 pivot. A close below $41.20 invalidates the count.'),
  a('AMZN', 'Amazon', 'watchlist', '5', 'down', 80, 'sell', 242.67, z(237.8, 247.5), 256.9, 224.4, 2.1, 5,
    'Five-wave decline maturing; wave-5 measured move targets $224 with invalidation above the wave-4 high at $256.90.',
    { paper: true, conflict: { briefingSays: 'paper book holds AMZN (score 72)', note: 'Wave layer is short-biased while the discovery book is long — the two agents disagree on AMZN today.' } }),
  a('BMNR', 'Bitmine Immersion', 'screener', '5', 'down', 80, 'sell', 28.4, z(27.83, 28.97), 31.2, 22.9, 1.9, 4,
    'Wave 5 breakdown after a shallow wave-4 retrace; stop above the wave-4 high.'),
  a('T', 'AT&T', 'screener', '5', 'down', 70, 'sell', 29.06, z(28.48, 29.64), 30.25, 26.6, 2.1, 5,
    'Mature five-wave decline; entry on corrective strength toward the zone top, invalidated above $30.25.'),
  a('META', 'Meta Platforms', 'watchlist', '5', 'down', 60, 'sell', 719.4, z(705.0, 733.8), 772.0, 651.0, 1.7, 4,
    'Wave 5 down in progress from the $801 wave-3 extreme; break above $772 (wave 4) invalidates.'),
  a('GC=F', 'Gold', 'macro', '5', 'down', 50, 'sell', 4293.0, z(4082.5, 4249.1), 4377.0, null, null, 4,
    'Completed five-wave decline from $4765.20; corrective bounce expected — break above $4592 wave-4 high negates. Target unresolved (fib cluster below).',
    { held: true, conflict: { briefingSays: 'briefing says HOLD GOLD_OZ (thesis strengthening)', note: 'Wave layer reads gold technically exhausted while the briefing holds it as the disruption hedge — position sizing, not signals, should resolve this.' } }),
  a('NVDA', 'NVIDIA', 'watchlist', '5', 'down', 50, 'sell', 192.83, z(192.7, 200.6), 213.99, null, null, 4,
    'Wave 5 printing lows at $192.13; below-$192.13 close continues the decline, above $214 breaks the count.',
    { paper: true, conflict: { briefingSays: 'paper book holds NVDA (score 95, top conviction)', note: 'Highest-conviction discovery name vs a technical sell — the exact disagreement this screen exists to surface.' } }),
  a('SOFI', 'SoFi Technologies', 'screener', '5', 'down', 50, 'sell', 24.1, z(23.62, 24.58), 26.05, 21.3, 1.6, 4,
    'Wave 5 decline with weakening momentum; stop above wave-4.'),
  a('ONDS', 'Ondas Holdings', 'screener', '5', 'down', 50, 'sell', 5.84, z(5.72, 5.96), 6.45, 4.9, 1.6, 3,
    'Low-priced wave-5 decline; wide percentage stops — size accordingly.'),
  a('GRAB', 'Grab Holdings', 'screener', '5', 'down', 50, 'sell', 4.62, z(4.53, 4.71), 5.02, 4.05, 1.5, 4,
    'Wave 5 down; invalidation at the wave-4 high $5.02.'),
  a('IREN', 'IREN Ltd', 'screener', '5', 'down', 50, 'sell', 17.9, z(17.54, 18.26), 19.6, 15.1, 1.7, 4,
    'Wave 5 decline within the larger downtrend; stop above wave-4.'),
  a('PATH', 'UiPath', 'screener', '5', 'down', 50, 'sell', 13.42, z(13.15, 13.69), 14.5, 11.8, 1.6, 4,
    'Mature decline; corrective risk rising — tight invalidation.'),
  a('F', 'Ford Motor', 'screener', '5', 'down', 50, 'sell', 11.86, z(11.62, 12.1), 12.7, 10.6, 1.6, 4,
    'Wave 5 down with fading volume; watch for basing behavior near target.'),
  a('JOBY', 'Joby Aviation', 'screener', '5', 'down', 50, 'sell', 8.94, z(8.76, 9.12), 9.85, 7.6, 1.6, 3,
    'Speculative name in wave-5 decline; half the fib checks pass — low structural quality.'),
  // ── watching / no-signal (confidence < 50 or corrective wave) ────────────
  a('AAPL', 'Apple', 'watchlist', '5', 'up', 40, 'no-signal', 289.1, null, null, null, null, 3,
    'Wave 5 up but confidence below the 50 bar — no signal.'),
  a('TSLA', 'Tesla', 'watchlist', '5', 'up', 40, 'no-signal', 448.7, null, null, null, null, 3,
    'Wave count ambiguous; overlapping structure fails fib symmetry checks.'),
  a('AAL', 'American Airlines', 'screener', '5', 'down', 40, 'no-signal', 12.9, null, null, null, null, 3, 'Confidence below bar.'),
  a('INTC', 'Intel', 'screener', '5', 'up', 40, 'no-signal', 37.2, null, null, null, null, 3, 'Confidence below bar.'),
  a('WULF', 'TeraWulf', 'screener', '5', 'up', 40, 'no-signal', 9.8, null, null, null, null, 3, 'Confidence below bar.'),
  a('OPEN', 'Opendoor', 'screener', '5', 'up', 30, 'no-signal', 2.4, null, null, null, null, 2, 'Confidence below bar.'),
  a('NOK', 'Nokia', 'screener', '5', 'down', 40, 'no-signal', 5.1, null, null, null, null, 3, 'Confidence below bar.'),
  a('PFE', 'Pfizer', 'screener', '5', 'down', 30, 'no-signal', 26.3, null, null, null, null, 2, 'Confidence below bar.'),
]
