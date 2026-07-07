// /markets/waves — Wave Analysis (Elliott-Wave signal scan).
// (Supersedes screens/specs/wave-signals.md.)
//
// Layout:
//   ┌ Conflict banners (wave direction vs briefing/discovery stance) ──────┐
//   ├ StatTiles: universe · flashing · long/short split · realized P&L    ┤
//   ├ Flashing signals table (signal-quality columns, expandable rationale)┤
//   ├ Watching / no-signal strip                                           ┤
//   └ Link → /markets/waves/trade (the agent that acts on these)           ┘
//
// Design intents:
// - Direction chips: LONG = accent outline, SHORT = warning outline — never
//   gain/green: a signal is a hypothesis, not a profit.
// - This layer is on trial (ROADMAP Phase 4): the header carries its
//   keep-or-kill audit numbers, and disagreements with the briefing are
//   surfaced as banners, not hidden — two agents disagreeing is signal.

import { loadWaves } from './data'
import type { WaveSignalVM } from './data'
import { StatTile, SectionCard, AlertBanner, Th, Td } from '../_shared/ui'
import { fmtUsd, fmtSignedUsd } from '../_shared/format'

export function DirectionChip({ s }: { s: WaveSignalVM }) {
  const long = s.signal === 'buy'
  return (
    <span
      className={`inline-flex items-center rounded-chip border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        long ? 'border-accent text-accent' : 'border-status-warning text-status-warning'
      }`}
    >
      {long ? 'long' : 'short'}
    </span>
  )
}

function WaveChip({ s }: { s: WaveSignalVM }) {
  return (
    <span className="tnum rounded-chip bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2" title={`Elliott wave ${s.currentWave}, ${s.waveDirection}`}>
      W{s.currentWave}{s.waveDirection === 'up' ? '↑' : '↓'}
    </span>
  )
}

function ConfidenceBar({ v }: { v: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative h-[5px] w-12 overflow-hidden rounded-full bg-surface-2">
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${v}%` }} />
      </span>
      <span className="tnum text-[12px] text-ink-2">{v}</span>
    </span>
  )
}

export default async function WavesPage() {
  const w = await loadWaves()
  const scanned = w.universe.macro + w.universe.watchlist + w.universe.screener
  const longs = w.signals.filter((s) => s.signal === 'buy').length
  const shorts = w.signals.length - longs
  const conflicts = w.signals.filter((s) => s.conflict)
  const hitRate = w.audit.closed > 0 ? w.audit.hits / w.audit.closed : null

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Wave analysis</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Signal-only technical agent — Elliott Wave + fib checks over {w.universe.screenerUniverse},
            no news or fundamentals input. Separate from Discovery by design; judged monthly on
            whether it pays (Phase 4).
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">
          daily scan · signal bar: wave 3/5 + confidence ≥ 50 ·{' '}
          <a href="/markets/waves/trade" className="text-accent">Trade agent →</a>
        </span>
      </header>

      {/* Two signal layers disagreeing is exactly what Neil needs to see. */}
      {conflicts.map((s) => (
        <AlertBanner
          key={s.ticker}
          level="warning"
          title={`${s.ticker}: wave says ${s.signal === 'buy' ? 'LONG' : 'SHORT'} — ${s.conflict!.briefingSays}`}
          detail={s.conflict!.note}
          trailing={<a href="/today" className="shrink-0 text-[12px] text-accent">Briefing →</a>}
        />
      ))}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Universe scanned" value={String(scanned)} footnote={`${w.universe.screener} screener · ${w.universe.watchlist} watchlist · ${w.universe.macro} macro`} />
        <StatTile label="Flashing signals" value={String(w.signals.length)} footnote={`${longs} long · ${shorts} short`} />
        <StatTile
          label="Hit rate (closed)"
          value={hitRate === null ? '—' : `${Math.round(hitRate * 100)}%`}
          footnote={`${w.audit.hits} hit / ${w.audit.stopped} stopped of ${w.audit.closed} — tiny n; backtest aggregation is gap #21`}
        />
        <StatTile label="Realized P&L (waves)" value={fmtSignedUsd(w.audit.realizedPnlUsd)} footnote="paper trades acting on wave signals only" />
      </div>

      {/* ---------------------------- flashing table ---------------------------- */}
      <SectionCard title={`Flashing now · ${w.asOf}`} asOf={w.exportedAt}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Ticker</Th>
                <Th>Signal</Th>
                <Th>Wave</Th>
                <Th align="right">Confidence</Th>
                <Th align="right">Close</Th>
                <Th align="right">Entry zone</Th>
                <Th align="right">Stop</Th>
                <Th align="right">Target</Th>
                <Th align="right">R:R</Th>
                <Th align="right">Fib checks</Th>
              </tr>
            </thead>
            <tbody>
              {[...w.signals]
                .sort((a, b) => b.confidence - a.confidence)
                .map((s) => (
                  <tr key={s.ticker} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                    <Td>
                      <span className="font-semibold text-ink">{s.ticker}</span>
                      <span className="ml-2 hidden text-ink-3 lg:inline">{s.label}</span>
                      {s.held && <span className="ml-2 rounded-chip bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">held</span>}
                      {s.paper && <span className="ml-2 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">paper</span>}
                      {s.conflict && <span className="ml-2 text-[11px] text-status-warning" title={s.conflict.note}>⚠ conflicts</span>}
                    </Td>
                    <Td><DirectionChip s={s} /></Td>
                    <Td><WaveChip s={s} /></Td>
                    <Td align="right"><ConfidenceBar v={s.confidence} /></Td>
                    <Td align="right">{fmtUsd(s.close, { cents: s.close < 100 })}</Td>
                    <Td align="right">
                      {s.entryZone ? `${fmtUsd(s.entryZone.low, { cents: s.close < 100 })}–${fmtUsd(s.entryZone.high, { cents: s.close < 100 })}` : '—'}
                    </Td>
                    <Td align="right">{s.stopLoss !== null ? fmtUsd(s.stopLoss, { cents: s.close < 100 }) : '—'}</Td>
                    <Td align="right">{s.target !== null ? fmtUsd(s.target, { cents: s.close < 100 }) : '—'}</Td>
                    <Td align="right">{s.riskReward !== null ? `${s.riskReward.toFixed(1)}×` : '—'}</Td>
                    <Td align="right">
                      <span className={s.fibPass >= 5 ? 'text-ink' : s.fibPass >= 4 ? 'text-ink-2' : 'text-status-warning'}>
                        {s.fibPass}/{s.fibTotal}
                      </span>
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Sorted by confidence. Stop = the wave-count invalidation pivot, target = 1.618 fib
          extension (missing target = unresolved fib cluster). Row expand in the real app shows the
          full 3-sentence rationale + pivot chart; here it lives in the row tooltip.
        </p>
      </SectionCard>

      {/* --------------------------- watching strip ---------------------------- */}
      <SectionCard title="Scanned, not flashing">
        <div className="flex flex-wrap gap-1.5">
          {w.watching.map((s) => (
            <span
              key={s.ticker}
              className="tnum rounded-chip border border-hairline px-2 py-1 text-[12px] text-ink-3"
              title={`${s.label} — W${s.currentWave}${s.waveDirection === 'up' ? '↑' : '↓'} conf ${s.confidence}: ${s.narrative}`}
            >
              {s.ticker} · {s.confidence}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Below the confidence bar or in a corrective wave (2/4/A/B/C). Shown so an empty signal
          table reads as “nothing qualifies”, not “scan broken”.
        </p>
      </SectionCard>
    </main>
  )
}
