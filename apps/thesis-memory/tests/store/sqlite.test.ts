// tests/store/sqlite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createThesisStore, ThesisStore } from '../../src/store/sqlite.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Thesis, Assumption, Narrative, Proposal, ProposalChange } from '../../src/types.js'

let tmpDir: string
let store: ThesisStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'thesis-test-'))
  store = createThesisStore(join(tmpDir, 'thesis.db'))
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true })
})

const thesis: Thesis = {
  id: 'thesis-1', ticker: 'NVDA', type: 'company',
  positionSize: 'core', createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
}

const assumption: Assumption = {
  id: 'assum-1', thesisId: 'thesis-1', label: 'CUDA moat remains dominant',
  status: 'stable', lastEvidenceSummary: null,
  createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
}

const narrative: Narrative = {
  id: 'narr-1', thesisId: 'thesis-1',
  content: 'NVIDIA holds a dominant position in AI compute.',
  version: 1, createdAt: '2026-05-22T00:00:00Z',
}

describe('ThesisStore', () => {
  it('creates and retrieves a thesis', () => {
    store.createThesis(thesis)
    expect(store.getThesis('NVDA')).toMatchObject({ ticker: 'NVDA', type: 'company' })
  })

  it('returns null for unknown ticker', () => {
    expect(store.getThesis('UNKNOWN')).toBeNull()
  })

  it('lists all theses', () => {
    store.createThesis(thesis)
    store.createThesis({ ...thesis, id: 'thesis-2', ticker: 'TSM' })
    expect(store.listTheses()).toHaveLength(2)
  })

  it('creates and retrieves assumptions', () => {
    store.createThesis(thesis)
    store.createAssumption(assumption)
    const assumptions = store.getAssumptions('thesis-1')
    expect(assumptions).toHaveLength(1)
    expect(assumptions[0].label).toBe('CUDA moat remains dominant')
  })

  it('updates assumption status', () => {
    store.createThesis(thesis)
    store.createAssumption(assumption)
    store.updateAssumptionStatus('assum-1', 'strengthening', 'Q1 2026 revenue beat confirms moat')
    const updated = store.getAssumptions('thesis-1')[0]
    expect(updated.status).toBe('strengthening')
    expect(updated.lastEvidenceSummary).toBe('Q1 2026 revenue beat confirms moat')
  })

  it('creates narratives append-only', () => {
    store.createThesis(thesis)
    store.createNarrative(narrative)
    store.createNarrative({ ...narrative, id: 'narr-2', content: 'Updated narrative.', version: 2 })
    expect(store.getNarrativeHistory('thesis-1')).toHaveLength(2)
    expect(store.getCurrentNarrative('thesis-1')?.version).toBe(2)
  })

  it('creates and retrieves pending proposals', () => {
    store.createThesis(thesis)
    const proposal: Proposal = {
      id: 'prop-1', thesisId: 'thesis-1', status: 'pending',
      chunkIdsUsed: ['chunk-1', 'chunk-2'], claudeReasoning: 'Analysis...',
      createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)
    expect(store.getPendingProposals()).toHaveLength(1)
    store.updateProposalStatus('prop-1', 'approved')
    expect(store.getPendingProposals()).toHaveLength(0)
  })

  it('creates and approves proposal changes', () => {
    store.createThesis(thesis)
    const proposal: Proposal = {
      id: 'prop-1', thesisId: 'thesis-1', status: 'pending',
      chunkIdsUsed: [], claudeReasoning: '',
      createdAt: '2026-05-22T00:00:00Z', resolvedAt: null,
    }
    store.createProposal(proposal)
    const change: ProposalChange = {
      id: 'change-1', proposalId: 'prop-1', changeType: 'assumption_status',
      assumptionId: 'assum-1', oldValue: 'stable', newValue: 'strengthening',
      reasoning: 'Strong revenue beat', evidenceQuotes: ['revenue up 85%'], approved: null,
    }
    store.createProposalChange(change)
    store.approveProposalChange('change-1', true)
    const changes = store.getProposalChanges('prop-1')
    expect(changes[0].approved).toBe(true)
  })

  it('manages theme memberships', () => {
    store.createThesis(thesis)
    store.createThesis({ ...thesis, id: 'theme-1', ticker: 'ai-infrastructure', type: 'theme' })
    store.addThemeMembership({ themeId: 'theme-1', ticker: 'NVDA', weight: 0.35 })
    const members = store.getThemeMembers('theme-1')
    expect(members).toHaveLength(1)
    expect(members[0].weight).toBe(0.35)
  })
})
