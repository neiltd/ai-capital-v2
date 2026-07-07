// Sizing rationale — WHY this dollar amount (Task: transparency of sizing).
//
// Mirrors the actual allocator in
// apps/scenario-simulator/src/cli/cli-discover.ts::computeAllocation():
//
//   maxDeployable = BUDGET × (1 − CASH_RESERVE_PCT /* 0.20 */)
//   band          = score ≥ 90 → 12% · score ≥ 80 → 8% · else → 5%
//   nominal       = maxDeployable × band       (sized on TOTAL deployable,
//                                               not remaining — positions
//                                               stay consistent size)
//   allocated     = min(nominal, remaining)    (never exceed budget)
//
// The UI shows every term of that chain — a number without its derivation
// is exactly the kind of silently-wrong figure this redesign exists to kill.

import type { SizingRationale } from './data'
import { fmtUsd, fmtPct } from '../_shared/format'

export function SizingBlock({ s }: { s: SizingRationale }) {
  return (
    <div className="mt-2 rounded-chip bg-surface-2 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Sizing</span>
        <span className="tnum text-[14px] font-semibold text-ink">
          {s.blocked ? '$0' : fmtUsd(s.allocatedUsd)}
        </span>
        {s.blocked ? (
          <span className="rounded-chip border border-status-warning px-1.5 py-0.5 text-[11px] font-medium text-status-warning">
            ⚠ blocked — book fully deployed
          </span>
        ) : s.cappedByRemaining ? (
          <span className="rounded-chip border border-status-warning px-1.5 py-0.5 text-[11px] text-status-warning">
            capped by remaining budget
          </span>
        ) : null}
      </div>

      {/* Derivation chain — every term of computeAllocation(), in order. */}
      <div className="tnum mt-1.5 text-[12px] leading-[18px] text-ink-2">
        {fmtUsd(s.paperBudget)} budget − {fmtPct(s.cashReservePct, 0)} cash reserve ={' '}
        <span className="font-medium text-ink">{fmtUsd(s.maxDeployable)}</span> deployable
        <span className="mx-1.5 text-ink-3">·</span>
        score {s.score} → <span className="font-medium text-ink">{fmtPct(s.bandPct, 0)} band</span>{' '}
        ({fmtUsd(s.nominalUsd)} nominal)
        <span className="mx-1.5 text-ink-3">·</span>
        deployed {fmtUsd(s.deployedUsd)} → remaining{' '}
        <span className={s.remainingUsd < s.nominalUsd ? 'font-medium text-status-warning' : 'font-medium text-ink'}>
          {fmtUsd(s.remainingUsd)}
        </span>
      </div>
      <div className="mt-0.5 text-[12px] leading-[18px] text-ink-3">
        {s.blocked
          ? 'min(nominal, remaining) ≈ $0 — a paper position must close (or the budget must grow) before this opens.'
          : s.cappedByRemaining
            ? `min(nominal, remaining) = ${fmtUsd(s.allocatedUsd)} — same rule that sized CEG at 3% instead of its 5% band.`
            : `min(nominal, remaining) = ${fmtUsd(s.allocatedUsd)} — full ${fmtPct(s.bandPct, 0)} band fits within remaining budget.`}
      </div>

      <BudgetBar s={s} />
    </div>
  )
}

/** One horizontal bar of the whole paper budget: deployed · remaining · reserve. */
function BudgetBar({ s }: { s: SizingRationale }) {
  const deployedPct = (s.deployedUsd / s.paperBudget) * 100
  const remainingPct = (s.remainingUsd / s.paperBudget) * 100
  const reservePct = s.cashReservePct * 100
  return (
    <div className="mt-2">
      <div className="flex h-[6px] overflow-hidden rounded-full">
        <div className="bg-accent" style={{ width: `${deployedPct}%` }} title={`Deployed ${fmtUsd(s.deployedUsd)}`} />
        <div style={{ width: `${Math.max(remainingPct, 0.3)}%`, backgroundColor: 'var(--ink-3)' }} title={`Remaining ${fmtUsd(s.remainingUsd)}`} />
        <div
          className="bg-surface"
          style={{
            width: `${reservePct}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, var(--ink-3) 0 1px, transparent 1px 5px)',
          }}
          title={`Cash reserve ${fmtUsd(s.paperBudget * s.cashReservePct)} — never deployed`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-3">
        <span>deployed {fmtUsd(s.deployedUsd)}</span>
        <span>remaining {fmtUsd(s.remainingUsd)}</span>
        <span>reserve {fmtPct(s.cashReservePct, 0)} (untouchable)</span>
      </div>
    </div>
  )
}

/** Compact band chip for the paper table — full derivation in the title tooltip. */
export function SizeBandChip({ s }: { s: SizingRationale }) {
  return (
    <span
      className="tnum rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2"
      title={`score ${s.score} → ${(s.bandPct * 100).toFixed(0)}% of ${fmtUsd(s.maxDeployable)} deployable = ${fmtUsd(s.nominalUsd)}${
        s.cappedByRemaining ? ` · capped to ${fmtUsd(s.allocatedUsd)} by remaining budget` : ''
      }`}
    >
      {(s.bandPct * 100).toFixed(0)}%{s.cappedByRemaining ? '↓' : ''} · {fmtUsd(s.allocatedUsd)}
    </span>
  )
}
