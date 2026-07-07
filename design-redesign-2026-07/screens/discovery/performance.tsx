// Decision quality — does the discovery agent make good decisions? (Task 3b)
//
// Layout (full width, below the paper table):
//   ┌ measurement-honesty banner (what CANNOT be measured yet, and why) ┐
//   ├ Scoreboard: realized · unrealized (± suspect marks) · win rate · vs bench ┤
//   ├ Score calibration scatter (7) ─┬─ band summary + verdict (5)      ┤
//   ├ Decision log (all runs, incl. the five 0-decision weeks)          ┤
//   └ Closed-trades ledger (schema visible, honest empty state)         ┘
//
// Design intents:
// - REALIZED and UNREALIZED are never summed into one number. An open mark
//   is a claim; a closed trade is a fact. Today there are zero facts.
// - Every tile that can't be measured says so and names the blocker —
//   "N/A — no closed positions" is a finding, not a missing feature.
// - The calibration section mirrors the briefing's own self-tracking
//   (backtest/calibration.json, byConviction → calibrationInverted): the same
//   question asked of the 0–100 score. With one cohort of unrealized marks it
//   renders the evidence but refuses to issue a verdict.
// - Suspect data is excluded loudly, never silently: KLAC's −88% mark is
//   annotated and kept out of the aggregates, with both numbers shown.
// - The decision log includes the empty weeks. "93 candidates, 0 passed,
//   5 weeks running" is itself a decision-quality datum (the screen is
//   saturated and the budget cap has frozen the agent).

import type { DiscoveryPerformance, HoldingVM } from './data'
import { SectionCard, AlertBanner, Label, Th, Td, Delta } from '../_shared/ui'
import { fmtUsd, fmtSignedUsd, fmtSignedPct } from '../_shared/format'

const cx = (...c: Array<string | false | undefined | null>) => c.filter(Boolean).join(' ')

/* ------------------------------ derivations ------------------------------ */

interface Mark {
  ticker: string
  score: number
  costUsd: number
  pnlUsd: number
  ret: number // fraction
  suspect: boolean
}

function marks(holdings: HoldingVM[], suspectTickers: string[]): Mark[] {
  return holdings.map((h) => {
    const costUsd = h.shares * h.avgCost
    return {
      ticker: h.ticker,
      score: h.score,
      costUsd,
      pnlUsd: h.unrealizedPnl,
      ret: h.unrealizedPnl / costUsd,
      suspect: suspectTickers.includes(h.ticker),
    }
  })
}

function agg(ms: Mark[]) {
  const cost = ms.reduce((s, m) => s + m.costUsd, 0)
  const pnl = ms.reduce((s, m) => s + m.pnlUsd, 0)
  return { cost, pnl, ret: cost ? pnl / cost : 0, n: ms.length }
}

const BANDS = [
  { label: '90–100', lo: 90, hi: 101 },
  { label: '80–89', lo: 80, hi: 90 },
  { label: '70–79', lo: 70, hi: 80 },
]

/* --------------------------------- panel ---------------------------------- */

export function PerformancePanel({
  holdings,
  performance,
  exportedAt,
}: {
  holdings: HoldingVM[]
  performance: DiscoveryPerformance
  exportedAt: string
}) {
  const all = marks(holdings, performance.suspectTickers)
  const clean = all.filter((m) => !m.suspect)
  const suspect = all.filter((m) => m.suspect)
  const totalAll = agg(all)
  const totalClean = agg(clean)
  const greens = all.filter((m) => m.pnlUsd > 0).length
  const firstOpen = holdings.map((h) => h.openedAt).sort()[0]?.slice(0, 10) ?? '—'
  const closed = performance.closed
  const totalOpened = performance.runs.reduce((s, r) => s + r.positionsOpened, 0)
  const idleRuns = performance.runs.filter((r) => r.positionsOpened === 0).length

  return (
    <SectionCard title="Decision quality" asOf={exportedAt}>
      {/* What this section can and cannot claim, before any number. */}
      <AlertBanner
        level="warning"
        title="Only unrealized marks exist so far"
        detail={`${totalOpened} buys (all opened ${firstOpen}–06-03), 0 sells — exits are not implemented (no closePosition in paper-portfolio.ts), so every number below is mark-to-market on one open cohort, not a track record. Benchmark levels were never snapshotted at entry (gap #2). KLAC's price mark fails sanity checks and is excluded from aggregates below.`}
      />

      {/* ------------------------------ scoreboard ---------------------------- */}
      <div className="mt-4 grid grid-cols-2 divide-hairline border-y border-hairline md:grid-cols-4 md:divide-x">
        <div className="px-4 py-3 first:pl-0">
          <Label>Realized P&L</Label>
          <div className="tnum mt-1 text-[22px] font-semibold leading-[28px] text-ink">$0</div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            0 closed trades in {performance.runs.length} runs since {firstOpen} — the agent has never exited.
          </div>
        </div>
        <div className="px-4 py-3">
          <Label>Unrealized P&L (open marks)</Label>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="tnum text-[22px] font-semibold leading-[28px] text-ink">{fmtSignedUsd(totalClean.pnl)}</span>
            <Delta pct={totalClean.ret} />
          </div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            {clean.length} of {all.length} positions · {fmtSignedUsd(totalAll.pnl)} ({fmtSignedPct(totalAll.ret)}) if KLAC's suspect mark is included.
          </div>
        </div>
        <div className="px-4 py-3">
          <Label>Win rate (closed only)</Label>
          <div className="mt-1 text-[22px] font-semibold leading-[28px] text-ink-3">N/A</div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            No closed positions yet. Open marks: {greens} of {all.length} green — that is exposure, not a win rate.
          </div>
        </div>
        <div className="px-4 py-3 last:pr-0">
          <Label>vs SPY · SMH since {firstOpen}</Label>
          <div className="mt-1 text-[22px] font-semibold leading-[28px] text-ink-3">
            {performance.benchmark.spySinceOpen == null ? '—' : fmtSignedPct(performance.benchmark.spySinceOpen)}
          </div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            Not measurable yet — no benchmark level captured at entry (gap #2). Backfillable: SPY/SMH closes for {firstOpen} are public. SMH is the honest yardstick — 15 of 16 picks are AI/semis.
          </div>
        </div>
      </div>

      {/* ---------------------------- calibration ----------------------------- */}
      <div className="mt-5 grid grid-cols-12 gap-6">
        <div className="col-span-12 xl:col-span-7">
          <Label>Does the 0–100 score predict return?</Label>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            Each dot is one open position: bull score at open (x) vs unrealized return after ~5 weeks (y).
            Same question the briefing asks of its conviction labels (backtest/calibration.json — which
            caught HIGH-conviction calls running 18.5pp <em>below</em> MEDIUM).
          </p>
          <CalibrationScatter marks={clean} />
          {suspect.map((m) => {
            const h = holdings.find((x) => x.ticker === m.ticker)!
            return (
              <p key={m.ticker} className="mt-1.5 text-[11px] leading-4 text-status-warning">
                ⚠ {m.ticker} (score {m.score}, {fmtSignedPct(m.ret)}) not plotted — marked{' '}
                {fmtUsd(h.avgCost, { cents: true })} → {fmtUsd(h.currentPrice, { cents: true })} in 5 weeks with no
                corroborating market event; almost certainly a price-feed error (split-style mismatch). Flagged for
                the pipeline, excluded from all aggregates on this screen.
              </p>
            )
          })}
        </div>

        <div className="col-span-12 xl:col-span-5">
          <Label>By score band (unrealized, ex-KLAC)</Label>
          <div className="mt-2 space-y-1">
            {BANDS.map((b) => {
              const inBand = clean.filter((m) => m.score >= b.lo && m.score < b.hi)
              const a = agg(inBand)
              return <BandBar key={b.label} label={b.label} n={a.n} ret={a.ret} />
            })}
          </div>
          <div className="mt-3 rounded-chip bg-surface-2 p-2.5 text-[12px] leading-[18px] text-ink-2">
            <span className="font-semibold text-ink">No calibration verdict yet.</span> One cohort, one theme,
            n={clean.length}, zero exits — band returns currently measure five weeks of AI-infra beta, not
            scoring skill. What a real signal will look like here: 90+ consistently above 80–89 above 70–79
            on <em>closed</em> trades across ≥3 cohorts. What inversion looks like: the briefing's own
            <span className="tnum"> calibrationInverted: true</span> — if score-95 keeps landing under
            score-71, the threshold and bands are miscalibrated and sizing (12/8/5% by band) is amplifying
            the wrong picks.
          </div>
        </div>
      </div>

      {/* ----------------------------- decision log --------------------------- */}
      <div className="mt-5">
        <Label>Decision log — every run, including the empty ones</Label>
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Run date</Th>
                <Th align="right">Candidates found</Th>
                <Th align="right">Passed filter</Th>
                <Th align="right">Opened</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {performance.runs.map((r, i) => (
                <tr key={i} className={cx('border-b border-hairline last:border-0', r.positionsOpened === 0 && 'text-ink-3')}>
                  <Td>{r.date}</Td>
                  <Td align="right">{r.candidatesFound}</Td>
                  <Td align="right">{r.passedFilter}</Td>
                  <Td align="right" className={r.positionsOpened > 0 ? 'font-medium text-ink' : undefined}>
                    {r.positionsOpened}
                  </Td>
                  <Td className="whitespace-normal">{r.note ?? ''}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          All {totalOpened} positions came from the first two runs; the {idleRuns} runs since have found 92–93
          candidates and passed zero — every candidate is already held or a duplicate, and the budget cap
          blocks new opens anyway. Five-plus weeks of runs ≠ five-plus weeks of decisions: this is one
          decision event, then a frozen book.
        </p>
      </div>

      {/* ------------------------- closed-trades ledger ------------------------ */}
      <div className="mt-5">
        <Label>Closed positions — realized track record</Label>
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Ticker</Th>
                <Th align="right">Score at open</Th>
                <Th align="right">Opened</Th>
                <Th align="right">Closed</Th>
                <Th align="right">Held</Th>
                <Th align="right">Exit price</Th>
                <Th align="right">Realized P&L</Th>
                <Th>Exit reason</Th>
              </tr>
            </thead>
            <tbody>
              {closed.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-[13px] text-ink-3">
                    None yet — and none possible: the backend has no close path. When exits land, win rate,
                    avg win vs avg loss, hold time, and score-band calibration on <em>realized</em> returns
                    all populate from this ledger.
                  </td>
                </tr>
              ) : (
                closed.map((c) => (
                  <tr key={c.ticker + c.closedAt} className="border-b border-hairline last:border-0">
                    <Td className="font-semibold text-ink">{c.ticker}</Td>
                    <Td align="right">{c.scoreAtOpen}</Td>
                    <Td align="right">{c.openedAt.slice(0, 10)}</Td>
                    <Td align="right">{c.closedAt.slice(0, 10)}</Td>
                    <Td align="right">
                      {Math.round((new Date(c.closedAt).getTime() - new Date(c.openedAt).getTime()) / 864e5)}d
                    </Td>
                    <Td align="right">{fmtUsd(c.exitPrice, { cents: true })}</Td>
                    <Td align="right"><Delta usd={c.realizedPnl} pct={c.realizedPnl / (c.shares * c.avgCost)} /></Td>
                    <Td className="whitespace-normal">{c.exitReason}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  )
}

/* --------------------------- calibration scatter --------------------------- */
// Score (x) vs unrealized return (y). Dots use the reserved gain/loss pair —
// this chart IS the P&L — with sign double-encoded by position vs the zero
// line. Selective direct labels on extremes only; every dot has a tooltip.

const W = 560
const H = 220
const PAD = { l: 46, r: 16, t: 10, b: 28 }

function CalibrationScatter({ marks }: { marks: Mark[] }) {
  const xMin = 68
  const xMax = 97
  const yMin = -0.5
  const yMax = 0.3
  const x = (s: number) => PAD.l + ((s - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r)
  const y = (r: number) => PAD.t + (1 - (r - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b)
  const yTicks = [-0.4, -0.2, 0, 0.2]
  const xTicks = [70, 75, 80, 85, 90, 95]
  // Selective labels: best, worst, highest score, plus AVGO (the trap the
  // adversarial review exists to catch).
  const labeled = new Set(['AMAT', 'ORCL', 'NVDA', 'AVGO'])

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 w-full max-w-[640px]"
      role="img"
      aria-label={`Scatter of bull score vs unrealized return for ${marks.length} open paper positions`}
    >
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? 'var(--ink-3)' : 'var(--grid)'}
            strokeWidth={1}
          />
          <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-3)" className="tnum">
            {t === 0 ? '0' : fmtSignedPct(t, 0)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={t} x={x(t)} y={H - PAD.b + 16} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="tnum">
          {t}
        </text>
      ))}
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
        bull score at open
      </text>
      {marks.map((m) => (
        <g key={m.ticker}>
          <circle
            cx={x(m.score)}
            cy={y(m.ret)}
            r={4.5}
            fill={m.pnlUsd >= 0 ? 'var(--gain)' : 'var(--loss)'}
            stroke="var(--surface)"
            strokeWidth={2}
          >
            <title>{`${m.ticker} — score ${m.score}, ${fmtSignedPct(m.ret)} (${fmtSignedUsd(m.pnlUsd)}) unrealized`}</title>
          </circle>
          {labeled.has(m.ticker) && (
            <text
              x={x(m.score) + 7}
              y={y(m.ret) + 3.5}
              fontSize={10}
              fontWeight={500}
              fill="var(--ink-2)"
            >
              {m.ticker} {fmtSignedPct(m.ret, 0)}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

/* ------------------------------ band summary ------------------------------ */
// Diverging horizontal bar around a zero baseline; loss/gain reserved colors.

function BandBar({ label, n, ret }: { label: string; n: number; ret: number }) {
  const max = 0.2 // ±20% display range
  const mag = Math.min(Math.abs(ret) / max, 1) * 50 // % of half-track
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="tnum w-14 shrink-0 text-[13px] font-medium text-ink">{label}</span>
      <span className="tnum w-8 shrink-0 text-[11px] text-ink-3">n={n}</span>
      <div className="relative h-[10px] flex-1 rounded-full bg-surface-2">
        <div className="absolute top-[-2px] bottom-[-2px] left-1/2 w-[2px] bg-ink-3" />
        <div
          className="absolute top-0 h-full"
          style={{
            left: ret < 0 ? `${50 - mag}%` : '50%',
            width: `${mag}%`,
            backgroundColor: ret < 0 ? 'var(--loss)' : 'var(--gain)',
            borderRadius: 4,
          }}
        />
      </div>
      <span className={cx('tnum w-16 shrink-0 text-right text-[13px] font-medium', ret < 0 ? 'text-loss' : ret > 0 ? 'text-gain' : 'text-ink-3')}>
        {n === 0 ? '—' : fmtSignedPct(ret)}
      </span>
    </div>
  )
}
