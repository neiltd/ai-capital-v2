// Loader for /markets/waves. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5. Stitches:
//   - wave-analyzer/data/waves.json         (fib checks + last close, per ticker)
//   - wave-analyzer/data/wave-actions.json  (the flashing/watching signal rows)
//   - wave-analyzer/data/wave-portfolio.json (closed paper trades → audit stats)
//   - simulation.json + discovery.json      (held/paper flags, for conflict detection)
//   - briefings/YYYY-MM-DD.json             (conflict join, now that gap #1 exists)

import { readWaves, readWaveActions, readWavePortfolio, readSimulation, readDiscovery, readBriefingJson, todayLocal } from '@/lib/data'

export type WaveSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface WaveSignalVM {
  ticker: string
  label: string
  source: 'macro' | 'watchlist' | 'screener'
  currentWave: string | null
  waveDirection: 'up' | 'down' | null
  confidence: number
  signal: WaveSignal
  close: number | null
  entryZone: { low: number; high: number } | null
  stopLoss: number | null
  target: number | null
  riskReward: number | null
  fibPass: number
  fibTotal: number
  narrative: string
  held: boolean
  paper: boolean
  conflict?: { briefingSays: string; note: string }
}

export interface WavesViewModel {
  exportedAt: string
  asOf: string
  universe: { macro: number; watchlist: number; screener: number; screenerUniverse: string }
  signals: WaveSignalVM[]
  watching: WaveSignalVM[]
  audit: { closed: number; hits: number; stopped: number; realizedPnlUsd: number }
}

// The only real cross-source overlap: wave-analyzer scans gold FUTURES
// (GC=F) while the real portfolio holds physical gold (GOLD_OZ) — same
// underlying commodity, different tickers. No other proxy mappings exist;
// everything else the wave scanner covers (screener/watchlist names) has no
// real-portfolio position under any ticker.
const HELD_PROXY: Record<string, string> = { 'GC=F': 'GOLD_OZ' }

export function loadWaves(date: string = todayLocal()): WavesViewModel {
  const waves = readWaves()
  const actions = readWaveActions()
  const portfolio = readWavePortfolio()

  const fibByTicker = new Map(waves?.assets.map((a) => [a.ticker, a]) ?? [])
  const sourceByTicker = new Map(waves?.assets.map((a) => [a.ticker, a.source]) ?? [])

  let realTickers = new Set<string>()
  try { realTickers = new Set(readSimulation().portfolio.map((p) => p.ticker)) } catch { /* simulation.json missing */ }

  let paperTickers = new Set<string>()
  try { paperTickers = new Set((readDiscovery()?.discoveryPortfolio ?? []).map((p) => p.ticker)) } catch { /* discovery.json missing */ }

  const briefing = readBriefingJson(date)
  const briefingActionByTicker = new Map((briefing?.recommendedActions ?? []).map((a) => [a.ticker, a]))

  function detectConflict(waveTicker: string, signal: WaveSignal): WaveSignalVM['conflict'] {
    const proxyTicker = HELD_PROXY[waveTicker]
    if (proxyTicker) {
      const briefingAction = briefingActionByTicker.get(proxyTicker)
      if (briefingAction) {
        const bearishWaveVsBullishBriefing = signal === 'sell' && (briefingAction.action === 'buy' || briefingAction.action === 'hold')
        const bullishWaveVsBearishBriefing = signal === 'buy' && (briefingAction.action === 'trim' || briefingAction.action === 'exit')
        if (bearishWaveVsBullishBriefing || bullishWaveVsBearishBriefing) {
          return {
            briefingSays: `briefing says ${briefingAction.action.toUpperCase()} ${proxyTicker}`,
            note: `Wave layer reads ${waveTicker} as technically ${signal === 'sell' ? 'exhausted' : 'turning'} while the briefing holds a ${briefingAction.action} stance on ${proxyTicker} — position sizing, not signals, should resolve this.`,
          }
        }
      }
    }
    // Paper book is long-only by construction — any sell signal on a
    // paper-held ticker is an inherent disagreement.
    if (paperTickers.has(waveTicker) && signal === 'sell') {
      return {
        briefingSays: `paper book holds ${waveTicker}`,
        note: 'Wave layer is short-biased while the discovery book is long — the two agents disagree today.',
      }
    }
    return undefined
  }

  const toVM = (a: NonNullable<ReturnType<typeof readWaveActions>>['actions'][number]): WaveSignalVM => {
    const fib = fibByTicker.get(a.ticker)
    const fibPass = fib?.fibChecks.filter((f) => f.pass).length ?? 0
    const fibTotal = fib?.fibChecks.length ?? 0
    const close = fib?.candles.length ? fib.candles[fib.candles.length - 1].close : null
    return {
      ticker: a.ticker,
      label: a.label,
      source: sourceByTicker.get(a.ticker) ?? 'screener',
      currentWave: a.currentWave,
      waveDirection: a.waveDirection,
      confidence: a.confidence,
      signal: a.signal,
      close,
      entryZone: a.entryZone,
      stopLoss: a.stopLoss,
      target: a.target,
      riskReward: a.riskReward,
      fibPass,
      fibTotal,
      narrative: a.narrative,
      held: realTickers.has(a.ticker) || HELD_PROXY[a.ticker] != null && realTickers.has(HELD_PROXY[a.ticker]),
      paper: paperTickers.has(a.ticker),
      conflict: (a.signal === 'buy' || a.signal === 'sell') ? detectConflict(a.ticker, a.signal) : undefined,
    }
  }

  const all = (actions?.actions ?? []).map(toVM)
  const closedPositions = portfolio?.closedPositions ?? []

  return {
    exportedAt: waves?.exportedAt ?? actions?.exportedAt ?? new Date().toISOString(),
    asOf: waves?.asOf ?? actions?.asOf ?? date,
    universe: {
      macro: Array.from(sourceByTicker.values()).filter((s) => s === 'macro').length,
      watchlist: Array.from(sourceByTicker.values()).filter((s) => s === 'watchlist').length,
      screener: Array.from(sourceByTicker.values()).filter((s) => s === 'screener').length,
      screenerUniverse: 'S&P 500 + liquid mid-caps',
    },
    signals: all.filter((s) => s.signal === 'buy' || s.signal === 'sell'),
    watching: all.filter((s) => s.signal === 'watch' || s.signal === 'no-signal'),
    audit: {
      closed: closedPositions.length,
      hits: closedPositions.filter((p) => p.status === 'closed' && (p.pnl ?? 0) > 0).length,
      stopped: closedPositions.filter((p) => p.status === 'stopped').length,
      realizedPnlUsd: portfolio?.totalPnl ?? 0,
    },
  }
}
