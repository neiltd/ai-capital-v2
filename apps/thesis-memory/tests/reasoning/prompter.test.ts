// tests/reasoning/prompter.test.ts
import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../../src/reasoning/prompter.js'
import type { Thesis, Assumption, Narrative, EvidenceChunk } from '../../src/types.js'

const thesis: Thesis = {
  id: 't1', ticker: 'NVDA', type: 'company', positionSize: 'core',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
}

const assumptions: Assumption[] = [
  { id: 'a1', thesisId: 't1', label: 'CUDA moat remains dominant', status: 'stable',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'a2', thesisId: 't1', label: 'Hyperscaler capex growing', status: 'weakening',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

const narrative: Narrative = {
  id: 'n1', thesisId: 't1', content: 'NVIDIA dominates AI compute infrastructure.',
  version: 1, createdAt: '2026-01-01T00:00:00Z',
}

const chunks: EvidenceChunk[] = [
  { id: 'c1', ticker: 'NVDA', source: 'sec_filing', docType: '10-Q',
    section: 'mda', publishedDate: '2026-05-20',
    content: 'Data center revenue grew 427% year over year.' },
]

describe('buildPrompt', () => {
  it('includes the current narrative', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('NVIDIA dominates AI compute infrastructure.')
  })

  it('includes all assumption labels and statuses', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('CUDA moat remains dominant')
    expect(prompt).toContain('[stable]')
    expect(prompt).toContain('Hyperscaler capex growing')
    expect(prompt).toContain('[weakening]')
  })

  it('includes evidence chunk content', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('Data center revenue grew 427%')
  })

  it('includes the ticker and date range', () => {
    const prompt = buildPrompt(thesis, assumptions, narrative, chunks, '2026-04-01')
    expect(prompt).toContain('NVDA')
    expect(prompt).toContain('2026-04-01')
  })
})
