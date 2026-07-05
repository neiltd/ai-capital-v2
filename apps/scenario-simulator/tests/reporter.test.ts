import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { generateReport } from '../src/export/reporter.js'
import type { Scenario, PortfolioAction, Position } from '../src/types.js'

const TEST_DIR = 'tests/tmp-reporter'

const scenarios: Scenario[] = [
  {
    id: 's1', runId: 'r1', date: '2026-05-23', scenarioType: 'best',
    title: 'AI Boom', narrative: 'Strong demand continues.', timeHorizon: '3-6 months',
    probability: 65, regimeTransition: null, triggers: ['NVDA beats guidance'],
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const actions: PortfolioAction[] = [
  {
    id: 'a1', runId: 'r1', scenarioId: 's1', ticker: 'NVDA', action: 'buy',
    conviction: 'high', allocationChangePct: 15, rationale: 'AI demand accelerating.',
    createdAt: '2026-05-23T10:00:00Z',
  },
]

const positions: Position[] = [
  { ticker: 'NVDA', company: 'NVIDIA', shares: 100, avgCost: 68.50, currentPrice: 92.00, currentValue: 9200, unrealizedPnl: 2350, updatedAt: '2026-05-23T10:00:00Z' },
]

afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('generateReport', () => {
  it('writes a Markdown file with date heading, portfolio table, and scenario section', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('# Scenario Simulation — 2026-05-23')
    expect(content).toContain('## Current Portfolio')
    expect(content).toContain('NVDA')
    expect(content).toContain('Best: AI Boom')
    expect(content).toContain('buy +15%')
    expect(content).toContain('high conviction')
    expect(content).toContain('AI demand accelerating.')
  })

  it('shows "No change expected" when regimeTransition is null', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('No change expected')
  })

  it('shows regime transition label when set', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const withTransition = [{ ...scenarios[0], regimeTransition: 'Semiconductor Correction' }]
    generateReport('2026-05-23', withTransition, actions, positions, join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('→ Semiconductor Correction')
  })

  it('shows no-positions message when portfolio is empty', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    generateReport('2026-05-23', scenarios, [], [], join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('_No positions recorded._')
  })

  it('labels a whatif scenario correctly', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const whatif: Scenario[] = [{ ...scenarios[0], id: 'w1', scenarioType: 'whatif', title: 'TSMC Shock' }]
    generateReport('2026-05-23', whatif, [], [], join(TEST_DIR, 'out.md'))

    const content = readFileSync(join(TEST_DIR, 'out.md'), 'utf-8')
    expect(content).toContain('What-If: TSMC Shock')
  })
})
