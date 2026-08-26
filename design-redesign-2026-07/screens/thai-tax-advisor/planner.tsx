'use client'

// Thai Tax Planner — interactive client screen (mockup).
//
// One client component owns all state (income, household, planned amounts)
// because every surface recomputes live from the same evaluatePlan() calls:
// stat tiles, category rows, combo meters, bracket ladder, advisor deltas.
//
// Layout (12-col):
//   ┌ header: title · agent-run stamp ─────────────────────────────────────┐
//   ├ AlertBanner: tool-generated estimate, not licensed advice            ┤
//   ├ StatTiles: income(editable) · tax before · tax with plan(hero)       │
//   │            · saved by plan · marginal bracket                        ┤
//   ├ Deduction planner (7)             │ Bracket ladder (5)               ┤
//   │   household & automatic           │ Advisor picks (agent output)     │
//   │   retirement combo ฿500k          │ Agent flags                      │
//   │   ThaiESG · insurance · giving    │                                  │
//   ├ From your portfolio (7)           │                                  ┤
//   └ Method & assumptions (12) ────────────────────────────────────────────┘
//
// Colors: capacity meters use two steps of the app's validated sequential
// blue (accent = contributed, #86b6ef = planned) with a 2px surface gap and
// direct text labels — identity is never color-alone. Status colors only for
// warnings. Single-series marks → no legends beyond the one meter key.

import { useMemo, useState } from 'react'
import {
  evaluatePlan,
  PIT_BRACKETS_2026,
  type ContribId,
  type PlanResult,
} from './tax-engine'
import {
  ADVISOR_PLAN,
  ADVISOR_RUN,
  AGENT_FLAGS,
  DRY_POWDER_THB,
  SAMPLE_PROFILE,
  TAX_HOLDINGS,
  TAX_YEAR,
  USD_THB,
  USED_2026,
  type AdvisorRec,
} from './data'
import { ActionBadge, AlertBanner, ConvictionBadge, Label, SectionCard, StrategyTag, Th, Td } from '@/components/next/ui'
import { fmtThb } from '@/lib/next/format'

const PLANNED_FILL = '#86b6ef' // lighter step of the validated sequential blue

const usedOf = (id: ContribId) => USED_2026[id] ?? 0

/* ------------------------------ small pieces ------------------------------ */

function AmountInput({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <input
      inputMode="numeric"
      value={value === 0 ? '' : value.toLocaleString('en-US')}
      placeholder="0"
      onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
      className="tnum w-[92px] rounded-chip border border-hairline bg-surface-2 px-2 py-1 text-right text-[13px] text-ink outline-none focus:border-accent"
      aria-label="planned amount THB"
    />
  )
}

function ChipButton({
  onClick,
  children,
  active = false,
  title,
}: {
  onClick: () => void
  children: React.ReactNode
  active?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-chip border px-2 py-1 text-[12px] transition-colors ${
        active
          ? 'border-accent text-ink bg-surface-2'
          : 'border-hairline text-ink-2 hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function Stepper({
  label,
  value,
  onChange,
  max = 9,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  max?: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-chip border border-hairline px-2 py-1 text-[12px] text-ink-2">
      {label}
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} className="px-1 text-ink-3 hover:text-ink" aria-label={`fewer ${label}`}>−</button>
      <span className="tnum min-w-3 text-center font-medium text-ink">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} className="px-1 text-ink-3 hover:text-ink" aria-label={`more ${label}`}>+</button>
    </span>
  )
}

/** Capacity meter: contributed (accent) + planned (lighter step) over a
 *  surface-2 track, 2px gaps. Values are always ALSO printed as text. */
function CapacityBar({ used, planned, cap }: { used: number; planned: number; cap: number }) {
  if (!Number.isFinite(cap) || cap <= 0) return null
  const u = Math.min(used, cap)
  const p = Math.min(planned, Math.max(0, cap - u))
  return (
    <div className="mt-1.5 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2" aria-hidden>
      {u > 0 && <div className="rounded-full" style={{ width: `${(u / cap) * 100}%`, background: 'var(--accent)' }} />}
      {p > 0 && <div className="rounded-full" style={{ width: `${(p / cap) * 100}%`, background: PLANNED_FILL }} />}
    </div>
  )
}

/* ------------------------------ category row ------------------------------ */

interface RowMeta {
  id: ContribId
  label: string
  capText: string
  noMax?: boolean // donation caps depend on evaluation order — Max is misleading
}

function CategoryRow({
  meta,
  plan,
  planned,
  onPlanned,
}: {
  meta: RowMeta
  plan: PlanResult
  planned: number
  onPlanned: (v: number) => void
}) {
  const used = usedOf(meta.id)
  const c = plan.contributions[meta.id]
  const cap = c.ownCap
  const room = Math.max(0, Math.min(cap, Number.MAX_SAFE_INTEGER) - used - planned)
  return (
    <div className="border-b border-hairline py-2.5 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{meta.label}</div>
          <div className="text-[11px] text-ink-3">{meta.capText}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPlanned(Math.max(0, planned - 10_000))}
            className="rounded-chip border border-hairline px-1.5 py-1 text-[12px] text-ink-3 hover:text-ink"
            aria-label="minus ten thousand"
          >
            −10k
          </button>
          <AmountInput value={planned} onChange={onPlanned} />
          <button
            type="button"
            onClick={() => onPlanned(planned + 10_000)}
            className="rounded-chip border border-hairline px-1.5 py-1 text-[12px] text-ink-3 hover:text-ink"
            aria-label="plus ten thousand"
          >
            +10k
          </button>
          {!meta.noMax && Number.isFinite(cap) && (
            <ChipButton onClick={() => onPlanned(Math.max(0, Math.floor(cap) - used))} title="fill remaining room">
              Max
            </ChipButton>
          )}
        </div>
      </div>
      <CapacityBar used={used} planned={planned} cap={cap} />
      <div className="tnum mt-1 text-[11px] text-ink-3">
        contributed {fmtThb(used)} · planned +{fmtThb(planned)} · room {fmtThb(room)}
        {Number.isFinite(cap) && <> of {fmtThb(cap)}</>}
      </div>
      {c.clamped && (
        <div className="mt-1 text-[11px] font-medium text-status-warning">
          ⚠ capped — only {fmtThb(c.effective)} deducts (shared or statutory limit reached)
        </div>
      )}
    </div>
  )
}

/* --------------------------------- screen --------------------------------- */

export function TaxPlannerScreen() {
  const [income, setIncome] = useState(SAMPLE_PROFILE.assessableIncome)
  const [spouse, setSpouse] = useState(SAMPLE_PROFILE.spouseNoIncome)
  const [children, setChildren] = useState(SAMPLE_PROFILE.children)
  const [parents, setParents] = useState(SAMPLE_PROFILE.dependentParents)
  const [planned, setPlanned] = useState<Partial<Record<ContribId, number>>>({})
  const [applied, setApplied] = useState<string[]>([])

  const profile = useMemo(
    () => ({ assessableIncome: income, spouseNoIncome: spouse, children, dependentParents: parents }),
    [income, spouse, children, parents],
  )

  const combined = useMemo(() => {
    const m: Partial<Record<ContribId, number>> = { ...USED_2026 }
    for (const [id, v] of Object.entries(planned) as Array<[ContribId, number]>) m[id] = (m[id] ?? 0) + v
    return m
  }, [planned])

  const before = useMemo(() => evaluatePlan(profile, USED_2026), [profile])
  const after = useMemo(() => evaluatePlan(profile, combined), [profile, combined])
  const savings = before.tax.total - after.tax.total
  const plannedTotal = Object.values(planned).reduce((s, v) => s + (v ?? 0), 0)

  const setPlan = (id: ContribId) => (v: number) => setPlanned((p) => ({ ...p, [id]: v }))
  const plannedOf = (id: ContribId) => planned[id] ?? 0

  const recSaving = (rec: AdvisorRec) => {
    const plus = { ...combined, [rec.category]: (combined[rec.category] ?? 0) + rec.amountTHB }
    return after.tax.total - evaluatePlan(profile, plus).tax.total
  }
  const addRec = (rec: AdvisorRec) => {
    setPlanned((p) => ({ ...p, [rec.category]: (p[rec.category] ?? 0) + rec.amountTHB }))
    setApplied((a) => [...a, rec.id])
  }
  const removeRec = (rec: AdvisorRec) => {
    setPlanned((p) => ({ ...p, [rec.category]: Math.max(0, (p[rec.category] ?? 0) - rec.amountTHB) }))
    setApplied((a) => a.filter((id) => id !== rec.id))
  }
  const applyAll = () => ADVISOR_RUN.recs.forEach((r) => !applied.includes(r.id) && addRec(r))
  const resetPlan = () => {
    setPlanned({})
    setApplied([])
  }

  // Static plan copy for row rendering (advisor deltas already use `after`).
  const comboPlannedDelta = after.retirementCombo.used - before.retirementCombo.used

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Thai Tax Planner</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Senior Thai-PIT advisor agent · tax year {TAX_YEAR} · amounts in THB (FX {USD_THB})
          </p>
        </div>
        <span className="text-[12px] text-ink-3">
          advisor run today 07:42 · {ADVISOR_RUN.inputsNote}
        </span>
      </header>

      <AlertBanner
        level="info"
        title="Tool-generated estimate — not licensed tax or financial advice."
        detail="Bracket and cap figures are encoded in tax-engine.ts from the 2026 Revenue Department schedule; verify with the RD or a licensed advisor before purchasing anything."
      />

      {/* -------------------------------- tiles ------------------------------- */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
          <Label>Assessable income {TAX_YEAR}</Label>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-stat-value font-semibold text-ink">฿</span>
            <input
              inputMode="numeric"
              value={income.toLocaleString('en-US')}
              onChange={(e) => setIncome(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
              className="tnum w-full bg-transparent text-stat-value font-semibold text-ink outline-none"
              aria-label="assessable income THB"
            />
          </div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">sample figure — type yours; employment income §40(1)</div>
        </div>
        <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
          <Label>Est. tax — before plan</Label>
          <div className="tnum mt-1 text-stat-value font-semibold text-ink">{fmtThb(before.tax.total)}</div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">committed 2026 deductions only</div>
        </div>
        <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
          <Label>Est. tax — with plan</Label>
          <div className="tnum mt-1 text-stat-hero font-semibold text-ink">{fmtThb(after.tax.total)}</div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            effective {(after.tax.effectiveRate * 100).toFixed(1)}% of net {fmtThb(after.netTaxable)}
          </div>
        </div>
        <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
          <Label>Saved by plan</Label>
          <div className={`tnum mt-1 text-stat-value font-semibold ${savings > 0 ? 'text-gain' : 'text-ink'}`}>
            {savings > 0 ? '−' : ''}{fmtThb(savings)}
          </div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">
            plan cost {fmtThb(plannedTotal)} · ≈ ${Math.round(savings / USD_THB).toLocaleString('en-US')} saved
          </div>
        </div>
        <div className="rounded-card border border-hairline bg-surface px-card-px py-2.5">
          <Label>Marginal bracket</Label>
          <div className="tnum mt-1 text-stat-value font-semibold text-ink">
            {(after.tax.marginalRate * 100).toFixed(0)}%
            {after.tax.marginalRate < before.tax.marginalRate && (
              <span className="ml-1.5 text-[13px] font-medium text-gain">↓ was {(before.tax.marginalRate * 100).toFixed(0)}%</span>
            )}
          </div>
          <div className="mt-1 text-[11px] leading-4 text-ink-3">the value /portfolio/tax harvest planning needs</div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-sec-gap">
        {/* --------------------------- left: planner --------------------------- */}
        <div className="col-span-12 space-y-sec-gap xl:col-span-7">
          <SectionCard
            title="Deduction planner"
            actions={
              <span className="flex items-center gap-2 text-[11px] text-ink-3">
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full" style={{ background: 'var(--accent)' }} /> contributed</span>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full" style={{ background: PLANNED_FILL }} /> planned</span>
                <span>track = room</span>
              </span>
            }
          >
            {/* household & automatic */}
            <div className="border-b border-hairline pb-3">
              <Label className="pb-1.5">Household &amp; automatic</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="tnum rounded-chip bg-surface-2 px-2 py-1 text-[12px] text-ink-3">
                  employment expense −{fmtThb(after.employmentExpense)} (auto)
                </span>
                <span className="tnum rounded-chip bg-surface-2 px-2 py-1 text-[12px] text-ink-3">
                  personal −{fmtThb(after.allowances.personal)} (auto)
                </span>
                <ChipButton onClick={() => setSpouse(!spouse)} active={spouse} title="spouse with no income">
                  spouse (no income) +฿60k
                </ChipButton>
                <Stepper label="children ×฿30k" value={children} onChange={setChildren} />
                <Stepper label="parents ×฿30k" value={parents} onChange={setParents} max={4} />
              </div>
              <p className="mt-1.5 text-[11px] text-ink-3">
                2nd+ child born 2018+ gets ฿60k (not modeled — flag for implementation). Parents must be 60+ with income &lt; ฿30k/yr.
              </p>
            </div>

            <div className="pt-1">
              <CategoryRow
                meta={{ id: 'social_security', label: 'Social security', capText: 'actual contributions, max ฿9,000/yr' }}
                plan={after}
                planned={plannedOf('social_security')}
                onPlanned={setPlan('social_security')}
              />
            </div>

            {/* retirement combo */}
            <div className="mt-3 rounded-card border border-hairline bg-surface-2/40 p-2.5">
              <div className="flex items-center justify-between">
                <Label>Retirement — shared ฿500,000 ceiling</Label>
                <span className="tnum text-[11px] text-ink-3">
                  combo used {fmtThb(after.retirementCombo.used)} of {fmtThb(after.retirementCombo.cap)}
                </span>
              </div>
              <CapacityBar
                used={before.retirementCombo.used}
                planned={comboPlannedDelta}
                cap={after.retirementCombo.cap}
              />
              <div className="mt-1">
                <CategoryRow
                  meta={{ id: 'provident_fund', label: 'Provident fund (PVD)', capText: '≤15% of wages · inside ฿500k combo · PFM009 classification pending' }}
                  plan={after}
                  planned={plannedOf('provident_fund')}
                  onPlanned={setPlan('provident_fund')}
                />
                <CategoryRow
                  meta={{ id: 'rmf', label: 'RMF — Retirement Mutual Fund', capText: '≤30% of assessable income · inside ฿500k combo · hold to age 55' }}
                  plan={after}
                  planned={plannedOf('rmf')}
                  onPlanned={setPlan('rmf')}
                />
                <CategoryRow
                  meta={{ id: 'pension_insurance', label: 'Pension life insurance', capText: '≤15% of income, max ฿200,000 · inside ฿500k combo' }}
                  plan={after}
                  planned={plannedOf('pension_insurance')}
                  onPlanned={setPlan('pension_insurance')}
                />
              </div>
            </div>

            {/* thaiesg */}
            <div className="mt-3">
              <Label className="pb-1">ThaiESG — separate ฿300,000 cap</Label>
              <CategoryRow
                meta={{ id: 'thaiesg', label: 'ThaiESG fund units', capText: '≤30% of income, max ฿300,000 · 5-year lock per lot · outside the ฿500k combo' }}
                plan={after}
                planned={plannedOf('thaiesg')}
                onPlanned={setPlan('thaiesg')}
              />
              <p className="text-[11px] text-ink-3">
                SSF has no 2026 row — the deduction lapsed after 2024 (see agent flags).
              </p>
            </div>

            {/* insurance */}
            <div className="mt-3">
              <Label className="pb-1">Insurance — life + health ≤ ฿100,000 combined</Label>
              <CategoryRow
                meta={{ id: 'life_insurance', label: 'Life insurance premium', capText: 'max ฿100,000 (combined with health)' }}
                plan={after}
                planned={plannedOf('life_insurance')}
                onPlanned={setPlan('life_insurance')}
              />
              <CategoryRow
                meta={{ id: 'health_insurance', label: 'Health insurance premium (self)', capText: 'max ฿25,000 · shares the ฿100k combined ceiling' }}
                plan={after}
                planned={plannedOf('health_insurance')}
                onPlanned={setPlan('health_insurance')}
              />
              <CategoryRow
                meta={{ id: 'parent_health_insurance', label: 'Parents’ health insurance', capText: 'max ฿15,000 · separate from the ฿100k ceiling' }}
                plan={after}
                planned={plannedOf('parent_health_insurance')}
                onPlanned={setPlan('parent_health_insurance')}
              />
            </div>

            {/* housing & giving */}
            <div className="mt-3">
              <Label className="pb-1">Housing &amp; giving</Label>
              <CategoryRow
                meta={{ id: 'mortgage_interest', label: 'Mortgage interest', capText: 'max ฿100,000' }}
                plan={after}
                planned={plannedOf('mortgage_interest')}
                onPlanned={setPlan('mortgage_interest')}
              />
              <CategoryRow
                meta={{ id: 'donations_education', label: 'Donations — education / e-donation', capText: 'counts ×2, ≤10% of net income', noMax: true }}
                plan={after}
                planned={plannedOf('donations_education')}
                onPlanned={setPlan('donations_education')}
              />
              <CategoryRow
                meta={{ id: 'donations_general', label: 'Donations — general', capText: '≤10% of net income (after education donations)', noMax: true }}
                plan={after}
                planned={plannedOf('donations_general')}
                onPlanned={setPlan('donations_general')}
              />
            </div>
          </SectionCard>

          {/* portfolio tie-in */}
          <SectionCard title="From your portfolio" asOf="2026-07-08T14:03:31.486Z">
            <ul className="space-y-2.5">
              {TAX_HOLDINGS.map((h) => (
                <li key={h.ticker} className="flex flex-wrap items-start justify-between gap-2 border-b border-hairline pb-2.5 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{h.ticker}</span>
                      <StrategyTag strategy={h.strategy} />
                    </div>
                    <div className="text-[12px] text-ink-2">{h.label}</div>
                    <p className="mt-0.5 max-w-[520px] text-[11px] leading-4 text-ink-3">{h.note}</p>
                  </div>
                  <span className="tnum text-[13px] font-medium text-ink">{fmtThb(h.valueTHB)}</span>
                </li>
              ))}
            </ul>
            <div className="tnum mt-3 rounded-chip bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2">
              Dry powder for purchases: {fmtThb(DRY_POWDER_THB)} THB cash
              {plannedTotal > 0 && (
                <>
                  {' '}· plan uses {fmtThb(plannedTotal)}
                  {plannedTotal > DRY_POWDER_THB && (
                    <span className="ml-1 font-medium text-status-warning">⚠ exceeds THB cash — would need USD conversion (see remittance flag)</span>
                  )}
                </>
              )}
            </div>
          </SectionCard>
        </div>

        {/* ---------------------------- right rail ----------------------------- */}
        <div className="col-span-12 space-y-sec-gap xl:col-span-5">
          {/* bracket ladder */}
          <SectionCard title={`Bracket ladder ${TAX_YEAR}`}>
            <div className="space-y-1.5">
              {after.tax.bands.map((b, i) => {
                const finite = Number.isFinite(b.to)
                const span = finite ? b.to - b.from : 3_000_000
                const afterPct = Math.min(100, (b.taxable / span) * 100)
                const beforeBand = before.tax.bands[i]
                const beforePct = Math.min(100, (beforeBand.taxable / span) * 100)
                const marginal = b.taxable > 0 && b.rate === after.tax.marginalRate
                return (
                  <div key={b.from} className={`rounded px-2 py-1.5 ${marginal ? 'bg-surface-2' : ''}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`tnum text-[12px] ${marginal ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                        {(b.rate * 100).toFixed(0)}%
                        <span className="ml-1.5 text-[11px] text-ink-3">
                          {fmtThb(b.from)} – {finite ? fmtThb(b.to) : '∞'}
                        </span>
                        {marginal && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent">marginal</span>}
                      </span>
                      <span className="tnum text-[11px] text-ink-3">{b.tax > 0 ? fmtThb(b.tax) : '—'}</span>
                    </div>
                    <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
                      <div className="h-full rounded-full" style={{ width: `${afterPct}%`, background: 'var(--accent)' }} />
                      {beforePct > afterPct && (
                        <div
                          className="absolute top-0 h-full w-[2px] bg-ink-3"
                          style={{ left: `calc(${beforePct}% - 1px)` }}
                          title="taxable income before plan"
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-3">
              Fill = taxable income in the band with your plan; the gray tick marks where it sat before. Tax per band on the right.
            </p>
          </SectionCard>

          {/* advisor picks */}
          <SectionCard
            title="Advisor picks"
            actions={
              <span className="flex items-center gap-1.5">
                <ChipButton onClick={applyAll}>Apply plan</ChipButton>
                <ChipButton onClick={resetPlan}>Reset</ChipButton>
              </span>
            }
          >
            <p className="pb-2 text-[12px] leading-4 text-ink-3">
              Generated by the tax-advisor agent from your real book + the rule table. Estimates, not licensed advice — every fund fact needs verification before an order.
            </p>
            <div className="space-y-2.5">
              {ADVISOR_RUN.recs.map((rec) => {
                const isApplied = applied.includes(rec.id)
                return (
                  <div key={rec.id} className="rounded-card border border-hairline p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionBadge action="buy" />
                      <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">{rec.categoryLabel}</span>
                      <span className="text-[13px] font-semibold text-ink">{rec.fund !== '—' ? rec.fund : rec.fundLabel}</span>
                      <ConvictionBadge conviction={rec.conviction} />
                    </div>
                    {rec.fund !== '—' && <div className="mt-0.5 text-[12px] text-ink-2">{rec.fundLabel}</div>}
                    <div className="tnum mt-1 text-[13px] font-medium text-ink">
                      {fmtThb(rec.amountTHB)}
                      {isApplied ? (
                        <span className="ml-2 text-[12px] font-medium text-gain">in plan ✓</span>
                      ) : (
                        <span className="ml-2 text-[12px] text-gain">saves ~{fmtThb(recSaving(rec))} tax</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-[12px] leading-4 text-ink-2">
                      <span className="font-medium text-ink-3">tax — </span>{rec.taxWhy}
                    </p>
                    <p className="mt-1 text-[12px] leading-4 text-ink-2">
                      <span className="font-medium text-ink-3">investing — </span>{rec.investWhy}
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-ink-3">{rec.caveat}</p>
                    <div className="mt-1.5">
                      {isApplied ? (
                        <ChipButton onClick={() => removeRec(rec)}>Remove from plan</ChipButton>
                      ) : (
                        <ChipButton onClick={() => addRec(rec)}>Add to plan</ChipButton>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </SectionCard>

          {/* agent flags */}
          <SectionCard title="Agent flags">
            <ul className="space-y-2.5">
              {AGENT_FLAGS.map((f) => (
                <li key={f.title} className="flex items-start gap-2">
                  <span
                    className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{
                      background: f.level === 'critical' ? '#d03b3b' : f.level === 'warning' ? '#fab219' : 'var(--accent)',
                    }}
                    aria-hidden
                  />
                  <div>
                    <span className="text-[12px] font-semibold text-ink">
                      {f.level !== 'info' && <span className="mr-1 uppercase text-[10px] tracking-wide text-ink-3">{f.level}</span>}
                      {f.title}
                    </span>
                    <p className="mt-0.5 text-[11px] leading-4 text-ink-3">{f.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>

      {/* method & assumptions */}
      <SectionCard title="Method & assumptions">
        <div className="grid grid-cols-12 gap-sec-gap">
          <div className="col-span-12 md:col-span-4">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Net income band</Th>
                  <Th align="right">Rate</Th>
                </tr>
              </thead>
              <tbody>
                {PIT_BRACKETS_2026.map((b) => (
                  <tr key={b.from} className="border-b border-hairline last:border-0">
                    <Td>
                      {fmtThb(b.from)} – {Number.isFinite(b.to) ? fmtThb(b.to) : '∞'}
                    </Td>
                    <Td align="right">{(b.rate * 100).toFixed(0)}%</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="col-span-12 md:col-span-8">
            <ul className="list-disc space-y-1 pl-4 text-[12px] leading-4 text-ink-2">
              <li>Employment income §40(1) only; 50% expense deduction capped ฿100,000. Other income classes are out of scope and should be agent-flagged.</li>
              <li>Retirement combo: RMF + PVD + pension insurance share a ฿500,000 ceiling (NSF not modeled). Clamp order PVD → RMF → pension.</li>
              <li>ThaiESG: ≤30% of income, ฿300,000, outside the combo, 5-year lock — VERIFY the scheme is open for 2026 purchases.</li>
              <li>Donations computed last: education counts ×2 up to 10% of net, then general up to 10% of the remainder — a simplification of RD ordering.</li>
              <li>All figures encoded in <code className="rounded bg-surface-2 px-1 text-[11px]">tax-engine.ts</code> with VERIFY markers — one file to audit against the Revenue Department during implementation.</li>
              <li className="text-ink-3">This page produces estimates for planning. It is not licensed tax or investment advice; ThaiESG/RMF purchases are locked and irreversible for tax purposes.</li>
            </ul>
          </div>
        </div>
      </SectionCard>
    </main>
  )
}
