// Loader for /markets/gov. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// The design mockup assumed individual date-stamped award rows (AwardRow:
// date/agency/vendor/program/amountUsd/awardType). Real govflow.json
// aggregates per-ticker over a rolling 30d window instead (total30d,
// awardCount, topAgency, contracts: string[] — no per-award dates or
// amounts survive the aggregation). Adapted the table to the real
// per-ticker shape rather than fabricating individual award rows.
//
// Monthly award-flow bars are dropped entirely (gap #22 — no monthly
// aggregation exists, not even an illustrative single 30d snapshot to
// derive one from) rather than shown as a fake/illustrative chart.
//
// Legislation watch uses budgetSignals' real `status` free text directly
// instead of the mockup's stepper (mapping arbitrary congress.gov status
// strings to discrete stages needs gap #22's bill-status fetcher — the raw
// status text is honest and, if anything, richer than a fabricated stepper).

import { readGovFlow, readSimulation } from '@/lib/data'
import type { WatchlistAward, AgencyFlow, BudgetSignal } from '@/types'

export interface GovViewModel {
  exportedAt: string
  asOf: string
  awards30d: { totalUsd: number; count: number; topAgency: string; heldUsd: number }
  awards: Array<WatchlistAward & { held: boolean }>
  agencyFlows: AgencyFlow[]
  bills: Array<BudgetSignal & { relevantToHeld: boolean }>
}

export function loadGov(): GovViewModel | null {
  const g = readGovFlow()
  if (!g) return null

  let realTickers = new Set<string>()
  try { realTickers = new Set(readSimulation().portfolio.map((p) => p.ticker)) } catch { /* simulation.json missing */ }

  const awards = g.watchlistAwards.map((a) => ({ ...a, held: realTickers.has(a.ticker) }))
  const topAgency = [...g.agencyFlows].sort((a, b) => b.total30d - a.total30d)[0]?.agency ?? '—'

  return {
    exportedAt: g.exportedAt,
    asOf: g.asOf,
    awards30d: {
      totalUsd: awards.reduce((s, a) => s + a.total30d, 0),
      count: awards.reduce((s, a) => s + a.awardCount, 0),
      topAgency,
      heldUsd: awards.filter((a) => a.held).reduce((s, a) => s + a.total30d, 0),
    },
    awards,
    agencyFlows: [...g.agencyFlows].sort((a, b) => b.total30d - a.total30d),
    bills: g.budgetSignals.map((b) => ({ ...b, relevantToHeld: b.relevantTickers.some((t) => realTickers.has(t)) })),
  }
}
