// GRAPH adapter: apps/dependency-graph-engine/data/graph.db
//   nodes           -> graph.nodes            (cold-preserved)
//   edges           -> graph.edges            (cold-preserved)
//   proposals       -> graph.proposals        (cold-preserved)
//   proposal_edges  -> graph.proposal_edges   (cold-preserved)
//
// Every graph.* table is COLD-PRESERVED: no LOGIN role holds any privilege on
// them after lockdown, and `graph` is in the pipeline's forbidden-schema set.
// The data is copied and retained; granting a runtime consumer is a separate,
// separately reviewed decision and is deliberately not part of this slice.
//
// This adapter owns no transaction and no pool.

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import {
  assertSqliteSchema,
  openSourceSqlite,
  requireNullableBooleanInt,
  resolveUnderRoot,
} from '../legacy-copy.js'

export const NODES_COLUMNS = ['ticker', 'company', 'themes'] as const
export const EDGES_COLUMNS = [
  'id', 'from_ticker', 'to_ticker', 'rel_type', 'strength', 'description', 'status',
  'source_chunk_ids', 'evidence_quote', 'created_at', 'updated_at',
] as const
export const GRAPH_PROPOSALS_COLUMNS = [
  'id', 'status', 'claude_reasoning', 'chunk_ids_used', 'created_at', 'resolved_at',
] as const
export const PROPOSAL_EDGES_COLUMNS = [
  'id', 'proposal_id', 'from_ticker', 'to_ticker', 'rel_type', 'strength',
  'description', 'evidence_quote', 'approved',
] as const

interface NodeRow { ticker: string; company: string; themes: string }
interface EdgeRow {
  id: string; from_ticker: string; to_ticker: string; rel_type: string
  strength: string; description: string; status: string; source_chunk_ids: string
  evidence_quote: string | null; created_at: string; updated_at: string
}
interface GProposalRow {
  id: string; status: string; claude_reasoning: string; chunk_ids_used: string
  created_at: string; resolved_at: string | null
}
interface GProposalEdgeRow {
  id: string; proposal_id: string; from_ticker: string; to_ticker: string
  rel_type: string; strength: string; description: string
  evidence_quote: string | null; approved: unknown
}

export async function copyGraph(client: CopyClient, ctx: CopyContext): Promise<TableResult[]> {
  const path = resolveUnderRoot(ctx.sourceRoot, 'apps/dependency-graph-engine/data/graph.db')
  const sqlite = await openSourceSqlite(path)
  try {
    assertSqliteSchema(sqlite, 'nodes', [...NODES_COLUMNS])
    assertSqliteSchema(sqlite, 'edges', [...EDGES_COLUMNS])
    assertSqliteSchema(sqlite, 'proposals', [...GRAPH_PROPOSALS_COLUMNS])
    assertSqliteSchema(sqlite, 'proposal_edges', [...PROPOSAL_EDGES_COLUMNS])

    await client.query(
      'TRUNCATE graph.nodes, graph.edges, graph.proposals, graph.proposal_edges',
    )

    const nodes = sqlite
      .prepare(`SELECT ${NODES_COLUMNS.join(', ')} FROM nodes ORDER BY ticker`)
      .all() as NodeRow[]
    for (const n of nodes) {
      await client.query(
        'INSERT INTO graph.nodes (ticker, company, themes) VALUES ($1,$2,$3)',
        [n.ticker, n.company, n.themes],
      )
    }

    const edges = sqlite
      .prepare(`SELECT ${EDGES_COLUMNS.join(', ')} FROM edges ORDER BY id`)
      .all() as EdgeRow[]
    for (const e of edges) {
      await client.query(
        `INSERT INTO graph.edges
           (id, from_ticker, to_ticker, rel_type, strength, description, status,
            source_chunk_ids, evidence_quote, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          e.id, e.from_ticker, e.to_ticker, e.rel_type, e.strength, e.description,
          e.status, e.source_chunk_ids, e.evidence_quote, e.created_at, e.updated_at,
        ],
      )
    }

    const proposals = sqlite
      .prepare(`SELECT ${GRAPH_PROPOSALS_COLUMNS.join(', ')} FROM proposals ORDER BY id`)
      .all() as GProposalRow[]
    for (const p of proposals) {
      await client.query(
        `INSERT INTO graph.proposals
           (id, status, claude_reasoning, chunk_ids_used, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, p.status, p.claude_reasoning, p.chunk_ids_used, p.created_at, p.resolved_at],
      )
    }

    const pedges = sqlite
      .prepare(`SELECT ${PROPOSAL_EDGES_COLUMNS.join(', ')} FROM proposal_edges ORDER BY id`)
      .all() as GProposalEdgeRow[]
    for (const pe of pedges) {
      const approved = requireNullableBooleanInt('proposal_edges', 'approved', pe.id, pe.approved)
      await client.query(
        `INSERT INTO graph.proposal_edges
           (id, proposal_id, from_ticker, to_ticker, rel_type, strength, description,
            evidence_quote, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          pe.id, pe.proposal_id, pe.from_ticker, pe.to_ticker, pe.rel_type,
          pe.strength, pe.description, pe.evidence_quote, approved,
        ],
      )
    }

    return [
      { table: 'graph.nodes', rows: nodes.length },
      { table: 'graph.edges', rows: edges.length },
      { table: 'graph.proposals', rows: proposals.length },
      { table: 'graph.proposal_edges', rows: pedges.length },
    ]
  } finally {
    sqlite.close()
  }
}
