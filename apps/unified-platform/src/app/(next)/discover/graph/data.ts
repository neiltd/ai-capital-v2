// Loader for /discover/graph. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// Reuses GraphClient.tsx (the existing force-directed graph, react-force-
// graph-2d) verbatim — port, don't rewrite, same as the /world Map tab.
// The spec's ego-network-first default, held-position node styling, and
// interactive theme lens would all need surgical changes to that
// component's physics/canvas code; deferred rather than risking the
// working component within this pass. Theme exposure (the spec's "money
// question" — how much of the real portfolio moves if a theme breaks) is
// computed separately below as a static table instead of an interactive
// dimming lens.

import { readGraph, readSimulation, computeNetWorthUsd } from '@/lib/data'
import { toUsd } from '@/lib/next/format'

export interface ThemeExposure {
  theme: string
  tickers: string[]
  heldTickers: string[]
  exposureUsd: number
  pctOfNetWorth: number | null
}

export interface GraphViewModel {
  exportedAt: string
  nodeCount: number
  edgeCount: number
  heldTickers: Set<string>
  themeExposure: ThemeExposure[]
}

export function loadGraphExposure(): GraphViewModel | null {
  const graph = readGraph()
  if (!graph) return null

  let heldTickers = new Set<string>()
  let netWorthUsd: number | null = null
  let valueByTicker = new Map<string, number>()
  try {
    const sim = readSimulation()
    netWorthUsd = computeNetWorthUsd(sim)
    for (const p of sim.portfolio) {
      heldTickers.add(p.ticker)
      if (typeof p.currentValue === 'number') {
        const currency = p.currency ?? 'USD'
        valueByTicker.set(p.ticker, toUsd({ currentValue: p.currentValue, currency }, sim.usdThb ?? 1))
      }
    }
  } catch { /* simulation.json missing */ }

  const themeMap = new Map<string, Set<string>>()
  for (const n of graph.nodes) {
    for (const theme of n.themes) {
      if (!themeMap.has(theme)) themeMap.set(theme, new Set())
      themeMap.get(theme)!.add(n.ticker)
    }
  }

  const themeExposure: ThemeExposure[] = Array.from(themeMap.entries())
    .map(([theme, tickerSet]) => {
      const tickers = Array.from(tickerSet)
      const held = tickers.filter((t) => heldTickers.has(t))
      const exposureUsd = held.reduce((s, t) => s + (valueByTicker.get(t) ?? 0), 0)
      return {
        theme,
        tickers,
        heldTickers: held,
        exposureUsd,
        pctOfNetWorth: netWorthUsd ? exposureUsd / netWorthUsd : null,
      }
    })
    .filter((t) => t.heldTickers.length > 0)
    .sort((a, b) => b.exposureUsd - a.exposureUsd)

  return {
    exportedAt: graph.exportedAt ?? '',
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    heldTickers,
    themeExposure,
  }
}
