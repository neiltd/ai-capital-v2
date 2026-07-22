// Loader for /today. Real disk reads (no fetch — server component), per
// docs/frontend-migration-plan-2026-07-07.md §1.5. Stitches:
//   - briefings/YYYY-MM-DD.json  (regime, calibration, actions, scenarios, watchItems)
//   - simulation.json            (strategy tag per ticker, for act/hold/dca/locked grouping)
//   - risk.json                  (portfolio pulse)
//   - harvest.json               (wash-sale windows)
//   - world-map/intelligence.json (top events)
//   - briefings/YYYY-MM-DD.md    (full narrative, rendered below the fold)

import { readBriefingJson, readSimulation, readRisk, readHarvest, readWorldIntel, readBriefing, computeNetWorthUsd, todayLocal } from '@/lib/data'
import type { BriefingJSON } from '@common/types'
import type { WorldEvent } from '@/types'

export type ActionGroupKey = 'act' | 'hold' | 'dca' | 'locked' | 'flat'

export interface BriefingViewModel {
  date: string
  /** True iff `date` is the server's local "today" — gates the strategy-bucket join. */
  isToday: boolean
  generatedAt: string
  regime: BriefingJSON['regime']
  calibrationNote: string | null
  scenarios: BriefingJSON['scenarios']
  actionGroups: Array<{ group: ActionGroupKey; title: string; actions: BriefingJSON['recommendedActions'] }>
  washSale: Array<{ ticker: string; doNotRebuyBefore: string; daysRemaining: number }>
  pulse: { netWorthUsd: number | null; sharpe: number | null; oneDayVAR95: number | null; beta: number | null; maxDrawdown: number | null }
  worldTop: WorldEvent[]
  watchItems: BriefingJSON['watchItems']
  narrativeMd: string | null
}

const GROUP_TITLES: Record<Exclude<ActionGroupKey, 'flat'>, string> = {
  act: 'Act now',
  hold: 'Hold — with active monitoring',
  dca: 'DCA — continue as scheduled',
  locked: 'Tax-locked — no action',
}

export function loadBriefing(date: string = todayLocal()): BriefingViewModel | null {
  const b = readBriefingJson(date)
  if (!b) return null

  const isToday = date === todayLocal()

  // Strategy tag per ticker (tactical/dca/tax_locked) decides which bucket a
  // "hold" action lands in — but that tag comes from *today's* live
  // simulation.json, which has no per-date archive. On a past date a ticker
  // could be tax-locked today without having been tax-locked on the date
  // actually being viewed, so bucketing anything but today's briefing would
  // silently misrepresent history. For any non-today date we skip the join
  // entirely and render the briefing's own flat recommendedActions list.
  let actionGroups: Array<{ group: ActionGroupKey; title: string; actions: BriefingJSON['recommendedActions'] }>
  if (isToday) {
    const strategyByTicker = new Map<string, string>()
    try {
      for (const p of readSimulation().portfolio) {
        strategyByTicker.set(p.ticker, (p as { strategy?: string }).strategy ?? 'tactical')
      }
    } catch { /* simulation.json missing — every action falls back to 'hold' bucket */ }

    const buckets: Record<Exclude<ActionGroupKey, 'flat'>, BriefingJSON['recommendedActions']> = { act: [], hold: [], dca: [], locked: [] }
    for (const a of b.recommendedActions) {
      if (a.action !== 'hold') { buckets.act.push(a); continue }
      const strategy = strategyByTicker.get(a.ticker) ?? 'tactical'
      if (strategy === 'tax_locked') buckets.locked.push(a)
      else if (strategy === 'dca') buckets.dca.push(a)
      else buckets.hold.push(a)
    }
    actionGroups = (['act', 'hold', 'dca', 'locked'] as const)
      .map((group) => ({ group, title: GROUP_TITLES[group], actions: buckets[group] }))
      .filter((g) => g.actions.length > 0)
  } else {
    actionGroups = [{ group: 'flat', title: 'Recommended actions', actions: b.recommendedActions }]
  }

  const harvest = readHarvest()
  const washSale = (harvest?.washSaleAlerts ?? []).map((w) => ({
    ticker: w.ticker, doNotRebuyBefore: w.doNotRebuyBefore, daysRemaining: w.daysRemaining,
  }))

  let pulse: BriefingViewModel['pulse'] = { netWorthUsd: null, sharpe: null, oneDayVAR95: null, beta: null, maxDrawdown: null }
  try {
    const risk = readRisk()
    const netWorthUsd = computeNetWorthUsd(readSimulation())
    pulse = {
      netWorthUsd,
      sharpe: risk?.sharpeRatio ?? null,
      oneDayVAR95: risk?.oneDayVAR95 ?? null,
      beta: risk?.portfolioBeta ?? null,
      maxDrawdown: risk?.maxDrawdown ?? null,
    }
  } catch { /* leave pulse null — UI renders '—' */ }

  let worldTop: WorldEvent[] = []
  try {
    worldTop = [...readWorldIntel().events].sort((a, b2) => b2.severity - a.severity).slice(0, 3)
  } catch { /* world-map intelligence.json missing */ }

  return {
    date: b.date,
    isToday,
    generatedAt: b.exportedAt,
    regime: b.regime,
    calibrationNote: b.calibrationNote,
    scenarios: b.scenarios,
    actionGroups,
    washSale,
    pulse,
    worldTop,
    watchItems: b.watchItems,
    narrativeMd: readBriefing(date),
  }
}
