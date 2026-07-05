// Shared async interface for the GraphStore backends (SQLite + Postgres).

import type { Node, Edge, Proposal, ProposalEdge } from '../types.js'

export interface GraphStore {
  upsertNode(node: Node): Promise<void>
  getNodes(): Promise<Node[]>
  insertEdge(edge: Edge): Promise<void>
  edgeExists(from: string, to: string, type: string): Promise<boolean>
  getActiveEdges(): Promise<Edge[]>
  insertProposal(proposal: Proposal): Promise<void>
  insertProposalEdge(pe: ProposalEdge): Promise<void>
  getPendingProposalEdges(): Promise<ProposalEdge[]>
  resolveProposalEdge(id: string, approved: boolean): Promise<void>
  close(): Promise<void>
}
