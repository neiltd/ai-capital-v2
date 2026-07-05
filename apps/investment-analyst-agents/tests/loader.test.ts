import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { loadContext } from '../src/context/loader.js'

const TMP = 'tests/tmp-loader'

const mockAnalysis = {
  exportedAt: '', latestRegime: { id: 'r1', date: '', regime: 'AI Acceleration', confidence: 'high', rationale: '', keyIndicators: [], affectedTickers: [], createdAt: '' },
  latestSignals: [], companySummaries: [],
}
const mockSimulation = { exportedAt: '', portfolio: [], scenarios: [], actions: [] }
const mockGraph      = { exportedAt: '', nodes: [], edges: [] }
const mockStockIntel = { date: '', marketEvents: [], macroRiskSignals: [], sectorExposure: [] }
const mockWorldIntel = { date: '', events: [], countrySignals: [] }

function writeMockFiles(dir: string, includeProfile = false) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'analysis.json'),    JSON.stringify(mockAnalysis))
  writeFileSync(join(dir, 'simulation.json'),  JSON.stringify(mockSimulation))
  writeFileSync(join(dir, 'graph.json'),       JSON.stringify(mockGraph))
  writeFileSync(join(dir, 'stock-intel.json'), JSON.stringify(mockStockIntel))
  writeFileSync(join(dir, 'world-intel.json'), JSON.stringify(mockWorldIntel))
  if (includeProfile) writeFileSync(join(dir, 'profile.md'), '# My Profile\nRisk: moderate')
}

const paths = (dir: string) => ({
  analysisPath:   join(dir, 'analysis.json'),
  simulationPath: join(dir, 'simulation.json'),
  graphPath:      join(dir, 'graph.json'),
  stockIntelPath: join(dir, 'stock-intel.json'),
  worldIntelPath: join(dir, 'world-intel.json'),
  profilePath:    join(dir, 'profile.md'),
})

beforeEach(() => { mkdirSync(TMP, { recursive: true }) })
afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('loadContext', () => {
  it('returns a full ContextBundle when all files are present including profile', () => {
    writeMockFiles(TMP, true)
    const ctx = loadContext('2026-05-26', paths(TMP))
    expect(ctx.date).toBe('2026-05-26')
    expect(ctx.profileMissing).toBe(false)
    expect(ctx.profile).toContain('My Profile')
    expect(ctx.analysis.latestRegime.regime).toBe('AI Acceleration')
  })

  it('returns profileMissing:true and empty string when profile.md is absent', () => {
    writeMockFiles(TMP, false)
    const ctx = loadContext('2026-05-26', paths(TMP))
    expect(ctx.profileMissing).toBe(true)
    expect(ctx.profile).toBe('')
  })

  it('throws when a required JSON file is missing', () => {
    mkdirSync(TMP, { recursive: true })
    // analysis.json intentionally not written
    expect(() => loadContext('2026-05-26', paths(TMP))).toThrow()
  })
})
