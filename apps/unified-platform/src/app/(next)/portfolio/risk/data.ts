// Loader for /portfolio/risk. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5.

import { readRisk, readSimulation, computeNetWorthUsd } from '@/lib/data'
import type { RiskJSON } from '@/lib/next/types'

export interface RiskViewModel extends RiskJSON {
  /** Total NW for the honesty banner (priced subset ≠ net worth). Null if
   *  simulation.json is missing/unparseable. */
  totalNetWorthUsd: number | null
}

export function loadRisk(): RiskViewModel | null {
  const risk = readRisk()
  if (!risk) return null

  let totalNetWorthUsd: number | null = null
  try {
    totalNetWorthUsd = computeNetWorthUsd(readSimulation())
  } catch {
    // simulation.json missing/unparseable — banner falls back to risk's own
    // portfolioValueUSD-only framing.
  }

  return { ...risk, totalNetWorthUsd }
}
