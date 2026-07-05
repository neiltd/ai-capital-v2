import Database from 'better-sqlite3'
import type { Node, Edge, Proposal, ProposalEdge, EdgeStatus, RelType, Strength } from '../types.js'
import type { GraphStore } from './graph-store-types.js'

export function createSqliteGraphStore(dbPath: string): GraphStore {
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      ticker  TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      themes  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id               TEXT PRIMARY KEY,
      from_ticker      TEXT NOT NULL,
      to_ticker        TEXT NOT NULL,
      rel_type         TEXT NOT NULL,
      strength         TEXT NOT NULL,
      description      TEXT NOT NULL,
      status           TEXT NOT NULL,
      source_chunk_ids TEXT NOT NULL,
      evidence_quote   TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id               TEXT PRIMARY KEY,
      status           TEXT NOT NULL,
      claude_reasoning TEXT NOT NULL,
      chunk_ids_used   TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      resolved_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS proposal_edges (
      id             TEXT PRIMARY KEY,
      proposal_id    TEXT NOT NULL,
      from_ticker    TEXT NOT NULL,
      to_ticker      TEXT NOT NULL,
      rel_type       TEXT NOT NULL,
      strength       TEXT NOT NULL,
      description    TEXT NOT NULL,
      evidence_quote TEXT,
      approved       INTEGER
    );
  `)

  return {
    async upsertNode(node: Node): Promise<void> {
      db.prepare(`
        INSERT INTO nodes (ticker, company, themes) VALUES (?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET company = excluded.company, themes = excluded.themes
      `).run(node.ticker, node.company, JSON.stringify(node.themes))
    },

    async getNodes(): Promise<Node[]> {
      const rows = db.prepare('SELECT * FROM nodes').all() as any[]
      return rows.map(r => ({ ticker: r.ticker, company: r.company, themes: JSON.parse(r.themes) }))
    },

    async insertEdge(edge: Edge): Promise<void> {
      db.prepare(`
        INSERT OR IGNORE INTO edges
          (id, from_ticker, to_ticker, rel_type, strength, description, status,
           source_chunk_ids, evidence_quote, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        edge.id, edge.from, edge.to, edge.type, edge.strength,
        edge.description, edge.status, JSON.stringify(edge.sourceChunkIds),
        edge.evidenceQuote, edge.createdAt, edge.updatedAt,
      )
    },

    async edgeExists(from: string, to: string, type: string): Promise<boolean> {
      const row = db.prepare(`
        SELECT id FROM edges
        WHERE from_ticker = ? AND to_ticker = ? AND rel_type = ? AND status != 'rejected'
      `).get(from, to, type)
      return row !== undefined
    },

    async getActiveEdges(): Promise<Edge[]> {
      const rows = db.prepare(
        `SELECT * FROM edges WHERE status IN ('seed', 'confirmed')`
      ).all() as any[]
      return rows.map(r => ({
        id:             r.id,
        from:           r.from_ticker,
        to:             r.to_ticker,
        type:           r.rel_type as RelType,
        strength:       r.strength as Strength,
        description:    r.description,
        status:         r.status as EdgeStatus,
        sourceChunkIds: JSON.parse(r.source_chunk_ids),
        evidenceQuote:  r.evidence_quote ?? null,
        createdAt:      r.created_at,
        updatedAt:      r.updated_at,
      }))
    },

    async insertProposal(proposal: Proposal): Promise<void> {
      db.prepare(`
        INSERT INTO proposals (id, status, claude_reasoning, chunk_ids_used, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        proposal.id, proposal.status, proposal.claudeReasoning,
        JSON.stringify(proposal.chunkIdsUsed), proposal.createdAt, proposal.resolvedAt,
      )
    },

    async insertProposalEdge(pe: ProposalEdge): Promise<void> {
      db.prepare(`
        INSERT INTO proposal_edges
          (id, proposal_id, from_ticker, to_ticker, rel_type, strength, description, evidence_quote, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pe.id, pe.proposalId, pe.from, pe.to, pe.type, pe.strength,
        pe.description, pe.evidenceQuote,
        pe.approved === null ? null : pe.approved ? 1 : 0,
      )
    },

    async getPendingProposalEdges(): Promise<ProposalEdge[]> {
      const rows = db.prepare(
        `SELECT * FROM proposal_edges WHERE approved IS NULL`
      ).all() as any[]
      return rows.map(r => ({
        id:            r.id,
        proposalId:    r.proposal_id,
        from:          r.from_ticker,
        to:            r.to_ticker,
        type:          r.rel_type as RelType,
        strength:      r.strength as Strength,
        description:   r.description,
        evidenceQuote: r.evidence_quote ?? null,
        approved:      null,
      }))
    },

    async resolveProposalEdge(id: string, approved: boolean): Promise<void> {
      db.prepare(`UPDATE proposal_edges SET approved = ? WHERE id = ?`)
        .run(approved ? 1 : 0, id)
    },

    async close(): Promise<void> { db.close() },
  }
}
