// Loader for /discover. Real disk reads (no fetch — server component), per
// docs/frontend-migration-plan-2026-07-07.md §1.5/§5.
//
// The design mockup was built before the 2026-07-06 backend upgrade (risk-
// based sizing, theme-diversification caps, mechanical + LLM exit checks,
// calibration). Per the plan's §5 diff: the current paper book is EMPTY —
// the 16-position cohort the mockup renders was archived as "cohort 0"
// (a reset after the old book measured sector beta, not stock-picking
// skill, with no exit mechanism ever firing). Shown here as an explicit
// history section rather than pretending the book was never filled.
//
// v1 ships READ-ONLY — no promote button (backend gap #14, not built) — and
// drops the mockup's elaborate multi-term SizingBlock derivation UI, since
// there are currently zero live candidates to render it against; the real
// per-position fields (stopPrice/targetPrice/adjustedConviction/
// benchmarkPriceAtOpen) still render wherever a position has them.

import { readDiscovery, readDiscoveryCohortArchive, readDiscoveryCalibration } from '@/lib/data'
import type { DiscoveryJSON, DiscoveryPosition, DiscoveryClosedPosition } from '@/types'
import type { DiscoveryCohortArchive } from '@/lib/data'

// Real constants from apps/scenario-simulator/src/discovery/*.ts — that app
// isn't importable from unified-platform, so these are display-only mirrors
// of the actual policy, not a live import. Keep in sync if the source changes.
export const RISK_PER_TRADE_PCT = 0.02 // risk-sizing.ts
export const THEME_CONCENTRATION_CAP = 0.30 // theme-tracker.ts
export const TIME_STOP_DAYS = 180 // exit-checks.ts
export const THESIS_CHECK_DOWN_PCT = 0.10 // exit-checks.ts
export const THESIS_CHECK_HELD_DAYS = 90 // exit-checks.ts
export const MIN_N_FOR_VERDICT = 5 // calibration.ts

export interface DiscoveryViewModel {
  exportedAt: string
  config: DiscoveryJSON['config']
  candidates: DiscoveryJSON['candidates']
  holdings: DiscoveryPosition[]
  closedPositions: DiscoveryClosedPosition[]
  deployedUsd: number
  hasCalibration: boolean
  archive: DiscoveryCohortArchive | null
}

export function loadDiscovery(): DiscoveryViewModel | null {
  const d = readDiscovery()
  if (!d) return null

  const holdings = d.discoveryPortfolio
  const deployedUsd = holdings.reduce((s, p) => s + p.avgCost * p.shares, 0)

  return {
    exportedAt: d.exportedAt,
    config: d.config,
    candidates: d.candidates,
    holdings,
    closedPositions: d.closedPositions ?? [],
    deployedUsd,
    hasCalibration: readDiscoveryCalibration() != null,
    archive: readDiscoveryCohortArchive(0),
  }
}
