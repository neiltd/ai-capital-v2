export type RelType      = 'supply_chain' | 'customer' | 'technology' | 'competitive'
export type Strength     = 'strong' | 'moderate' | 'weak'
export type EdgeStatus   = 'seed' | 'confirmed' | 'rejected' | 'pending'
export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface Node {
  ticker:  string
  company: string
  themes:  string[]
}

export interface Edge {
  id:             string
  from:           string
  to:             string
  type:           RelType
  strength:       Strength
  description:    string
  status:         EdgeStatus
  sourceChunkIds: string[]
  evidenceQuote:  string | null
  createdAt:      string
  updatedAt:      string
}

export interface Proposal {
  id:              string
  status:          ProposalStatus
  claudeReasoning: string
  chunkIdsUsed:    string[]
  createdAt:       string
  resolvedAt:      string | null
}

export interface ProposalEdge {
  id:            string
  proposalId:    string
  from:          string
  to:            string
  type:          RelType
  strength:      Strength
  description:   string
  evidenceQuote: string | null
  approved:      boolean | null
}

export interface SeedEdge {
  from:        string
  to:          string
  type:        RelType
  strength:    Strength
  description: string
}

export interface GraphJSON {
  schemaVersion?: string
  exportedAt: string
  nodes: Array<{ ticker: string; company: string; themes: string[] }>
  edges: Array<{
    from:          string
    to:            string
    type:          RelType
    strength:      Strength
    description:   string
    evidenceQuote: string | null
  }>
}

export interface ExtractedRelationship {
  from:          string
  to:            string
  type:          RelType
  strength:      Strength
  description:   string
  evidenceQuote: string
  reasoning:     string
}

export interface ExtractionResult {
  relationships: ExtractedRelationship[]
}
