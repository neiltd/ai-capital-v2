// /portfolio/tax-planner — Thai Tax & Investment Advisor.
//
// Real, production feature (design-reviewed; see
// design-redesign-2026-07/screens/thai-tax-advisor/README.md for the
// approved design decisions this was built against). NOT the existing
// /portfolio/tax page ("Harvesting" in the nav) — that is capital-gains
// loss harvesting, unrelated to personal income tax.
//
// Server component reads real disk data via loadTaxPlanner() → loadPortfolio()
// → readSimulation(), same convention as /portfolio and /portfolio/risk. All
// interactive state (income, household, residency, planned amounts) lives in
// the client TaxPlannerScreen, which recomputes evaluatePlan() live.

export const dynamic = 'force-dynamic'

import { loadTaxPlanner } from './data'
import { TaxPlannerScreen } from './planner'

export default function TaxPlannerPage() {
  const data = loadTaxPlanner()
  return <TaxPlannerScreen data={data} />
}
