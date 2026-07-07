// Loader for /portfolio/tax. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5. Spec-only screen
// (design-redesign-2026-07/screens/specs/tax.md) — no mockup to port from.

import { readHarvest } from '@/lib/data'
import type { HarvestJSON } from '@/lib/next/types'

export function loadHarvest(): HarvestJSON | null {
  return readHarvest()
}

/** Sum of |unrealizedLossUSD| across harvestable opportunities only —
 *  matches harvest.json's own `summary` field's "Harvestable now" figure. */
export function harvestableNowUsd(h: HarvestJSON): number {
  return h.harvestOpportunities
    .filter((o) => o.harvestable)
    .reduce((sum, o) => sum + Math.abs(o.unrealizedLossUSD), 0)
}
