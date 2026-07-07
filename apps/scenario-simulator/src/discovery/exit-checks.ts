// Automated weekly exit checks (P2). The reset added closePosition() as a
// mechanism, but nothing called it automatically — this module is the
// policy layer that decides WHEN to call it, so the same "budget cap
// reached, book frozen for months" failure that killed the 2026-06 cohort
// can't recur silently.
//
// These are WEEKLY-checked levels, not intraday stops — a position can gap
// through its stop between Sunday runs and realize a loss larger than the
// 2% risk budget planned for. That's a known, accepted tradeoff of a
// weekly-cadence agent (see the enhancement proposal's P2 tradeoffs).
import type { DiscoveryPosition } from './types.js'

export const TIME_STOP_DAYS = 180
export const THESIS_CHECK_DOWN_PCT = 0.10
export const THESIS_CHECK_HELD_DAYS = 90

export type MechanicalExitReason = 'stop hit' | 'time-stop'

export interface MechanicalExit {
  ticker: string
  reason: MechanicalExitReason
  exitPrice: number
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000
}

/**
 * Positions whose stored stop has been breached, or that have been held past
 * the time-stop window. Checked in this order — a position past both is
 * reported once, as a stop hit (the more specific reason).
 */
export function checkMechanicalExits(
  positions: DiscoveryPosition[],
  currentPrices: Record<string, number>,
  now: Date = new Date(),
): MechanicalExit[] {
  const exits: MechanicalExit[] = []
  for (const p of positions) {
    const price = currentPrices[p.ticker]
    if (price == null || price <= 0) continue

    if (p.stopPrice != null && price <= p.stopPrice) {
      exits.push({ ticker: p.ticker, reason: 'stop hit', exitPrice: price })
      continue
    }
    if (daysSince(p.openedAt, now) > TIME_STOP_DAYS) {
      exits.push({ ticker: p.ticker, reason: 'time-stop', exitPrice: price })
    }
  }
  return exits
}

/**
 * Positions that warrant a throttled LLM thesis re-review: down more than
 * THESIS_CHECK_DOWN_PCT from cost, or held longer than THESIS_CHECK_HELD_DAYS
 * — excluding anything already caught by a mechanical exit this run.
 */
export function selectThesisCheckCandidates(
  positions: DiscoveryPosition[],
  currentPrices: Record<string, number>,
  alreadyExitingTickers: Set<string>,
  now: Date = new Date(),
): DiscoveryPosition[] {
  return positions.filter(p => {
    if (alreadyExitingTickers.has(p.ticker)) return false
    const price = currentPrices[p.ticker]
    if (price == null || price <= 0) return false

    const downPct = (price - p.avgCost) / p.avgCost
    const heldDays = daysSince(p.openedAt, now)
    return downPct <= -THESIS_CHECK_DOWN_PCT || heldDays > THESIS_CHECK_HELD_DAYS
  })
}
