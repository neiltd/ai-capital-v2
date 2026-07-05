import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createAnalysisStore } from '../src/store/sqlite.js'
import type { MacroRegime, PropagationSignal } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-analysis.db')

describe('AnalysisStore', () => {
  let store: ReturnType<typeof createAnalysisStore>

  beforeEach(() => { store = createAnalysisStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  const regime: MacroRegime = {
    id: 'r1', date: '2026-05-23', regime: 'AI Acceleration',
    confidence: 'high', rationale: 'GPU demand strong',
    keyIndicators: ['NVDA revenue up', 'CRWV expanding'],
    affectedTickers: ['NVDA', 'TSM'],
    createdAt: '2026-05-23T06:00:00.000Z',
  }

  it('inserts and retrieves latest regime', () => {
    store.insertRegime(regime)
    const latest = store.getLatestRegime()
    expect(latest).not.toBeNull()
    expect(latest!.regime).toBe('AI Acceleration')
    expect(latest!.keyIndicators).toEqual(['NVDA revenue up', 'CRWV expanding'])
    expect(latest!.affectedTickers).toEqual(['NVDA', 'TSM'])
  })

  it('returns null when no regime exists', () => {
    expect(store.getLatestRegime()).toBeNull()
  })

  it('retrieves regimes by date', () => {
    store.insertRegime(regime)
    expect(store.getRegimesByDate('2026-05-23')).toHaveLength(1)
    expect(store.getRegimesByDate('2026-05-24')).toHaveLength(0)
  })

  const signal: PropagationSignal = {
    id: 's1', date: '2026-05-23',
    sourceTicker: 'NVDA', targetTicker: 'CRWV',
    signalType: 'customer', direction: 'downstream',
    magnitude: 'strong', sentiment: 'positive',
    description: 'CRWV benefits from NVDA GPU supply',
    evidenceQuote: null,
    createdAt: '2026-05-23T06:00:00.000Z',
  }

  it('inserts and retrieves signals by date', () => {
    store.insertSignal(signal)
    const results = store.getSignalsByDate('2026-05-23')
    expect(results).toHaveLength(1)
    expect(results[0].sourceTicker).toBe('NVDA')
    expect(results[0].evidenceQuote).toBeNull()
  })

  it('inserts analysis run without throwing', () => {
    store.insertRun({
      id: 'run1', date: '2026-05-23', companiesAnalyzed: 34,
      regimeId: 'r1', propagationSignalCount: 12,
      durationMs: 5000, createdAt: '2026-05-23T06:00:00.000Z',
    })
  })
})
