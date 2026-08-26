// /portfolio/tax-planner — Thai Tax & Investment Advisor (review mockup).
//
// Nav (proposed, see README §1): Portfolio → "Tax Planner", sibling of the
// existing /portfolio/tax page, which should be renamed "Harvesting" so the
// two tax surfaces stop colliding on one word:
//
//   Portfolio
//     Holdings
//     Risk
//     Tax Planner   ← this screen (Thai PIT + advisor agent)
//     Harvesting    ← existing /portfolio/tax (capital-gains loss harvesting)
//     Theses
//
// All state lives in the client TaxPlannerScreen — every surface (tiles,
// rows, meters, ladder, advisor deltas) recomputes from the same
// evaluatePlan() calls in tax-engine.ts.

import { TaxPlannerScreen } from './planner'

export default function TaxPlannerPage() {
  return <TaxPlannerScreen />
}
