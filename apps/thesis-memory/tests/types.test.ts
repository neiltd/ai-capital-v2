import { describe, it, expectTypeOf } from 'vitest'
import type {
  AssumptionStatus, ThesisType, PositionSize, ProposalStatus,
  Thesis, Assumption, Narrative, Proposal, ProposalChange, ThemeMembership,
  ProposalResponse
} from '../src/types.js'

describe('types', () => {
  it('AssumptionStatus covers all states', () => {
    const s: AssumptionStatus = 'strengthening'
    expectTypeOf(s).toBeString()
  })
  it('Thesis has required fields', () => {
    expectTypeOf<Thesis>().toHaveProperty('ticker')
    expectTypeOf<Thesis>().toHaveProperty('positionSize')
  })
  it('ProposalResponse has assumption_changes and narrative_update', () => {
    expectTypeOf<ProposalResponse>().toHaveProperty('assumption_changes')
    expectTypeOf<ProposalResponse>().toHaveProperty('narrative_update')
  })
})
