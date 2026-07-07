// /portfolio — Holdings.
//
// Layout:
//   ┌ StatTiles: Net worth (hero) · Day Δ · Unrealized P&L · Cash % · FX ┐
//   ├ Allocation (donut + target drift)   ┬  Holdings table (grouped)   ┤
//   ├ Agent view: positioning belief · next action · scenario playbook   ┤
//   └──────────────────────────────────────────────────────────────────┘
//
// All totals are USD-normalized at the pipeline FX rate; THB natives shown
// as sublines. The FX rate is always visible — never a hidden conversion.
//
// Agent view: the investment agent's live thinking about THIS (real) book —
// same scenario set + probabilities as /today (cross-linked, never forked),
// with the calibration self-note beside it because an opinion without its
// hit rate is exactly the kind of number this redesign exists to kill.

import { loadPortfolio } from './data'
import { HoldingsTable } from './holdings-table'
import { CLASS_META, CLASS_ORDER } from './class-meta'
import { RefreshPricesButton } from './refresh-prices'
import { StatTile, Delta, SectionCard, Label } from '../_shared/ui'
import { AllocationDonut, Sparkline, ProbBar } from '../_shared/charts'
import { fmtUsd, toUsd, pnlUsd } from '../_shared/format'

const SCENARIO_ICON: Record<string, string> = { best: '◔', base: '◑', disruption: '◕' }

export default async function PortfolioPage() {
  const { positions, usdThb, exportedAt, dayChangeUsd, netWorthSeries30d, targets, agentView } = await loadPortfolio()

  const netWorth = positions.reduce((s, p) => s + toUsd(p, usdThb), 0)
  const unrealized = positions.reduce((s, p) => s + pnlUsd(p, usdThb), 0)
  const cashUsd = positions.filter((p) => p.assetClass === 'cash').reduce((s, p) => s + toUsd(p, usdThb), 0)

  const byClass = CLASS_ORDER.map((cls) => ({
    cls,
    label: CLASS_META[cls].label,
    color: CLASS_META[cls].color,
    value: positions.filter((p) => p.assetClass === cls).reduce((s, p) => s + toUsd(p, usdThb), 0),
  })).filter((s) => s.value > 0)

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Portfolio</h1>
        <RefreshPricesButton lastPricedAt={exportedAt} />
      </header>

      {/* ------------------------------ stat row ------------------------------ */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Net worth (USD)" value={fmtUsd(netWorth)} hero delta={dayChangeUsd != null ? <Delta usd={dayChangeUsd} /> : undefined}>
          {netWorthSeries30d && <Sparkline points={netWorthSeries30d} width={140} />}
        </StatTile>
        <StatTile
          label="Day change"
          value={dayChangeUsd != null ? fmtUsd(dayChangeUsd) : '—'}
          footnote={dayChangeUsd == null ? 'needs prev-close series (backend gap #3)' : undefined}
        />
        <StatTile label="Unrealized P&L" value={fmtUsd(unrealized)} delta={<Delta pct={unrealized / (netWorth - unrealized)} />} />
        <StatTile label="Cash" value={fmtUsd(cashUsd)} footnote={`${((cashUsd / netWorth) * 100).toFixed(1)}% of net worth`} />
        <StatTile label="USD / THB" value={usdThb.toFixed(2)} footnote="rate used for all conversions on this page" />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* ----------------------------- allocation ---------------------------- */}
        <SectionCard title="Allocation" asOf={exportedAt} className="col-span-12 xl:col-span-4">
          <AllocationDonut
            segments={byClass.map((s) => ({ label: s.label, value: s.value, color: s.color }))}
            center={fmtUsd(netWorth)}
            centerLabel="total"
            formatValue={(v) => fmtUsd(v)}
          />

          {/* Target drift — actual vs financial-plan target per bucket. */}
          {targets && (
            <div className="mt-5 border-t border-hairline pt-3">
              <Label className="mb-2">vs target (2026 plan)</Label>
              {byClass.map((s) => {
                const target = targets[s.cls as keyof typeof targets]
                if (target == null) return null
                const actual = s.value / netWorth
                const drift = actual - target
                return (
                  <div key={s.cls} className="flex items-center gap-2 py-1 text-[13px]">
                    <span className="w-24 text-ink-2">{s.label}</span>
                    <div className="relative h-[6px] flex-1 rounded-full bg-surface-2">
                      <div className="h-full rounded-full" style={{ width: `${actual * 100}%`, backgroundColor: s.color }} />
                      <div className="absolute -top-[3px] h-3 w-[2px] bg-ink-3" style={{ left: `${target * 100}%` }} title={`target ${(target * 100).toFixed(0)}%`} />
                    </div>
                    <span className={`tnum w-16 text-right ${Math.abs(drift) > 0.05 ? 'text-status-warning' : 'text-ink-3'}`}>
                      {drift > 0 ? '+' : ''}{(drift * 100).toFixed(0)}pp
                    </span>
                  </div>
                )
              })}
              <p className="mt-2 text-[11px] leading-4 text-ink-3">
                Tick = plan target. Amber when drift &gt; ±5pp (annual rebalance rule).
              </p>
            </div>
          )}
        </SectionCard>

        {/* ------------------------------ holdings ----------------------------- */}
        <SectionCard title="Holdings" asOf={exportedAt} className="col-span-12 xl:col-span-8">
          <HoldingsTable positions={positions} usdThb={usdThb} />
        </SectionCard>
      </div>

      {/* ------------------------------ agent view ----------------------------- */}
      {/* The investment agent's thinking about the REAL book. Same scenario
          data as /today — cross-linked, not duplicated, so Portfolio and
          Briefing can never tell two different stories about the same day. */}
      <SectionCard
        title="Agent view — positioning & scenario playbook"
        asOf={exportedAt}
        actions={<a href="/today" className="text-[12px] text-accent">Briefing →</a>}
      >
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 xl:col-span-5">
            <Label>Current positioning belief</Label>
            <p className="mt-1 text-[13px] leading-5 text-ink-2">{agentView.positioning}</p>

            <div className="mt-3">
              <Label>Next planned action</Label>
              <p className="mt-1 text-[13px] leading-5 text-ink">{agentView.nextPlannedAction}</p>
            </div>

            <p className="mt-3 border-t border-hairline pt-2 text-[11px] leading-4 text-ink-3">
              Calibration: {agentView.calibrationNote}
            </p>
          </div>

          <div className="col-span-12 xl:col-span-7 xl:border-l xl:border-hairline xl:pl-6">
            <Label>Scenarios it is watching · {agentView.briefingDate}</Label>
            {agentView.scenarios.map((s) => (
              <div key={s.id} className="mt-1">
                <ProbBar
                  title={s.title}
                  probability={s.probability}
                  horizon={s.timeHorizon}
                  icon={SCENARIO_ICON[s.scenarioType]}
                />
                <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
                  <span className="font-medium text-ink-2">If it plays out:</span> {s.plannedResponse}
                </p>
              </div>
            ))}
            <p className="mt-2 text-[11px] leading-4 text-ink-3">
              Identical scenario set and probabilities as the <a href="/today" className="text-accent">daily briefing</a> —
              every planned response maps to an action on this page's holdings.
            </p>
          </div>
        </div>
      </SectionCard>
    </main>
  )
}
