// /discover — Autonomous discovery agent (paper portfolio).
//
// Layout:
//   ┌ StatTiles: paper budget · invested · paper P&L · vs SPY (gap) ────────┐
//   ├ Candidate queue (empty — next run Sunday)                             ┤
//   ├ Paper portfolio (empty — cohort 1 not yet started)                    ┤
//   ├ Cohort 0 archive — the 16-position book reset on 2026-07-06           ┤
//   └ Policy notes: sizing, exits, calibration status                      ┘
//
// Adapted from design-redesign-2026-07/screens/discovery per the migration
// plan's §5 diff — the mockup was built against the pre-upgrade backend
// (old score-band sizing, no exit mechanism, a since-archived 16-position
// cohort). Ships read-only: no promote button (gap #14, not built).

export const dynamic = 'force-dynamic'

import { loadDiscovery, RISK_PER_TRADE_PCT, THEME_CONCENTRATION_CAP, TIME_STOP_DAYS, THESIS_CHECK_DOWN_PCT, THESIS_CHECK_HELD_DAYS, MIN_N_FOR_VERDICT } from './data'
import { StatTile, SectionCard, AlertBanner, Th, Td, ScoreBadge, ConvictionBadge, Delta } from '@/components/next/ui'
import { fmtUsd, fmtSignedUsd, fmtPct } from '@/lib/next/format'

export default function DiscoveryPage() {
  const d = loadDiscovery()

  if (!d) {
    return (
      <main className="mx-auto max-w-[1520px] p-page-pad">
        <AlertBanner level="warning" title="Discovery data unavailable" detail="scenario-simulator/data/discovery.json not found." />
      </main>
    )
  }

  const invested = d.holdings.reduce((s, x) => s + x.currentValue, 0)
  const pnl = d.holdings.reduce((s, x) => s + x.unrealizedPnl, 0)
  const costBasis = invested - pnl
  const maxDeployable = d.config.paperBudget * (1 - d.config.cashReservePct)

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Discovery agent</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Weekly Claude-driven screen → adversarial bull/bear review → paper positions. Nothing
            here is real money until manually promoted.
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">runs Sundays · score threshold ≥ {d.config.threshold}</span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          label="Paper budget"
          value={fmtUsd(d.config.paperBudget)}
          footnote={`${fmtPct(d.config.cashReservePct, 0)} reserve → ${fmtUsd(maxDeployable)} deployable · ${fmtUsd(Math.max(0, maxDeployable - d.deployedUsd))} remaining`}
        />
        <StatTile label="Invested (paper)" value={fmtUsd(invested)} footnote={`${d.holdings.length} open position${d.holdings.length === 1 ? '' : 's'}`} />
        <StatTile
          label="Paper P&L"
          value={fmtSignedUsd(pnl)}
          delta={costBasis !== 0 ? <Delta pct={pnl / costBasis} /> : undefined}
          footnote="unrealized marks only"
        />
        <StatTile label="vs SPY since open" value="—" footnote="needs paper value series + benchmark (backend gap #2)" />
      </div>

      {/* --------------------------- candidate queue --------------------------- */}
      <SectionCard title="Candidate queue" asOf={d.exportedAt}>
        {d.candidates.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-ink-3">
            No candidates cleared the {d.config.threshold}-score bar this week. An empty queue
            means the agent is idle, not broken — screens run Sundays only.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {d.candidates.map((c) => (
              <li key={c.ticker} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <ScoreBadge score={c.score} />
                  <span className="text-[14px] font-semibold text-ink">{c.ticker}</span>
                  <span className="text-[13px] text-ink-3">{c.company}</span>
                  <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3 uppercase">{c.action}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{c.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* --------------------------- paper portfolio --------------------------- */}
      <SectionCard title="Paper portfolio" asOf={d.exportedAt}>
        {d.holdings.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-ink-3">
            No open positions — cohort 1 hasn&apos;t started yet under the new risk-based sizing
            policy. See cohort 0 archive below for the prior book&apos;s history.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="right">Score</Th>
                  <Th>Ticker</Th>
                  <Th>Conviction</Th>
                  <Th align="right">Stop</Th>
                  <Th align="right">Target</Th>
                  <Th align="right">Opened</Th>
                  <Th align="right">Shares</Th>
                  <Th align="right">Avg cost</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">P&L</Th>
                </tr>
              </thead>
              <tbody>
                {[...d.holdings].sort((a, b) => b.score - a.score).map((x) => {
                  const ret = x.avgCost * x.shares !== 0 ? x.unrealizedPnl / (x.avgCost * x.shares) : undefined
                  return (
                    <tr key={x.ticker} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                      <Td align="right"><ScoreBadge score={x.score} /></Td>
                      <Td>
                        <span className="font-semibold text-ink">{x.ticker}</span>
                        <span className="ml-2 hidden text-ink-3 lg:inline" title={x.rationale}>{x.company}</span>
                      </Td>
                      <Td>{x.adjustedConviction ? <ConvictionBadge conviction={x.adjustedConviction} /> : <span className="text-ink-3">—</span>}</Td>
                      <Td align="right">{x.stopPrice != null ? fmtUsd(x.stopPrice, { cents: true }) : '—'}</Td>
                      <Td align="right">{x.targetPrice != null ? fmtUsd(x.targetPrice, { cents: true }) : '—'}</Td>
                      <Td align="right">{x.openedAt.slice(0, 10)}</Td>
                      <Td align="right">{x.shares}</Td>
                      <Td align="right">{fmtUsd(x.avgCost, { cents: true })}</Td>
                      <Td align="right" className="font-medium text-ink">{fmtUsd(x.currentValue)}</Td>
                      <Td align="right"><Delta usd={x.unrealizedPnl} pct={ret} /></Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ------------------------------ cohort 0 archive ------------------------------ */}
      {d.archive && (
        <SectionCard title="Cohort 0 archive — reset 2026-07-06" asOf={d.archive.archivedAt}>
          <AlertBanner level="info" title="Why this cohort was archived" detail={d.archive.reason} />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th align="right">Score</Th>
                  <Th>Ticker</Th>
                  <Th align="right">Opened</Th>
                  <Th align="right">Shares</Th>
                  <Th align="right">Avg cost</Th>
                  <Th align="right">Value at archive</Th>
                  <Th align="right">P&L at archive</Th>
                </tr>
              </thead>
              <tbody>
                {[...d.archive.positions].sort((a, b) => b.score - a.score).map((x) => (
                  <tr key={x.ticker} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                    <Td align="right"><ScoreBadge score={x.score} /></Td>
                    <Td>
                      <span className="font-semibold text-ink">{x.ticker}</span>
                      <span className="ml-2 hidden text-ink-3 lg:inline" title={x.rationale}>{x.company}</span>
                    </Td>
                    <Td align="right">{x.openedAt.slice(0, 10)}</Td>
                    <Td align="right">{x.shares}</Td>
                    <Td align="right">{fmtUsd(x.avgCost, { cents: true })}</Td>
                    <Td align="right" className="font-medium text-ink">{fmtUsd(x.currentValue)}</Td>
                    <Td align="right"><Delta usd={x.unrealizedPnl} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* --------------------------- policy & decision quality -------------------------- */}
      <SectionCard title="Sizing, exits & calibration policy">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Position sizing</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              Risk {fmtPct(RISK_PER_TRADE_PCT, 0)} of budget per trade; stop = entry × (1 − 2σ_daily√5);
              theme-concentration cap {fmtPct(THEME_CONCENTRATION_CAP, 0)} of paper deployable.
            </p>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Exit triggers</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              Stop hit · {TIME_STOP_DAYS}-day time-stop · thesis re-review when held {THESIS_CHECK_HELD_DAYS}d+
              and down {fmtPct(THESIS_CHECK_DOWN_PCT, 0)}+.
            </p>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Decision quality</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              {d.hasCalibration
                ? `Calibration data available (min n=${MIN_N_FOR_VERDICT} for a verdict).`
                : `No calibration.json yet — needs cohort 1 closed positions to reach n=${MIN_N_FOR_VERDICT}. Zero closed positions today → no win rate, no realized track record.`}
            </p>
          </div>
        </div>
      </SectionCard>
    </main>
  )
}
