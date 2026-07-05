// Postgres-backed GraphStore. Talks to graph.* schema; see packages/db/migrations/005_graph.sql.

import { getPool } from '@common/db'
import type { Node, Edge, Proposal, ProposalEdge, EdgeStatus, RelType, Strength } from '../types.js'
import type { GraphStore } from './graph-store-types.js'

export function createPgGraphStore(): GraphStore {
  const pool = getPool()

  return {
    async upsertNode(node: Node): Promise<void> {
      await pool.query(
        `INSERT INTO graph.nodes (ticker, company, themes) VALUES ($1, $2, $3)
         ON CONFLICT (ticker) DO UPDATE SET company = EXCLUDED.company, themes = EXCLUDED.themes`,
        [node.ticker, node.company, JSON.stringify(node.themes)],
      )
    },

    async getNodes(): Promise<Node[]> {
      const { rows } = await pool.query<{ ticker: string; company: string; themes: string }>(
        'SELECT ticker, company, themes FROM graph.nodes',
      )
      return rows.map(r => ({
        ticker:  r.ticker,
        company: r.company,
        themes:  JSON.parse(r.themes),
      }))
    },

    async insertEdge(edge: Edge): Promise<void> {
      // ON CONFLICT DO NOTHING mirrors SQLite INSERT OR IGNORE.
      await pool.query(
        `INSERT INTO graph.edges
           (id, from_ticker, to_ticker, rel_type, strength, description, status,
            source_chunk_ids, evidence_quote, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [
          edge.id, edge.from, edge.to, edge.type, edge.strength,
          edge.description, edge.status, JSON.stringify(edge.sourceChunkIds),
          edge.evidenceQuote, edge.createdAt, edge.updatedAt,
        ],
      )
    },

    async edgeExists(from: string, to: string, type: string): Promise<boolean> {
      const { rows } = await pool.query(
        `SELECT 1 FROM graph.edges
          WHERE from_ticker = $1 AND to_ticker = $2 AND rel_type = $3 AND status <> 'rejected'
          LIMIT 1`,
        [from, to, type],
      )
      return rows.length > 0
    },

    async getActiveEdges(): Promise<Edge[]> {
      const { rows } = await pool.query<{
        id: string; from_ticker: string; to_ticker: string; rel_type: string
        strength: string; description: string; status: string; source_chunk_ids: string
        evidence_quote: string | null; created_at: Date; updated_at: Date
      }>(
        `SELECT id, from_ticker, to_ticker, rel_type, strength, description, status,
                source_chunk_ids, evidence_quote, created_at, updated_at
           FROM graph.edges
          WHERE status IN ('seed', 'confirmed')`,
      )
      return rows.map(r => ({
        id:             r.id,
        from:           r.from_ticker,
        to:             r.to_ticker,
        type:           r.rel_type    as RelType,
        strength:       r.strength    as Strength,
        description:    r.description,
        status:         r.status      as EdgeStatus,
        sourceChunkIds: JSON.parse(r.source_chunk_ids),
        evidenceQuote:  r.evidence_quote,
        createdAt:      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt:      r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      }))
    },

    async insertProposal(proposal: Proposal): Promise<void> {
      await pool.query(
        `INSERT INTO graph.proposals
           (id, status, claude_reasoning, chunk_ids_used, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          proposal.id, proposal.status, proposal.claudeReasoning,
          JSON.stringify(proposal.chunkIdsUsed), proposal.createdAt, proposal.resolvedAt,
        ],
      )
    },

    async insertProposalEdge(pe: ProposalEdge): Promise<void> {
      await pool.query(
        `INSERT INTO graph.proposal_edges
           (id, proposal_id, from_ticker, to_ticker, rel_type, strength, description, evidence_quote, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          pe.id, pe.proposalId, pe.from, pe.to, pe.type, pe.strength,
          pe.description, pe.evidenceQuote,
          pe.approved === null ? null : pe.approved,
        ],
      )
    },

    async getPendingProposalEdges(): Promise<ProposalEdge[]> {
      const { rows } = await pool.query<{
        id: string; proposal_id: string; from_ticker: string; to_ticker: string
        rel_type: string; strength: string; description: string; evidence_quote: string | null
      }>(
        `SELECT id, proposal_id, from_ticker, to_ticker, rel_type, strength, description, evidence_quote
           FROM graph.proposal_edges WHERE approved IS NULL`,
      )
      return rows.map(r => ({
        id:            r.id,
        proposalId:    r.proposal_id,
        from:          r.from_ticker,
        to:            r.to_ticker,
        type:          r.rel_type as RelType,
        strength:      r.strength as Strength,
        description:   r.description,
        evidenceQuote: r.evidence_quote,
        approved:      null,
      }))
    },

    async resolveProposalEdge(id: string, approved: boolean): Promise<void> {
      await pool.query(
        `UPDATE graph.proposal_edges SET approved = $1 WHERE id = $2`,
        [approved, id],
      )
    },

    async close(): Promise<void> {
      // Pool is shared and closed centrally by the CLI's main(); per-store close is a no-op.
    },
  }
}
