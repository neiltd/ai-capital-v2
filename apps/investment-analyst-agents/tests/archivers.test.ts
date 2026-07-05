import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { archivePrediction } from '../src/archive/prediction-archiver.js'
import { archiveQA }         from '../src/archive/qa-archiver.js'
import type { PredictionEntry, QAEntry } from '../src/types.js'

const TMP = 'tests/tmp-archivers'

const mockPrediction: PredictionEntry = {
  date: '2026-05-26', regime: 'AI Acceleration', confidence: 'high',
  scenarios: [{ scenarioType: 'best', title: 'AI Boom', probability: 65, timeHorizon: '3-6 months', regimeTransition: null, triggers: ['NVDA beats'] }],
  actions:   [{ ticker: 'NVDA', scenarioType: 'best', action: 'buy', conviction: 'high', allocationChangePct: 25 }],
}

const mockQA: QAEntry = {
  date: '2026-05-26', timestamp: '2026-05-26T08:00:00Z', mode: 'single',
  exchanges: [{ question: 'What is the regime?', answer: 'AI Acceleration.' }],
}

beforeEach(() => { mkdirSync(TMP, { recursive: true }) })
afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('archivePrediction', () => {
  it('creates directory and writes a valid JSONL line', () => {
    const path = join(TMP, 'sub', 'predictions.jsonl')
    archivePrediction(mockPrediction, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).date).toBe('2026-05-26')
    expect(JSON.parse(lines[0]).scenarios).toHaveLength(1)
  })

  it('appends a second entry on a second call', () => {
    const path = join(TMP, 'predictions.jsonl')
    archivePrediction(mockPrediction, path)
    archivePrediction({ ...mockPrediction, date: '2026-05-27' }, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).date).toBe('2026-05-27')
  })
})

describe('archiveQA', () => {
  it('creates directory and writes a valid JSONL line', () => {
    const path = join(TMP, 'sub', 'qa.jsonl')
    archiveQA(mockQA, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.mode).toBe('single')
    expect(parsed.exchanges[0].question).toBe('What is the regime?')
  })

  it('appends a second entry on a second call', () => {
    const path = join(TMP, 'qa.jsonl')
    archiveQA(mockQA, path)
    archiveQA({ ...mockQA, timestamp: '2026-05-26T09:00:00Z' }, path)
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})
