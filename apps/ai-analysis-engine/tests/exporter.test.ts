import { describe, it, expect, vi, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { exportAnalysis } from '../src/export/exporter.js'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'test-analysis.json')

const mockRegime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong',
  keyIndicators: ['NVDA up'], affectedTickers: ['NVDA'],
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockSignal: PropagationSignal = {
  id: 's1', date: '2026-05-23',
  sourceTicker: 'NVDA', targetTicker: 'CRWV',
  signalType: 'customer', direction: 'downstream',
  magnitude: 'strong', sentiment: 'positive',
  description: 'CRWV benefits', evidenceQuote: null,
  createdAt: '2026-05-23T06:00:00.000Z',
}

const mockHealth: CompanyHealth[] = [{
  ticker: 'NVDA', company: 'NVIDIA',
  thesisSummary: 'Dominant GPU maker',
  assumptions: [], recentChunks: [], healthScore: 'positive',
}]

afterEach(() => { if (existsSync(OUTPUT_PATH)) unlinkSync(OUTPUT_PATH) })

describe('exportAnalysis', () => {
  it('writes JSON file with correct shape', () => {
    const mockStore = {
      getLatestRegime:  vi.fn().mockReturnValue(mockRegime),
      getSignalsByDate: vi.fn().mockReturnValue([mockSignal]),
    }

    const result = exportAnalysis(mockStore as any, mockHealth, OUTPUT_PATH)

    expect(result.latestRegime.regime).toBe('AI Acceleration')
    expect(result.latestSignals).toHaveLength(1)
    expect(result.companySummaries).toHaveLength(1)
    expect(result.companySummaries[0].healthScore).toBe('positive')
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(existsSync(OUTPUT_PATH)).toBe(true)
  })

  it('throws when no regime exists', () => {
    const mockStore = {
      getLatestRegime:  vi.fn().mockReturnValue(null),
      getSignalsByDate: vi.fn(),
    }
    expect(() => exportAnalysis(mockStore as any, mockHealth, OUTPUT_PATH))
      .toThrow('No regime found')
  })
})
