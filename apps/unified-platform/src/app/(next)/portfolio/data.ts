// Loader for /portfolio. Real disk reads (no fetch — server component),
// per docs/frontend-migration-plan-2026-07-07.md §1.5/§6.2.

import { readSimulation } from '@/lib/data'
import type { Position } from '@/lib/next/types'
import type { PortfolioPosition, ScenarioAction, SimulationScenario } from '@/types'

export interface AgentScenarioView {
  id: string
  scenarioType: 'best' | 'base' | 'disruption'
  title: string
  probability: number // 0..1
  timeHorizon: string
  /** Non-hold actions the agent would take against the real book if this
   *  scenario plays out — derived from simulation.json's action↔scenario
   *  link (ScenarioAction.scenarioId), not fabricated narrative. */
  plannedActions: ScenarioAction[]
}

export interface AgentPortfolioView {
  /** The base case is the highest-probability scenario; its non-hold
   *  actions stand in for "next planned action" until the briefing emits
   *  a structured JSON envelope (backend-gaps #1/#2) with real prose. */
  baseCase: AgentScenarioView | null
  scenarios: AgentScenarioView[]
}

export interface PortfolioViewModel {
  exportedAt: string
  usdThb: number
  positions: Position[]
  /** GAP #3: no previous-close series yet. */
  dayChangeUsd: number | null
  netWorthSeries30d: number[] | null
  /** GAP #5: no financial-plan target config exists yet — hardcoded here,
   *  same buckets the design mockup used, flagged in the UI footnote. */
  targets: Partial<Record<Position['assetClass'], number>> | null
  agentView: AgentPortfolioView
}

const HARDCODED_TARGETS: Partial<Record<Position['assetClass'], number>> = {
  us_equity: 0.45,
  th_equity: 0.11,
  th_fund: 0.2,
  gold: 0.05,
  cash: 0.125,
}

function toPosition(p: PortfolioPosition, fallbackUpdatedAt: string): Position {
  return {
    ticker: p.ticker,
    company: p.company ?? p.ticker,
    shares: p.shares,
    avgCost: p.avgCost,
    currentPrice: p.currentPrice,
    currentValue: p.currentValue ?? p.shares * p.currentPrice,
    unrealizedPnl: p.unrealizedPnl ?? p.shares * (p.currentPrice - p.avgCost),
    updatedAt: p.updatedAt ?? fallbackUpdatedAt,
    assetClass: p.assetClass ?? 'us_equity',
    currency: p.currency ?? 'USD',
    priceSymbol: p.priceSymbol ?? p.ticker,
    strategy: (p as { strategy?: Position['strategy'] }).strategy ?? 'tactical',
  }
}

function buildAgentView(scenarios: SimulationScenario[], actions: ScenarioAction[]): AgentPortfolioView {
  const views: AgentScenarioView[] = scenarios.map((s) => ({
    id: s.id,
    scenarioType: s.scenarioType,
    title: s.title,
    probability: s.probability / 100,
    timeHorizon: s.timeHorizon,
    plannedActions: actions.filter((a) => a.scenarioId === s.id && a.action !== 'hold'),
  }))
  const baseCase = views.reduce<AgentScenarioView | null>(
    (best, v) => (best === null || v.probability > best.probability ? v : best),
    null,
  )
  return { baseCase, scenarios: views }
}

export function loadPortfolio(): PortfolioViewModel {
  const sim = readSimulation()
  const exportedAt = sim.exportedAt ?? new Date().toISOString()
  const usdThb = sim.usdThb ?? 1

  return {
    exportedAt,
    usdThb,
    positions: sim.portfolio.map((p) => toPosition(p, exportedAt)),
    dayChangeUsd: null,
    netWorthSeries30d: null,
    targets: HARDCODED_TARGETS,
    agentView: buildAgentView(sim.scenarios, sim.actions),
  }
}
