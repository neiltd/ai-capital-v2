export type AssumptionStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'
export type ThesisType = 'company' | 'theme'
export type PositionSize = 'core' | 'satellite' | 'watchlist' | 'none'
export type ProposalStatus = 'pending' | 'approved' | 'rejected'
export type ChangeType = 'assumption_status' | 'narrative' | 'portfolio_action'
export type PortfolioAction = 'buy' | 'add' | 'hold' | 'reduce' | 'sell' | 'rotate'

export interface Thesis {
  id: string
  ticker: string
  type: ThesisType
  positionSize: PositionSize
  createdAt: string
  updatedAt: string
}

export interface Assumption {
  id: string
  thesisId: string
  label: string
  status: AssumptionStatus
  lastEvidenceSummary: string | null
  createdAt: string
  updatedAt: string
}

export interface Narrative {
  id: string
  thesisId: string
  content: string
  version: number
  createdAt: string
}

export interface Proposal {
  id: string
  thesisId: string
  status: ProposalStatus
  chunkIdsUsed: string[]
  claudeReasoning: string
  createdAt: string
  resolvedAt: string | null
}

export interface ProposalChange {
  id: string
  proposalId: string
  changeType: ChangeType
  assumptionId: string | null
  oldValue: string
  newValue: string
  reasoning: string
  evidenceQuotes: string[]
  approved: boolean | null
}

export interface ThemeMembership {
  themeId: string
  ticker: string
  weight: number
}

export interface ProposalResponse {
  assumption_changes: Array<{
    label: string
    old_status: AssumptionStatus
    new_status: AssumptionStatus
    reasoning: string
    evidence_quotes: string[]
  }>
  narrative_update: string
  portfolio_action: {
    action: PortfolioAction
    reasoning: string
    conviction: number
  } | null
}

export interface EvidenceChunk {
  id: string
  ticker: string
  source: string
  docType: string
  section: string
  publishedDate: string
  content: string
}
