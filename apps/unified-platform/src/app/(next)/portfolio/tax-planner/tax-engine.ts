// Thai personal income tax engine — tax year 2026 (filed Q1 2027).
//
// PURE FUNCTIONS, NO IO. Ported from
// design-redesign-2026-07/screens/thai-tax-advisor/tax-engine.ts and verified
// against current Revenue Department / SSO sources on 2026-07-08 (see
// per-constant citations below). Every figure the mockup flagged VERIFY has
// been checked; one correction was made (social security ceiling — see
// `socialSecurityCap`).
//
// Scope assumption: income is employment income under Section 40(1). Other
// income classes (40(2)–(8)) have different expense deductions and are out of
// scope for v1 — the real agent should detect and flag them.
//
// Scope assumption #2: this file computes the RESIDENT Thai PIT position only.
// Thai tax residency is 180+ days of physical presence in Thailand in the
// calendar year (Revenue Code Section 41) — NOT where salary is paid or
// deposited. Non-residents' allowances/reliefs differ materially and are not
// modeled here; the UI must gate this engine behind an explicit residency
// toggle and show a non-resident warning instead of calling evaluatePlan().

/* ------------------------------- brackets -------------------------------- */

export interface Bracket {
  from: number
  to: number // Infinity for the top band
  rate: number // 0..1
}

/** Progressive PIT schedule — unchanged since 2013/2017; confirmed still in
 *  force for tax year 2026 (no 2026 restructure). Source: PwC Worldwide Tax
 *  Summaries "Thailand - Individual - Taxes on personal income" (checked
 *  2026-07-08) — rates 0/5/10/15/20/25/30/35% at these thresholds, unchanged. */
export const PIT_BRACKETS_2026: Bracket[] = [
  { from: 0, to: 150_000, rate: 0 },
  { from: 150_000, to: 300_000, rate: 0.05 },
  { from: 300_000, to: 500_000, rate: 0.1 },
  { from: 500_000, to: 750_000, rate: 0.15 },
  { from: 750_000, to: 1_000_000, rate: 0.2 },
  { from: 1_000_000, to: 2_000_000, rate: 0.25 },
  { from: 2_000_000, to: 5_000_000, rate: 0.3 },
  { from: 5_000_000, to: Infinity, rate: 0.35 },
]

export interface BandFill {
  from: number
  to: number
  rate: number
  /** THB of taxable income falling inside this band. */
  taxable: number
  tax: number
}

export interface TaxResult {
  total: number
  marginalRate: number
  effectiveRate: number // vs net taxable income (0 when net ≤ 0)
  bands: BandFill[]
}

export function computeTax(netTaxable: number): TaxResult {
  const net = Math.max(0, netTaxable)
  let total = 0
  let marginalRate = 0
  const bands: BandFill[] = PIT_BRACKETS_2026.map((b) => {
    const taxable = Math.max(0, Math.min(net, b.to) - b.from)
    const tax = taxable * b.rate
    total += tax
    if (taxable > 0) marginalRate = b.rate
    return { ...b, taxable, tax }
  })
  return { total, marginalRate, effectiveRate: net > 0 ? total / net : 0, bands }
}

/* ----------------------------- deduction model ---------------------------- */

/** User-enterable contribution categories (allowances derived from the
 *  household profile are separate — see evaluatePlan). */
export type ContribId =
  | 'social_security'
  | 'provident_fund'
  | 'rmf'
  | 'pension_insurance'
  | 'thaiesg'
  | 'life_insurance'
  | 'health_insurance'
  | 'parent_health_insurance'
  | 'mortgage_interest'
  | 'donations_general'
  | 'donations_education'

export const CONTRIB_IDS: ContribId[] = [
  'social_security',
  'provident_fund',
  'rmf',
  'pension_insurance',
  'thaiesg',
  'life_insurance',
  'health_insurance',
  'parent_health_insurance',
  'mortgage_interest',
  'donations_general',
  'donations_education',
]

/* Statutory limits, tax year 2026. Each figure below was checked against a
 * current source on 2026-07-08; citations inline. */
export const LIMITS = {
  /** Employment income expense: 50% of income, capped ฿100,000. Confirmed —
   *  unchanged, standard RD figure (PwC Worldwide Tax Summaries, Sherrings
   *  "Personal Tax Deductions and Allowances - Thailand"). */
  employmentExpensePct: 0.5,
  employmentExpenseCap: 100_000,
  /** Confirmed — ฿60,000 each for taxpayer and non-earning spouse (Sherrings,
   *  RD Guide to Allowances PDF). */
  personalAllowance: 60_000,
  spouseAllowance: 60_000, // spouse with no income
  /** Confirmed — ฿30,000 per child. RD also grants an ADDITIONAL ฿30,000
   *  (i.e. ฿60,000 total) for the 2nd-and-later child born 2018-01-01+.
   *  NOT modeled: this page counts every child at a flat ฿30,000 (no per-child
   *  birth-year input) — a documented simplification, footnoted in the UI. */
  childAllowance: 30_000,
  /** Confirmed — ฿30,000 per qualifying parent (60+, income < ฿30k/yr), max 4
   *  (own + spouse's, combined). Sherrings. */
  parentCareAllowance: 30_000,
  parentCareMaxParents: 4,
  /** CORRECTED from the mockup's ฿9,000. The SSO wage ceiling used to compute
   *  the 5% employee contribution rose from ฿15,000/mo to ฿17,500/mo effective
   *  1 Jan 2026 (Royal Gazette, published 2025-12-12; Cabinet-approved phased
   *  increase 15,000 → 17,500 → 20,000 → 23,000). Max monthly contribution
   *  rose from ฿750 to ฿875, so the max ANNUAL contribution — and thus the
   *  max deduction — is ฿875 × 12 = ฿10,500 for tax year 2026, not ฿9,000.
   *  Sources: HLB Thailand "Thailand Social Security Contribution Changes for
   *  2026"; BDO "New Social Security Fund's Wage Ceiling Effective January
   *  2026"; checked 2026-07-08. */
  socialSecurityCap: 10_500,
  /** Confirmed — ≤15% of wages, inside the ฿500k retirement combo. */
  providentFundPct: 0.15,
  /** Confirmed — ≤30% of assessable income, inside the ฿500k combo. */
  rmfPct: 0.3,
  /** Confirmed — ≤15% of income, capped ฿200,000, inside the ฿500k combo. */
  pensionInsurancePct: 0.15,
  pensionInsuranceCap: 200_000,
  /** Confirmed — RMF + PVD + pension life insurance (+ NSF/government pension
   *  fund/teachers' aid fund, not modeled — no such positions in this book)
   *  share one ฿500,000 ceiling. Multiple 2026 sources agree (Bangkok Bank,
   *  Muang Thai, RD Guide to Allowances). */
  retirementComboCap: 500_000,
  /** Confirmed — ≤30% of income, ฿300,000 cap, SEPARATE from the retirement
   *  combo, 5-year hold. The special ฿300k-cap window (vs. the normal
   *  ฿100k-cap ThaiESG rule outside the window) runs 2024-01-01 through
   *  2026-12-31 — confirmed STILL OPEN for tax year 2026 purchases (Bangkok
   *  Bank "Thailand ESG Fund"; multiple 2026 sources). Reverts to ฿100,000
   *  for purchases after 2026-12-31 — out of scope for this tax-year-2026
   *  engine. */
  thaiEsgPct: 0.3,
  thaiEsgCap: 300_000,
  /** Confirmed — life insurance ≤฿100,000; health insurance ≤฿25,000; life +
   *  health combined ≤฿100,000 (life-linked savings insurance also shares
   *  this ceiling — not modeled, no such position here). */
  lifeInsuranceCap: 100_000,
  healthInsuranceCap: 25_000,
  lifeHealthComboCap: 100_000,
  /** Confirmed — ฿15,000 per parent's health insurance, separate ceiling. */
  parentHealthInsuranceCap: 15_000,
  /** Confirmed — ฿100,000 mortgage interest cap. */
  mortgageInterestCap: 100_000,
  /** Confirmed via RD-form practitioner guidance (Forvis Mazars "Tax
   *  Deduction for Educational Institutes"; PwC Worldwide Tax Summaries):
   *  education/e-donation counts double, capped at 10% of net income;
   *  general donations capped at 10% of net income after the education
   *  donation is applied. Modeled here as sequential clamps (education first
   *  against the pre-donation base, general against what's left) — this
   *  matches how RD's own P.90/91 filing guidance and practitioners compute
   *  it in practice, though the statute's exact combined-vs-sequential
   *  wording is not 100% unambiguous; flagged as a simplification. */
  donationPctOfNet: 0.1,
} as const

export interface HouseholdProfile {
  assessableIncome: number
  spouseNoIncome: boolean
  children: number
  dependentParents: number
}

export interface ContribResult {
  entered: number
  effective: number
  /** True when a cap (own or shared) reduced the entered amount. */
  clamped: boolean
  /** The binding cap for THIS profile/income (before shared-cap interaction). */
  ownCap: number
}

export interface PlanResult {
  income: number
  employmentExpense: number
  allowances: { personal: number; spouse: number; child: number; parentCare: number }
  contributions: Record<ContribId, ContribResult>
  retirementCombo: { used: number; cap: number }
  lifeHealthCombo: { used: number; cap: number }
  totalDeductions: number
  netTaxable: number
  tax: TaxResult
}

/**
 * Applies every cap interaction and returns the full tax position.
 * Shared-cap clamp order (documented, deterministic): PVD → RMF → pension
 * insurance for the ฿500k retirement combo; life → health for the ฿100k
 * insurance combo. Donations are computed last against post-deduction net.
 *
 * RESIDENT-ONLY. Callers must gate this behind a residency check — see the
 * file header and README decision on the non-resident UI branch.
 */
export function evaluatePlan(
  profile: HouseholdProfile,
  contrib: Partial<Record<ContribId, number>>,
): PlanResult {
  const income = Math.max(0, profile.assessableIncome)
  const get = (id: ContribId) => Math.max(0, contrib[id] ?? 0)

  const employmentExpense = Math.min(income * LIMITS.employmentExpensePct, LIMITS.employmentExpenseCap)
  const allowances = {
    personal: LIMITS.personalAllowance,
    spouse: profile.spouseNoIncome ? LIMITS.spouseAllowance : 0,
    child: profile.children * LIMITS.childAllowance,
    parentCare: Math.min(profile.dependentParents, LIMITS.parentCareMaxParents) * LIMITS.parentCareAllowance,
  }

  const out = {} as Record<ContribId, ContribResult>
  const clampTo = (id: ContribId, ownCap: number, sharedRoom = Infinity) => {
    const entered = get(id)
    const effective = Math.min(entered, ownCap, sharedRoom)
    out[id] = { entered, effective, clamped: effective < entered, ownCap }
    return effective
  }

  clampTo('social_security', LIMITS.socialSecurityCap)

  // Retirement combo — clamp order PVD → RMF → pension insurance.
  let comboRoom = LIMITS.retirementComboCap
  comboRoom -= clampTo('provident_fund', income * LIMITS.providentFundPct, comboRoom)
  comboRoom -= clampTo('rmf', income * LIMITS.rmfPct, comboRoom)
  comboRoom -= clampTo(
    'pension_insurance',
    Math.min(income * LIMITS.pensionInsurancePct, LIMITS.pensionInsuranceCap),
    comboRoom,
  )
  const comboUsed = LIMITS.retirementComboCap - comboRoom

  clampTo('thaiesg', Math.min(income * LIMITS.thaiEsgPct, LIMITS.thaiEsgCap))

  // Life + health combined ≤ 100k; life clamped first, health absorbs the squeeze.
  const lifeEff = clampTo('life_insurance', LIMITS.lifeInsuranceCap)
  const healthEff = clampTo(
    'health_insurance',
    LIMITS.healthInsuranceCap,
    Math.max(0, LIMITS.lifeHealthComboCap - lifeEff),
  )
  clampTo('parent_health_insurance', LIMITS.parentHealthInsuranceCap)
  clampTo('mortgage_interest', LIMITS.mortgageInterestCap)

  const preDonation =
    income -
    employmentExpense -
    allowances.personal -
    allowances.spouse -
    allowances.child -
    allowances.parentCare -
    CONTRIB_IDS.filter((id) => id !== 'donations_general' && id !== 'donations_education').reduce(
      (s, id) => s + out[id].effective,
      0,
    )

  // Education/e-donation double deduction first, then general — each ≤ 10% of
  // the running net. (Simplification of RD ordering — see LIMITS.donationPctOfNet.)
  const eduBase = Math.max(0, preDonation)
  const eduEff = Math.min(get('donations_education') * 2, eduBase * LIMITS.donationPctOfNet)
  out.donations_education = {
    entered: get('donations_education'),
    effective: eduEff,
    clamped: eduEff < get('donations_education') * 2,
    ownCap: eduBase * LIMITS.donationPctOfNet,
  }
  const genBase = Math.max(0, preDonation - eduEff)
  const genEff = Math.min(get('donations_general'), genBase * LIMITS.donationPctOfNet)
  out.donations_general = {
    entered: get('donations_general'),
    effective: genEff,
    clamped: genEff < get('donations_general'),
    ownCap: genBase * LIMITS.donationPctOfNet,
  }

  const totalDeductions =
    employmentExpense +
    allowances.personal +
    allowances.spouse +
    allowances.child +
    allowances.parentCare +
    CONTRIB_IDS.reduce((s, id) => s + out[id].effective, 0)

  const netTaxable = Math.max(0, income - totalDeductions)
  return {
    income,
    employmentExpense,
    allowances,
    contributions: out,
    retirementCombo: { used: comboUsed, cap: LIMITS.retirementComboCap },
    lifeHealthCombo: { used: lifeEff + healthEff, cap: LIMITS.lifeHealthComboCap },
    totalDeductions,
    netTaxable,
    tax: computeTax(netTaxable),
  }
}

/**
 * Convenience wrapper exposing just the marginal PIT bracket for a plan.
 * Exported standalone (not buried in page-local state) so other screens can
 * import it — e.g. /portfolio/tax's "Plan harvest" dialog, which is currently
 * deferred because the marginal Thai PIT bracket is "nowhere in the system"
 * (see that page's header comment). This is that value.
 */
export function marginalRateFor(
  profile: HouseholdProfile,
  contrib: Partial<Record<ContribId, number>>,
): number {
  return evaluatePlan(profile, contrib).tax.marginalRate
}
