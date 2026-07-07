// /discover — Autonomous discovery agent (paper portfolio).
//
// Layout:
//   ┌ StatTiles: paper budget · invested · paper P&L · next run ┐
//   ├ Candidate queue (8) ──────────────┬ Agent's book view (4)       ┤
//   │  bull/bear · sizing rationale ·   │  own positioning logic ·    │
//   │  book-fit chips · promote         │  theme concentration ·      │
//   │                                   │  next moves & exit triggers │
//   ├ Paper portfolio table (score · size band · opened · P&L)        ┤
//   ├ Decision quality (realized/unrealized · win rate · calibration) ┤
//   └──────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - Bull AND bear scores side by side — the adversarial review is the
//   feature (it exists to catch the AVGO trap); never show a bull score alone.
// - Every dollar amount carries its derivation (SizingBlock) — the sizing
//   chain from cli-discover.ts::computeAllocation is rendered term by term.
// - A candidate is never judged in isolation — but the yardstick is the
//   agent's OWN paper book (theme overlap, concentration, budget state),
//   not the real portfolio. This screen is the discovery agent's sandbox;
//   the investment agent's view of the REAL book lives on /portfolio.
// - Promote is the only primary-colored action on the page.
// - Weekly cadence is explicit ("next run Sunday") so an empty candidate
//   queue reads as "agent idle", not "agent broken".
// - Decision quality is honest about what can't be measured yet: zero
//   closed positions → no win rate, no realized track record (see
//   performance.tsx header for the full honesty contract).

import { loadDiscovery } from './data'
import { PromoteButton } from './promote-dialog'
import { SizingBlock, SizeBandChip } from './sizing-rationale'
import { PerformancePanel } from './performance'
import { StatTile, SectionCard, ScoreBadge, Delta, Th, Td, ConvictionBadge, Label } from '../_shared/ui'
import { fmtUsd, fmtSignedUsd, fmtPct } from '../_shared/format'

const FIT_STYLE: Record<string, string> = {
  new: 'border-hairline text-gain',
  adjacent: 'border-hairline text-ink-3',
  stacks: 'border-status-warning text-status-warning',
}
const EXIT_ICON: Record<string, string> = { thesis: '✕', score: '↓', drawdown: '▼', time: '⏱' }

export default async function DiscoveryPage() {
  const d = await loadDiscovery()
  const invested = d.holdings.reduce((s, x) => s + x.currentValue, 0)
  const pnl = d.holdings.reduce((s, x) => s + x.unrealizedPnl, 0)
  const costBasis = invested - pnl
  const maxDeployable = d.config.paperBudget * (1 - d.config.cashReservePct)

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Discovery agent</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Weekly Claude-driven screen → adversarial bull/bear review → paper positions. Nothing
            here is real money until you promote it.
          </p>
        </div>
        <span className="tnum text-[12px] text-ink-3">
          runs Sundays · next {d.nextRunAt.slice(0, 10)} · score threshold ≥ {d.config.threshold}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          label="Paper budget"
          value={fmtUsd(d.config.paperBudget)}
          footnote={`${fmtPct(d.config.cashReservePct, 0)} reserve → ${fmtUsd(maxDeployable)} deployable · ${fmtUsd(Math.max(0, maxDeployable - d.deployedUsd))} remaining`}
        />
        <StatTile label="Invested (paper)" value={fmtUsd(invested)} footnote={`${d.holdings.length} positions · ${fmtUsd(d.deployedUsd)} at cost — at the cap`} />
        <StatTile
          label="Paper P&L"
          value={fmtSignedUsd(pnl)}
          delta={<Delta pct={pnl / costBasis} />}
          footnote="unrealized marks only, incl. suspect KLAC price — see Decision quality below"
        />
        <StatTile
          label="vs SPY since open"
          value="—"
          footnote="needs paper value series + benchmark (backend gap #2)"
        />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* --------------------------- candidate queue --------------------------- */}
        <SectionCard title="Candidate queue" asOf={d.exportedAt} className="col-span-12 xl:col-span-8">
          {d.candidates.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">
              No candidates cleared the {d.config.threshold}-score bar this week. Next screen runs{' '}
              {d.nextRunAt.slice(0, 10)}.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {d.candidates.map((c) => (
                <li key={c.ticker} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <ScoreBadge score={c.score} bear={c.bearScore} />
                    <span className="text-[14px] font-semibold text-ink">{c.ticker}</span>
                    <span className="text-[13px] text-ink-3">{c.company}</span>
                    {c.conviction && <ConvictionBadge conviction={c.conviction as 'high' | 'medium' | 'low'} />}
                    <span className="tnum text-[13px] text-ink-2">{fmtUsd(c.currentPrice, { cents: true })}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button className="rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                        Watch
                      </button>
                      <button className="rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                        Dismiss
                      </button>
                      <PromoteButton
                        ticker={c.ticker}
                        company={c.company}
                        currentPrice={c.currentPrice}
                        paperShares={0}
                        rationale={c.rationale}
                      />
                    </div>
                  </div>

                  {/* Bull and bear, side by side — never the bull case alone. */}
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div className="rounded-chip border border-hairline p-2.5">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-gain">Bull · {c.score}</div>
                      <p className="text-[13px] leading-5 text-ink-2">{c.rationale}</p>
                    </div>
                    <div className="rounded-chip border border-hairline p-2.5">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-loss">
                        Bear · {c.bearScore ?? '—'}
                      </div>
                      <p className="text-[13px] leading-5 text-ink-2">
                        {c.bearRationale ?? 'Bear rationale not persisted — backend gap #5.'}
                      </p>
                    </div>
                  </div>

                  {/* Why this dollar amount — full derivation (Task 1). */}
                  <SizingBlock s={c.sizing} />

                  {/* Fit against the agent's OWN existing book (right rail) —
                      overlap and concentration, not the briefing's scenarios. */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
                      Book fit
                    </span>
                    {c.bookFit.map((f) => (
                      <span
                        key={f.theme}
                        className={`rounded-chip border px-1.5 py-0.5 text-[11px] ${FIT_STYLE[f.overlap]}`}
                        title={f.note}
                      >
                        {f.theme} · {f.overlap}
                      </span>
                    ))}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {c.bookFit.map((f) => (
                      <li key={f.theme} className="text-[12px] leading-4 text-ink-3">
                        <span className="mr-1 font-medium text-ink-2">{f.overlap}:</span>
                        {f.note}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ----------------------- agent's OWN book view ------------------------ */}
        {/* Self-contained to the discovery paper portfolio: its positioning
            logic, its concentration, its next moves. Deliberately NO reference
            to the real portfolio or the briefing's scenarios — the investment
            agent's view of the real book lives on /portfolio. */}
        <SectionCard title="Agent's book view" asOf={d.exportedAt} className="col-span-12 xl:col-span-4">
          <Label>Why it holds what it holds</Label>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">{d.bookView.positioning}</p>

          <div className="mt-3 border-t border-hairline pt-2">
            <Label>Theme concentration (of {fmtUsd(d.deployedUsd)} at cost)</Label>
            <div className="mt-1.5">
              {d.bookView.themes.map((t) => {
                const share = t.costUsd / d.deployedUsd
                return (
                  <div key={t.theme} className="flex items-center gap-2 py-[3px] text-[12px]">
                    <span className="w-[136px] shrink-0 truncate text-ink-2" title={t.tickers.join(' · ')}>
                      {t.theme}
                    </span>
                    <div className="h-[6px] flex-1 rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
                    </div>
                    <span className="tnum w-10 shrink-0 text-right text-ink">{fmtPct(share, 0)}</span>
                    <span className="tnum w-6 shrink-0 text-right text-ink-3">{t.tickers.length}</span>
                  </div>
                )
              })}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-ink-3">
              One theme, seven sub-layers — this book measures the AI-infra trade, so judge it against SMH,
              not SPY (see Decision quality).
            </p>
          </div>

          <div className="mt-3 border-t border-hairline pt-2">
            <Label>Watching for next run · {d.nextRunAt.slice(0, 10)}</Label>
            <ul className="mt-1 space-y-1.5">
              {d.bookView.watching.map((w, i) => (
                <li key={i} className="text-[12px] leading-4 text-ink-2">{w}</li>
              ))}
            </ul>
          </div>

          <div className="mt-3 border-t border-hairline pt-2">
            <Label>What would make it exit</Label>
            <ul className="mt-1 space-y-1.5">
              {d.bookView.exitTriggers.map((t) => (
                <li key={t.kind} className="flex gap-2 text-[12px] leading-4 text-ink-2">
                  <span aria-hidden className="shrink-0 text-ink-3">{EXIT_ICON[t.kind]}</span>
                  <span>
                    <span className="mr-1 font-medium uppercase text-[11px] tracking-[0.08em] text-ink-3">{t.kind}</span>
                    {t.rule}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-4 text-status-warning">⚠ {d.bookView.exitNote}</p>
          </div>
        </SectionCard>
      </div>

      {/* --------------------------- paper portfolio --------------------------- */}
      <SectionCard title="Paper portfolio" asOf={d.exportedAt}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th align="right">Score</Th>
                <Th>Ticker</Th>
                <Th align="right">Size band</Th>
                <Th align="right">Opened</Th>
                <Th align="right">Shares</Th>
                <Th align="right">Avg cost</Th>
                <Th align="right">Price</Th>
                <Th align="right">Value</Th>
                <Th align="right">P&L</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {[...d.holdings]
                .sort((a, b) => b.score - a.score)
                .map((x) => {
                  const ret = x.unrealizedPnl / (x.avgCost * x.shares)
                  return (
                    <tr key={x.ticker} className="group border-b border-hairline last:border-0 hover:bg-surface-2">
                      <Td align="right"><ScoreBadge score={x.score} /></Td>
                      <Td>
                        <span className="font-semibold text-ink">{x.ticker}</span>
                        <span className="ml-2 hidden text-ink-3 lg:inline" title={x.rationale}>
                          {x.company}
                        </span>
                      </Td>
                      <Td align="right"><SizeBandChip s={x.sizing} /></Td>
                      <Td align="right">{x.openedAt.slice(0, 10)}</Td>
                      <Td align="right">{x.shares}</Td>
                      <Td align="right">{fmtUsd(x.avgCost, { cents: true })}</Td>
                      <Td align="right">{fmtUsd(x.currentPrice, { cents: true })}</Td>
                      <Td align="right" className="font-medium text-ink">{fmtUsd(x.currentValue)}</Td>
                      <Td align="right"><Delta usd={x.unrealizedPnl} pct={ret} /></Td>
                      <Td align="right">
                        <span className="invisible group-hover:visible">
                          <PromoteButton
                            ticker={x.ticker}
                            company={x.company}
                            currentPrice={x.currentPrice}
                            paperShares={x.shares}
                            rationale={x.rationale}
                          />
                        </span>
                      </Td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Size band = score band × {fmtUsd(maxDeployable)} deployable at open time (12% / 8% / 5% by
          score, min&#8202;’d with remaining budget — hover a chip for the exact derivation; CEG shows
          the remaining-budget cap in action). Hover a row to reveal Promote; click a ticker for the
          full discovery record (score history, adversarial review, news evidence).
        </p>
      </SectionCard>

      {/* --------------------------- decision quality -------------------------- */}
      <PerformancePanel holdings={d.holdings} performance={d.performance} exportedAt={d.exportedAt} />
    </main>
  )
}
