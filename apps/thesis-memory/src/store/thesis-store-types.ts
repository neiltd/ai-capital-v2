// Shared async interface for ThesisStore backends.

import type {
  Thesis, Assumption, Narrative, Proposal, ProposalChange,
  ThemeMembership, AssumptionStatus, ProposalStatus,
} from '../types.js'

export interface ThesisStore {
  createThesis(thesis: Thesis): Promise<void>
  getThesis(ticker: string): Promise<Thesis | null>
  listTheses(): Promise<Thesis[]>
  updateThesisUpdatedAt(id: string, updatedAt: string): Promise<void>
  createAssumption(assumption: Assumption): Promise<void>
  getAssumptions(thesisId: string): Promise<Assumption[]>
  updateAssumptionStatus(id: string, status: AssumptionStatus, evidenceSummary: string): Promise<void>
  createNarrative(narrative: Narrative): Promise<void>
  getCurrentNarrative(thesisId: string): Promise<Narrative | null>
  getNarrativeHistory(thesisId: string): Promise<Narrative[]>
  createProposal(proposal: Proposal): Promise<void>
  getPendingProposals(): Promise<Proposal[]>
  getProposal(id: string): Promise<Proposal | null>
  updateProposalStatus(id: string, status: ProposalStatus): Promise<void>
  createProposalChange(change: ProposalChange): Promise<void>
  getProposalChanges(proposalId: string): Promise<ProposalChange[]>
  approveProposalChange(id: string, approved: boolean): Promise<void>
  addThemeMembership(membership: ThemeMembership): Promise<void>
  getThemeMembers(themeId: string): Promise<ThemeMembership[]>
  close(): Promise<void>
}
