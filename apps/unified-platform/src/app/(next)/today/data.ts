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

export type ActionGroupKey = 'act' | 'hold' | 'dca' | 'locked'

export interface BriefingViewModel {
  date: string
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

const GROUP_TITLES: Record<ActionGroupKey, string> = {
  act: 'Act now',
  hold: 'Hold — with active monitoring',
  dca: 'DCA — continue as scheduled',
  locked: 'Tax-locked — no action',
}

export function loadBriefing(date: string = todayLocal()): BriefingViewModel | null {
  const b = readBriefingJson(date)
  if (!b) return null

  // Strategy tag per ticker (tactical/dca/tax_locked) determines which
  // bucket a "hold" action lands in — the briefing JSON itself doesn't
  // carry strategy, so this is a mechanical join, not a guess.
  const strategyByTicker = new Map<string, string>()
  try {
    for (const p of readSimulation().portfolio) {
      strategyByTicker.set(p.ticker, (p as { strategy?: string }).strategy ?? 'tactical')
    }
  } catch { /* simulation.json missing — every action falls back to 'hold' bucket */ }

  const buckets: Record<ActionGroupKey, BriefingJSON['recommendedActions']> = { act: [], hold: [], dca: [], locked: [] }
  for (const a of b.recommendedActions) {
    if (a.action !== 'hold') { buckets.act.push(a); continue }
    const strategy = strategyByTicker.get(a.ticker) ?? 'tactical'
    if (strategy === 'tax_locked') buckets.locked.push(a)
    else if (strategy === 'dca') buckets.dca.push(a)
    else buckets.hold.push(a)
  }
  const actionGroups = (['act', 'hold', 'dca', 'locked'] as const)
    .map((group) => ({ group, title: GROUP_TITLES[group], actions: buckets[group] }))
    .filter((g) => g.actions.length > 0)

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
