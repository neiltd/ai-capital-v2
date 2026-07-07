// /markets/waves/trade — Trade agent (paper) acting ONLY on wave signals.
// (Supersedes the trade half of screens/specs/wave-signals.md.)
//
// Layout:
//   ┌ StatTiles: budget · open risk · realized P&L · hit rate ─────────────┐
//   ├ Sizing-policy banner (fixed-fractional 2% risk — the WHY-this-size)  ┤
//   ├ Open positions — each a card: stop→target range bar + trigger        ┤
//   │   ("why this stock") + risk math ("why this size")                   ┤
//   ├ Closed trades table with outcome column (hit/stopped/manual)         ┤
//   └ "Does this layer pay?" audit panel (monthly P&L, keep-or-kill)       ┘
//
// Design intents:
// - Same transparency rule as Discovery sizing: no dollar figure without its
//   derivation, no position without its triggering signal.
// - Outcome P&L gets gain/loss color (it IS profit); direction chips stay
//   accent/warning (a signal is a hypothesis).
// - The GC=F row demonstrates the cross-agent conflict cost: short gold here
//   while /today holds GOLD_OZ as the disruption hedge = paying two spreads.

import { loadTrade } from './data'
import type { TradePositionVM } from './data'
import { StatTile, SectionCard, AlertBanner, Label, Th, Td } from '../_shared/ui'
import { fmtUsd, fmtSignedUsd, fmtPct } from '../_shared/format'

const OUTCOME: Record<string, { label: string; icon: string; color: string }> = {
  hit: { label: 'hit target', icon: '✓', color: '#0ca30c' },
  stopped: { label: 'stopped', icon: '⛔', color: '#d03b3b' },
  'closed-manual': { label: 'closed manual', icon: '↩', color: 'var(--ink-3)' },
}

function rMultiple(p: TradePositionVM): number {
  const px = p.status === 'open' ? p.currentPrice : (p.closePrice ?? p.currentPrice)
  const move = p.direction === 'long' ? px - p.entryPrice : p.entryPrice - px
  return move / p.sizing.perShareRiskUsd
}

export default async function TradePage() {
  const t = await loadTrade()
  const openRisk = t.open.reduce((s, p) => s + p.sizing.actualRiskUsd, 0)
  const realized = t.closed.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const hits = t.closed.filter((p) => p.outcome === 'hit').length
  const unrealized = t.open.reduce((s, p) => {
    const move = p.direction === 'long' ? p.currentPrice - p.entryPrice : p.entryPrice - p.currentPrice
    return s + move * p.shares
  }, 0)

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Trade agent</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Paper trader that acts only on <a href="/markets/waves" className="text-accent">wave signals</a> —
            no news, no fundamentals, no scenario input. Every position shows which signal triggered
            it and how its size was derived.
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">
          max {t.config.maxConcurrent} concurrent · trades.db via `npm run trade`
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Trade budget" value={fmtUsd(t.config.tradeBudgetUsd)} footnote={`separate from Discovery's ${fmtUsd(20185)} paper budget — never mixed`} />
        <StatTile label="Open positions" value={String(t.open.length)} footnote={`${fmtUsd(openRisk)} at risk if all stops hit (${fmtPct(openRisk / t.config.tradeBudgetUsd)})`} />
        <StatTile label="Realized P&L" value={fmtSignedUsd(realized)} footnote={`unrealized ${fmtSignedUsd(unrealized)} on open book`} />
        <StatTile label="Hit rate" value={`${hits}/${t.closed.length}`} footnote="closed trades reaching target — tiny n, see audit below" />
      </div>

      {/* The sizing policy IS the why-this-size answer, stated once, applied
          per-row below. GAP #21b: cli-trade takes --shares manually today —
          this rule must move into the CLI so display and write path agree. */}
      <AlertBanner
        level="info"
        title={`Sizing policy: risk ${fmtPct(t.config.riskPerTradePct, 0)} of budget per trade (${fmtUsd(t.config.tradeBudgetUsd * t.config.riskPerTradePct)})`}
        detail="shares = risk budget ÷ |entry − stop|, so every stop-out costs ≈ 1R regardless of share price. Proposed policy — the CLI still takes --shares manually (gap #21b)."
      />

      {/* ----------------------------- open positions ---------------------------- */}
      <SectionCard title="Open positions" asOf={t.exportedAt}>
        <ul className="divide-y divide-hairline">
          {t.open.map((p) => (
            <li key={p.id} className="py-3.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[14px] font-semibold text-ink">{p.ticker}</span>
                <span className="text-[13px] text-ink-3">{p.label}</span>
                <span
                  className={`inline-flex items-center rounded-chip border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                    p.direction === 'long' ? 'border-accent text-accent' : 'border-status-warning text-status-warning'
                  }`}
                >
                  {p.direction}
                </span>
                <span className="tnum text-[12px] text-ink-3">opened {p.openedAt}</span>
                <span className="tnum ml-auto text-[13px] font-medium" style={{ color: rMultiple(p) > 0 ? 'var(--gain)' : rMultiple(p) < 0 ? 'var(--loss)' : 'var(--ink-3)' }}>
                  {rMultiple(p) >= 0 ? '+' : '−'}{Math.abs(rMultiple(p)).toFixed(2)}R
                </span>
              </div>

              <RangeBar p={p} />

              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div className="rounded-chip border border-hairline p-2.5">
                  <Label>Why this stock — triggering signal</Label>
                  <p className="tnum mt-1 text-[12px] text-ink-2">
                    Wave {p.trigger.wave}{p.trigger.direction === 'up' ? '↑' : '↓'} ·{' '}
                    {p.trigger.signal.toUpperCase()} · confidence {p.trigger.confidence} ·{' '}
                    signal {p.trigger.signalDate}
                  </p>
                  <p className="mt-1 text-[13px] leading-5 text-ink-2">{p.trigger.narrative}</p>
                </div>
                <div className="rounded-chip border border-hairline p-2.5">
                  <Label>Why this size — risk math</Label>
                  <p className="tnum mt-1 text-[13px] leading-5 text-ink-2">
                    {fmtUsd(p.sizing.riskBudgetUsd)} risk budget ÷ {fmtUsd(p.sizing.perShareRiskUsd, { cents: true })}
                    /share stop distance = {Math.floor(p.sizing.riskBudgetUsd / p.sizing.perShareRiskUsd)} →{' '}
                    <span className="font-medium text-ink">{p.shares} shares</span> ({fmtUsd(p.sizing.notionalUsd)} notional)
                  </p>
                  <p className="tnum mt-1 text-[12px] leading-4 text-ink-3">
                    If stopped: −{fmtUsd(p.sizing.actualRiskUsd)} ({fmtPct(p.sizing.actualRiskUsd / p.sizing.tradeBudgetUsd)} of budget) ·
                    if target: +{fmtUsd(Math.abs(p.target - p.entryPrice) * p.shares)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* ------------------------------ closed trades ----------------------------- */}
      <SectionCard title="Closed trades">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Ticker</Th>
                <Th>Dir</Th>
                <Th>Signal</Th>
                <Th align="right">Entry</Th>
                <Th align="right">Exit</Th>
                <Th align="right">Held</Th>
                <Th>Outcome</Th>
                <Th align="right">P&L</Th>
                <Th align="right">R</Th>
              </tr>
            </thead>
            <tbody>
              {t.closed.map((p) => {
                const o = OUTCOME[p.outcome ?? 'closed-manual']
                const days = Math.round((Date.parse(p.closedAt!) - Date.parse(p.openedAt)) / 86400000)
                return (
                  <tr key={p.id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                    <Td>
                      <span className="font-semibold text-ink">{p.ticker}</span>
                      <span className="ml-2 hidden text-ink-3 lg:inline" title={p.trigger.narrative}>{p.label}</span>
                    </Td>
                    <Td className="uppercase">{p.direction}</Td>
                    <Td className="tnum">W{p.trigger.wave}{p.trigger.direction === 'up' ? '↑' : '↓'} · {p.trigger.confidence}</Td>
                    <Td align="right">{fmtUsd(p.entryPrice, { cents: p.entryPrice < 100 })}</Td>
                    <Td align="right">{fmtUsd(p.closePrice!, { cents: p.closePrice! < 100 })}</Td>
                    <Td align="right">{days}d</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1 text-[12px]" style={{ color: o.color }}>
                        <span aria-hidden>{o.icon}</span> {o.label}
                      </span>
                    </Td>
                    <Td align="right">
                      <span className={`font-medium ${p.pnl! > 0 ? 'text-gain' : p.pnl! < 0 ? 'text-loss' : 'text-ink-3'}`}>
                        {fmtSignedUsd(p.pnl!)}
                      </span>
                    </Td>
                    <Td align="right">{(p.pnl! / p.sizing.actualRiskUsd).toFixed(1)}R</Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          INTC stop-out cost −$99.60 ≈ exactly 1R — that is the sizing rule working, not a failure.
          GC=F was closed manually when it conflicted with the briefing&apos;s GOLD_OZ hedge.
        </p>
      </SectionCard>

      {/* --------------------------- does this layer pay? -------------------------- */}
      <SectionCard title="Does this layer pay?">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>Realized P&L by month</Label>
            <div className="mt-2 space-y-1.5">
              {t.monthly.map((m) => {
                const max = Math.max(...t.monthly.map((x) => Math.abs(x.pnlUsd))) || 1
                return (
                  <div key={m.month} className="flex items-center gap-3">
                    <span className="tnum w-16 shrink-0 text-[12px] text-ink-3">{m.month}</span>
                    <div className="relative h-[6px] flex-1 rounded-full bg-surface-2">
                      <div
                        className="absolute inset-y-0 rounded-full"
                        style={{
                          left: m.pnlUsd < 0 ? `${50 - (Math.abs(m.pnlUsd) / max) * 50}%` : '50%',
                          width: `${(Math.abs(m.pnlUsd) / max) * 50}%`,
                          backgroundColor: m.pnlUsd >= 0 ? 'var(--gain)' : 'var(--loss)',
                        }}
                      />
                      <div className="absolute inset-y-0 left-1/2 w-px bg-hairline" />
                    </div>
                    <span className={`tnum w-20 shrink-0 text-right text-[12px] font-medium ${m.pnlUsd >= 0 ? 'text-gain' : 'text-loss'}`}>
                      {fmtSignedUsd(m.pnlUsd)}
                    </span>
                    <span className="tnum w-16 shrink-0 text-right text-[11px] text-ink-3">{m.hits}/{m.trades} hit</span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="text-[13px] leading-5 text-ink-2">
            <Label>Keep-or-kill evidence (ROADMAP Phase 4)</Label>
            <p className="mt-1.5">
              Cumulative realized: <span className={`tnum font-medium ${realized >= 0 ? 'text-gain' : 'text-loss'}`}>{fmtSignedUsd(realized)}</span>{' '}
              over {t.monthly.length} months, {t.closed.length} closed trades — statistically nothing yet.
              The honest comparison this panel needs is “followed every wave signal” vs the
              briefing-only baseline, which requires the wave backtest aggregation
              (predictions.jsonl pattern) — gap #21. Until then this panel reports, it does not verdict.
            </p>
          </div>
        </div>
      </SectionCard>
    </main>
  )
}

/* -------------------- stop → entry → current → target bar ------------------- */
// One horizontal scale from stop to target; entry tick, current-price dot.
// Direction-agnostic: for shorts the target sits left of entry numerically,
// so we normalize to [min,max] and let the labels carry meaning.

function RangeBar({ p }: { p: TradePositionVM }) {
  const lo = Math.min(p.stopLoss, p.target)
  const hi = Math.max(p.stopLoss, p.target)
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100
  const cents = p.entryPrice < 100
  const gain = rMultipleColor(p)
  return (
    <div className="mt-2">
      <div className="relative h-[6px] rounded-full bg-surface-2">
        {/* stop and target ends */}
        <span className="absolute -top-[3px] h-3 w-[2px] bg-status-critical" style={{ left: `${pct(p.stopLoss)}%` }} title={`Stop ${fmtUsd(p.stopLoss, { cents })}`} />
        <span className="absolute -top-[3px] h-3 w-[2px] bg-gain" style={{ left: `${pct(p.target)}%` }} title={`Target ${fmtUsd(p.target, { cents })}`} />
        {/* entry tick */}
        <span className="absolute -top-[2px] h-2.5 w-[2px] bg-ink-3" style={{ left: `${pct(p.entryPrice)}%` }} title={`Entry ${fmtUsd(p.entryPrice, { cents })}`} />
        {/* current price dot */}
        <span
          className="absolute -top-[3px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface"
          style={{ left: `${pct(p.currentPrice)}%`, backgroundColor: gain }}
          title={`Current ${fmtUsd(p.currentPrice, { cents })}`}
        />
      </div>
      <div className="tnum mt-1 flex justify-between text-[10px] text-ink-3">
        <span>{p.stopLoss === lo ? `stop ${fmtUsd(p.stopLoss, { cents })}` : `target ${fmtUsd(p.target, { cents })}`}</span>
        <span>entry {fmtUsd(p.entryPrice, { cents })} · now {fmtUsd(p.currentPrice, { cents })}</span>
        <span>{p.stopLoss === lo ? `target ${fmtUsd(p.target, { cents })}` : `stop ${fmtUsd(p.stopLoss, { cents })}`}</span>
      </div>
    </div>
  )
}

function rMultipleColor(p: TradePositionVM): string {
  const move = p.direction === 'long' ? p.currentPrice - p.entryPrice : p.entryPrice - p.currentPrice
  return move > 0 ? 'var(--gain)' : move < 0 ? 'var(--loss)' : 'var(--ink-3)'
}
