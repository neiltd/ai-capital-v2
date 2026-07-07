// /markets/gov — Government contract flow.
// (Supersedes screens/specs/gov-contracts.md.)
//
// Layout:
//   ┌ StatTiles: awards 30d ($) · count · top agency · held-ticker $ ──────┐
//   ├ Watch-trigger progress note (PLTR 2nd >$100M — 1 of 2, 60d window)   ┤
//   ├ Award flow: monthly $ bars, 12mo, held-ticker inner segment          ┤
//   ├ Awards table (8, filterable)        │ Legislation watch (4)          ┤
//   └─────────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - Held-ticker relevance is the point: held rows carry an accent left edge,
//   the flow chart shows "of which: held" as a stacked inner series (the ONE
//   allowed second series, with legend), and the top-line stat splits it out.
// - The legislation stepper stays neutral ink with the current stage bolded —
//   a bill stage is a fact, not a verdict.

import { loadGov } from './data'
import { AwardsTable } from './awards-table'
import { StatTile, SectionCard, AsOf } from '../_shared/ui'
import { fmtUsd } from '../_shared/format'

export default async function GovPage() {
  const g = await loadGov()

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Government flow</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            USASpending.gov AI-contract awards to watchlist vendors + the bills that fund them.
          </p>
        </div>
        <AsOf iso={g.exportedAt} />
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Awards 30d" value={fmtUsd(g.awards30d.totalUsd)} footnote="watchlist vendors only" />
        <StatTile label="Award count 30d" value={String(g.awards30d.count)} />
        <StatTile label="Top agency" value="DHS" footnote={g.awards30d.topAgency} />
        <StatTile
          label="→ held tickers"
          value={fmtUsd(g.awards30d.heldUsd)}
          footnote={`${((g.awards30d.heldUsd / g.awards30d.totalUsd) * 100).toFixed(0)}% of 30d flow lands on names you own (PLTR)`}
        />
      </div>

      {/* Briefing watch-trigger progress — same trigger as /today's watch list. */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-hairline bg-surface px-4 py-3">
        <span className="text-[13px] font-semibold text-ink">{g.triggerProgress.label}</span>
        <span className="tnum rounded-chip bg-surface-2 px-2 py-0.5 text-[12px] text-ink">
          {g.triggerProgress.achieved} of {g.triggerProgress.needed}
        </span>
        <span className="tnum text-[12px] text-ink-3">60d window ends {g.triggerProgress.windowEnds}</span>
        <a href="/today" className="ml-auto text-[12px] text-accent">Watch item →</a>
        <p className="w-full text-[12px] leading-4 text-ink-3">{g.triggerProgress.detail}</p>
      </div>

      {/* ------------------------------- flow chart ------------------------------ */}
      <SectionCard title="Award flow — monthly, 12mo" asOf={g.exportedAt}>
        <MonthlyBars monthly={g.monthly} />
        <div className="mt-2 flex items-center gap-4 text-[12px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-accent opacity-40" /> all watchlist vendors
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" /> of which: held tickers
          </span>
          <span className="ml-auto text-[11px] text-ink-3">
            series illustrative until the monthly aggregation endpoint lands (gap #22)
          </span>
        </div>
      </SectionCard>

      <div className="grid grid-cols-12 gap-6">
        {/* ------------------------------ awards table ----------------------------- */}
        <SectionCard title="Awards" asOf={g.exportedAt} className="col-span-12 xl:col-span-8">
          <AwardsTable rows={g.awards} />
        </SectionCard>

        {/* --------------------------- legislation watch --------------------------- */}
        <SectionCard title="Legislation watch" className="col-span-12 xl:col-span-4">
          <ul className="space-y-4">
            {g.bills.map((b) => (
              <li key={b.bill}>
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-ink">{b.title}</span>
                  <span className="tnum text-[11px] text-ink-3">{b.bill}</span>
                  {b.watchTrigger && (
                    <a href="/today" className="ml-auto text-[11px] text-accent" title={b.watchTrigger}>
                      watch item →
                    </a>
                  )}
                </div>
                {/* stage stepper: neutral ink, current stage bolded */}
                <ol className="mt-1.5 flex items-center gap-1">
                  {b.stages.map((s, idx) => {
                    const currentIdx = b.stages.findIndex((x) => x.id === b.currentStage)
                    const state = idx < currentIdx ? 'done' : idx === currentIdx ? 'current' : 'todo'
                    return (
                      <li key={s.id} className="flex items-center gap-1">
                        {idx > 0 && <span className="h-px w-3 bg-hairline" aria-hidden />}
                        <span
                          className={
                            state === 'current'
                              ? 'rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink'
                              : state === 'done'
                                ? 'text-[11px] text-ink-2'
                                : 'text-[11px] text-ink-3'
                          }
                        >
                          {state === 'done' && <span aria-hidden className="mr-0.5">✓</span>}
                          {s.label}
                        </span>
                      </li>
                    )
                  })}
                </ol>
                <p className="mt-1 text-[12px] leading-4 text-ink-3">{b.note}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-hairline pt-2 text-[11px] leading-4 text-ink-3">
            Stages are hand-tracked from briefing prose today — a congress.gov fetcher makes this
            stepper live (gap #22).
          </p>
        </SectionCard>
      </div>
    </main>
  )
}

/* --------------------------- monthly stacked bars --------------------------- */
// Single-hue stack (accent + 40% alpha base), 2 series max, 4px rounded ends,
// 2px gaps, direct label on the latest complete month.

function MonthlyBars({ monthly }: { monthly: Array<{ month: string; totalUsd: number; heldUsd: number; topAwards: string[] }> }) {
  const W = 980, H = 220, PAD = { l: 8, r: 8, t: 20, b: 24 }
  const bw = (W - PAD.l - PAD.r) / monthly.length
  const max = Math.max(...monthly.map((m) => m.totalUsd)) * 1.08
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b)

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img" aria-label="Monthly awarded dollars, watchlist vendors, with held-ticker share" className="max-w-full">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth={1} />
        {monthly.map((m, idx) => {
          const x = PAD.l + idx * bw + 3
          const w = bw - 6
          const latestComplete = idx === monthly.length - 2 // July is MTD
          return (
            <g key={m.month}>
              {/* total (recessive) */}
              <rect x={x} y={y(m.totalUsd)} width={w} height={H - PAD.b - y(m.totalUsd)} rx={4} fill="var(--accent)" opacity={0.35}>
                <title>{`${m.month}: ${fmt(m.totalUsd)} total · ${fmt(m.heldUsd)} held — ${m.topAwards.join('; ')}`}</title>
              </rect>
              {/* held inner segment, 2px gap above baseline shared */}
              {m.heldUsd > 0 && (
                <rect x={x} y={y(m.heldUsd)} width={w} height={H - PAD.b - y(m.heldUsd)} rx={4} fill="var(--accent)">
                  <title>{`${m.month}: held tickers ${fmt(m.heldUsd)}`}</title>
                </rect>
              )}
              {latestComplete && (
                <text x={x + w / 2} y={y(m.totalUsd) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ink)" className="tnum">
                  {fmt(m.totalUsd)}
                </text>
              )}
              <text x={x + w / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="tnum">
                {m.month.slice(2).replace('-', '/')}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

const fmt = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`)
