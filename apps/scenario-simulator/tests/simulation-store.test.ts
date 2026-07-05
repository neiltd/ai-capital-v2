import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createSimulationStore } from '../src/store/sqlite.js'
import type { SimulationRun, Scenario, PortfolioAction } from '../src/types.js'

const TEST_DIR = 'tests/tmp-sim'
const DB_PATH  = join(TEST_DIR, 'simulation-test.db')

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

const run: SimulationRun = {
  id: 'run-1', date: '2026-05-23', type: 'daily', trigger: null,
  scenarioCount: 3, actionCount: 6, durationMs: 12000, createdAt: '2026-05-23T10:00:00Z',
}

const scenario: Scenario = {
  id: 's1', runId: 'run-1', date: '2026-05-23', scenarioType: 'best',
  title: 'AI Boom', narrative: 'Strong demand continues.', timeHorizon: '3-6 months',
  probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'],
  createdAt: '2026-05-23T10:00:00Z',
}

const action: PortfolioAction = {
  id: 'a1', runId: 'run-1', scenarioId: 's1', ticker: 'NVDA',
  action: 'buy', conviction: 'high', allocationChangePct: 15,
  rationale: 'AI demand accelerating.', createdAt: '2026-05-23T10:00:00Z',
}

describe('SimulationStore', () => {
  it('inserts and retrieves a run with getLatestRun', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    const latest = store.getLatestRun()
    store.close()

    expect(latest).not.toBeNull()
    expect(latest!.id).toBe('run-1')
    expect(latest!.type).toBe('daily')
    expect(latest!.trigger).toBeNull()
  })

  it('inserts and retrieves a scenario with triggers round-tripped as string[]', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    store.insertScenario(scenario)
    const scenarios = store.getScenariosByRunId('run-1')
    store.close()

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].scenarioType).toBe('best')
    expect(scenarios[0].triggers).toEqual(['NVDA beats guidance'])
    expect(scenarios[0].regimeTransition).toBeNull()
  })

  it('inserts and retrieves a portfolio action', () => {
    const store = createSimulationStore(DB_PATH)
    store.insertRun(run)
    store.insertScenario(scenario)
    store.insertAction(action)
    const actions = store.getActionsByRunId('run-1')
    store.close()

    expect(actions).toHaveLength(1)
    expect(actions[0].allocationChangePct).toBe(15)
    expect(actions[0].action).toBe('buy')
    expect(actions[0].scenarioId).toBe('s1')
  })

  it('getLatestRun returns null when no runs exist', () => {
    const store = createSimulationStore(DB_PATH)
    const latest = store.getLatestRun()
    store.close()

    expect(latest).toBeNull()
  })
})
