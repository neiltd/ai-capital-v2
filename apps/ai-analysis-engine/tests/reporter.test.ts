import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { generateReport } from '../src/export/reporter.js'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, 'test-report.md')

const regime: MacroRegime = {
  id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
  confidence: 'high', rationale: 'GPU demand strong across the board.',
  keyIndicators: ['NVDA revenue up 60%', 'CRWV expanding capacity'],
  affectedTickers: ['NVDA'], createdAt: '2026-05-23T06:00:00.000Z',
}

const signals: PropagationSignal[] = [
  {
    id: 's1', date: '2026-05-23', sourceTicker: 'NVDA', targetTicker: 'CRWV',
    signalType: 'customer', direction: 'downstream', magnitude: 'strong', sentiment: 'positive',
    description: 'CRWV benefits from GPU availability', evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  },
  {
    id: 's2', date: '2026-05-23', sourceTicker: 'TSM', targetTicker: 'AMD',
    signalType: 'supply_chain', direction: 'upstream', magnitude: 'moderate', sentiment: 'negative',
    description: 'AMD capacity allocation under pressure', evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  },
]

const health: CompanyHealth[] = [
  { ticker: 'NVDA', company: 'NVIDIA', thesisSummary: '', assumptions: [], recentChunks: [], healthScore: 'positive' },
  { ticker: 'AMD', company: 'AMD', thesisSummary: '', assumptions: [], recentChunks: [], healthScore: 'negative' },
]

afterEach(() => { if (existsSync(OUTPUT_PATH)) unlinkSync(OUTPUT_PATH) })

describe('generateReport', () => {
  it('produces Markdown with all expected sections', () => {
    const content = generateReport('2026-05-23', regime, signals, health, OUTPUT_PATH)

    expect(content).toContain('# AI Analysis — 2026-05-23')
    expect(content).toContain('## Macro Regime: AI Acceleration (high confidence)')
    expect(content).toContain('GPU demand strong across the board.')
    expect(content).toContain('- NVDA revenue up 60%')
    expect(content).toContain('## Propagation Signals (2)')
    expect(content).toContain('### Positive')
    expect(content).toContain('### Negative')
    expect(content).toContain('## Company Health Snapshot')
    expect(content).toContain('| NVDA | NVIDIA | positive |')
    expect(content).toContain('| AMD | AMD | negative |')
    expect(existsSync(OUTPUT_PATH)).toBe(true)
  })

  it('shows no-signals message and omits sentiment sections when signals empty', () => {
    const content = generateReport('2026-05-23', regime, [], health, OUTPUT_PATH)

    expect(content).toContain('## Propagation Signals (0)')
    expect(content).toContain('_No active propagation signals for this period._')
    expect(content).not.toContain('### Positive')
    expect(content).not.toContain('### Negative')
  })
})
