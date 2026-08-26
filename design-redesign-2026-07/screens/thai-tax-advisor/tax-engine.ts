// Thai personal income tax engine — tax year 2026 (filed Q1 2027).
//
// PURE FUNCTIONS, NO IO. This file is the single place the statutory figures
// live so the implementing agent can verify/correct them against the Revenue
// Department once, in one file. Every figure below is annotated; anything
// marked VERIFY needs checking against an authoritative 2026 source during
// real implementation (see README "Tax-figure assumptions").
//
// Scope assumption: income is employment income under Section 40(1). Other
// income classes (40(2)–(8)) have different expense deductions and are out of
// scope for v1 — the real agent should detect and flag them.

/* ------------------------------- brackets -------------------------------- */

export interface Bracket {
  from: number
  to: number // Infinity for the top band
  rate: number // 0..1
}

/** Progressive PIT schedule — unchanged since 2017; assumed still in force
 *  for tax year 2026. VERIFY: no 2026 restructure enacted. */
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

/* Statutory limits, tax year 2026. Sources of uncertainty flagged VERIFY. */
export const LIMITS = {
  /** Employment income expense: 50% of income, capped. */
  employmentExpensePct: 0.5,
  employmentExpenseCap: 100_000,
  personalAllowance: 60_000,
  spouseAllowance: 60_000, // spouse with no income
  childAllowance: 30_000, // per child; 60k for 2nd+ child born 2018+ NOT modeled (footnote in UI)
  parentCareAllowance: 30_000, // per qualifying parent (60+, income < 30k/yr), max 4
  parentCareMaxParents: 4,
  socialSecurityCap: 9_000, // 5% of ฿15,000/mo wage ceiling — VERIFY 2026 ceiling unchanged
  providentFundPct: 0.15, // of wages — counted inside the retirement combo cap
  rmfPct: 0.3, // of assessable income — inside combo cap
  pensionInsurancePct: 0.15,
  pensionInsuranceCap: 200_000, // inside combo cap
  retirementComboCap: 500_000, // RMF + PVD + pension insurance (+ NSF, not modeled)
  thaiEsgPct: 0.3,
  thaiEsgCap: 300_000, // SEPARATE from the 500k combo — VERIFY 2026 scheme still open (original window 2024–2026)
  lifeInsuranceCap: 100_000,
  healthInsuranceCap: 25_000, // and life + health combined ≤ 100k
  lifeHealthComboCap: 100_000,
  parentHealthInsuranceCap: 15_000,
  mortgageInterestCap: 100_000,
  donationPctOfNet: 0.1, // of income after ALL other deductions; education donations count double
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
  // the running net. (Simplification of RD ordering — see README.)
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
