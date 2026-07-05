// tests/thesis/updater.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyApprovedChanges } from '../../src/thesis/updater.js'
import { createThesisStore, ThesisStore } from '../../src/store/sqlite.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Thesis, Assumption, Narrative, Proposal, ProposalChange } from '../../src/types.js'

let tmpDir: string
let store: ThesisStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'updater-test-'))
  store = createThesisStore(join(tmpDir, 'thesis.db'))

  const thesis: Thesis = {
    id: 't1', ticker: 'NVDA', type: 'company', positionSize: 'core',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  store.createThesis(thesis)

  const assumption: Assumption = {
    id: 'a1', thesisId: 't1', label: 'CUDA moat remains dominant', status: 'stable',
    lastEvidenceSummary: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  store.createAssumption(assumption)

  const narrative: Narrative = {
    id: 'n1', thesisId: 't1', content: 'Original narrative.', version: 1,
    createdAt: '2026-01-01T00:00:00Z',
  }
  store.createNarrative(narrative)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true })
})

describe('applyApprovedChanges', () => {
  it('updates assumption status when change is approved', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c1', proposalId: 'p1', changeType: 'assumption_status', assumptionId: 'a1',
      oldValue: 'stable', newValue: 'strengthening',
      reasoning: 'Strong revenue growth', evidenceQuotes: ['revenue up 85%'], approved: true,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const updated = store.getAssumptions('t1')[0]
    expect(updated.status).toBe('strengthening')
    expect(updated.lastEvidenceSummary).toBe('Strong revenue growth')
  })

  it('creates a new narrative version when narrative change is approved', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c2', proposalId: 'p1', changeType: 'narrative', assumptionId: null,
      oldValue: 'Original narrative.', newValue: 'Updated narrative reflecting new evidence.',
      reasoning: 'Evidence supports stronger thesis', evidenceQuotes: [], approved: true,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const history = store.getNarrativeHistory('t1')
    expect(history).toHaveLength(2)
    expect(history[1].content).toBe('Updated narrative reflecting new evidence.')
    expect(history[1].version).toBe(2)
  })

  it('does not apply rejected changes', () => {
    const proposal: Proposal = {
      id: 'p1', thesisId: 't1', status: 'pending', chunkIdsUsed: [],
      claudeReasoning: '', createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)

    const change: ProposalChange = {
      id: 'c1', proposalId: 'p1', changeType: 'assumption_status', assumptionId: 'a1',
      oldValue: 'stable', newValue: 'weakening',
      reasoning: 'Some concern', evidenceQuotes: [], approved: false,
    }
    store.createProposalChange(change)

    applyApprovedChanges('p1', store)

    const assumption = store.getAssumptions('t1')[0]
    expect(assumption.status).toBe('stable')
  })
})
