import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'
import { exportDiscovery } from '../../src/discovery/discovery-exporter.js'
import type { DiscoveryExportCandidate, DiscoveryPosition, DiscoveryScenario, DiscoveryAction, DiscoveryJSON } from '../../src/discovery/types.js'

let tmpDir: string
let outPath: string

const sampleConfig = { threshold: 70, paperAllocation: 1000, newsDays: 7 }

const sampleCandidates: DiscoveryExportCandidate[] = [
  { ticker: 'SMCI', company: 'Super Micro Computer', score: 82, rationale: 'Supply chain pivot', source: 'news_mention', discoveredAt: '2026-05-27', action: 'buy' },
  { ticker: 'MRVL', company: 'Marvell Technology', score: 71, rationale: 'Custom ASIC pipeline', source: 'news_mention', discoveredAt: '2026-05-27', action: 'watch' },
]

const samplePortfolio: DiscoveryPosition[] = [
  {
    ticker: 'SMCI', company: 'Super Micro Computer', shares: 5.12, avgCost: 195.31,
    currentPrice: 210.50, currentValue: 1077.76, unrealizedPnl: 77.76,
    score: 82, source: 'news_mention', rationale: 'Supply chain pivot',
    openedAt: '2026-05-27', updatedAt: '2026-05-27T06:45:00.000Z',
  },
]

const sampleScenarios: DiscoveryScenario[] = [
  {
    id: 'abc-123', ticker: 'SMCI', date: '2026-05-27', scenarioType: 'best',
    title: 'AI Server Supercycle', narrative: 'Strong growth ahead.',
    timeHorizon: '12 months', probability: 60, regimeTransition: null,
    triggers: ['Hyperscaler capex'], createdAt: '2026-05-27T06:45:00.000Z',
  },
]

const sampleActions: DiscoveryAction[] = [
  { ticker: 'SMCI', recommendation: 'buy', conviction: 'high', rationale: 'Strong AI tailwind' },
]

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `exporter-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  outPath = path.join(tmpDir, 'data', 'discovery.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('exportDiscovery', () => {
  it('writes a valid discovery.json file', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const raw = readFileSync(outPath, 'utf-8')
    const parsed: DiscoveryJSON = JSON.parse(raw)
    expect(parsed).toBeDefined()
  })

  it('includes exportedAt as ISO string', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const parsed: DiscoveryJSON = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes config with threshold, paperAllocation, newsDays', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const parsed: DiscoveryJSON = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.config.threshold).toBe(70)
    expect(parsed.config.paperAllocation).toBe(1000)
    expect(parsed.config.newsDays).toBe(7)
  })

  it('candidates[] includes both buy and watch tickers', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const parsed: DiscoveryJSON = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.candidates).toHaveLength(2)
    const actions = parsed.candidates.map(c => c.action)
    expect(actions).toContain('buy')
    expect(actions).toContain('watch')
  })

  it('discoveryPortfolio[] includes all open positions', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const parsed: DiscoveryJSON = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.discoveryPortfolio).toHaveLength(1)
    expect(parsed.discoveryPortfolio[0].ticker).toBe('SMCI')
  })

  it('creates parent directory if it does not exist', () => {
    const deepPath = path.join(tmpDir, 'nested', 'deep', 'discovery.json')
    exportDiscovery({ candidates: [], discoveryPortfolio: [], scenarios: [], actions: [], config: sampleConfig }, deepPath)
    const parsed: DiscoveryJSON = JSON.parse(readFileSync(deepPath, 'utf-8'))
    expect(parsed.candidates).toHaveLength(0)
  })

  it('outputs pretty-printed JSON (has newlines)', () => {
    exportDiscovery({ candidates: sampleCandidates, discoveryPortfolio: samplePortfolio, scenarios: sampleScenarios, actions: sampleActions, config: sampleConfig }, outPath)
    const raw = readFileSync(outPath, 'utf-8')
    expect(raw).toContain('\n')
  })
})
