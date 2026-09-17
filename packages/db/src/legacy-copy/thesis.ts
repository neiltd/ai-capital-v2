// THESIS adapter: apps/thesis-memory/data/thesis.db
//   theses             -> thesis.theses          (parent)
//   assumptions        -> thesis.assumptions
//   narratives         -> thesis.narratives
//   proposals          -> thesis.proposals
//   proposal_changes   -> thesis.proposal_changes
//   theme_memberships  -> thesis.theme_memberships  (cold-preserved)
//
// This adapter owns no transaction and no pool.

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import {
  assertSqliteSchema,
  openSourceSqlite,
  requireNullableBooleanInt,
  resolveUnderRoot,
} from '../legacy-copy.js'

export const THESES_COLUMNS = ['id', 'ticker', 'type', 'position_size', 'created_at', 'updated_at'] as const
export const ASSUMPTIONS_COLUMNS = [
  'id', 'thesis_id', 'label', 'status', 'last_evidence_summary', 'created_at', 'updated_at',
] as const
export const NARRATIVES_COLUMNS = ['id', 'thesis_id', 'content', 'version', 'created_at'] as const
export const PROPOSALS_COLUMNS = [
  'id', 'thesis_id', 'status', 'chunk_ids_used', 'claude_reasoning', 'created_at', 'resolved_at',
] as const
export const PROPOSAL_CHANGES_COLUMNS = [
  'id', 'proposal_id', 'change_type', 'assumption_id', 'old_value', 'new_value',
  'reasoning', 'evidence_quotes', 'approved',
] as const
export const THEME_MEMBERSHIPS_COLUMNS = ['theme_id', 'ticker', 'weight'] as const

interface ThesisRow {
  id: string; ticker: string; type: string; position_size: string
  created_at: string; updated_at: string
}
interface AssumptionRow {
  id: string; thesis_id: string; label: string; status: string
  last_evidence_summary: string | null; created_at: string; updated_at: string
}
interface NarrativeRow {
  id: string; thesis_id: string; content: string; version: number; created_at: string
}
interface ProposalRow {
  id: string; thesis_id: string; status: string; chunk_ids_used: string
  claude_reasoning: string; created_at: string; resolved_at: string | null
}
interface ProposalChangeRow {
  id: string; proposal_id: string; change_type: string; assumption_id: string | null
  old_value: string; new_value: string; reasoning: string; evidence_quotes: string
  approved: unknown
}
interface ThemeRow { theme_id: string; ticker: string; weight: number }

export async function copyThesis(client: CopyClient, ctx: CopyContext): Promise<TableResult[]> {
  const path = resolveUnderRoot(ctx.sourceRoot, 'apps/thesis-memory/data/thesis.db')
  const sqlite = await openSourceSqlite(path)
  try {
    assertSqliteSchema(sqlite, 'theses', [...THESES_COLUMNS])
    assertSqliteSchema(sqlite, 'assumptions', [...ASSUMPTIONS_COLUMNS])
    assertSqliteSchema(sqlite, 'narratives', [...NARRATIVES_COLUMNS])
    assertSqliteSchema(sqlite, 'proposals', [...PROPOSALS_COLUMNS])
    assertSqliteSchema(sqlite, 'proposal_changes', [...PROPOSAL_CHANGES_COLUMNS])
    assertSqliteSchema(sqlite, 'theme_memberships', [...THEME_MEMBERSHIPS_COLUMNS])

    // ONE TRUNCATE for the whole FK cluster. Truncating the parent alone would
    // fail against the ON DELETE CASCADE references; listing them together lets
    // PostgreSQL drop the lot atomically.
    await client.query(
      'TRUNCATE thesis.theses, thesis.assumptions, thesis.narratives, ' +
      'thesis.proposals, thesis.proposal_changes, thesis.theme_memberships',
    )

    const theses = sqlite
      .prepare(`SELECT ${THESES_COLUMNS.join(', ')} FROM theses ORDER BY id`)
      .all() as ThesisRow[]
    for (const t of theses) {
      await client.query(
        `INSERT INTO thesis.theses (id, ticker, type, position_size, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.id, t.ticker, t.type, t.position_size, t.created_at, t.updated_at],
      )
    }

    const assumptions = sqlite
      .prepare(`SELECT ${ASSUMPTIONS_COLUMNS.join(', ')} FROM assumptions ORDER BY id`)
      .all() as AssumptionRow[]
    for (const a of assumptions) {
      await client.query(
        `INSERT INTO thesis.assumptions
           (id, thesis_id, label, status, last_evidence_summary, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.thesis_id, a.label, a.status, a.last_evidence_summary, a.created_at, a.updated_at],
      )
    }

    const narratives = sqlite
      .prepare(`SELECT ${NARRATIVES_COLUMNS.join(', ')} FROM narratives ORDER BY id`)
      .all() as NarrativeRow[]
    for (const n of narratives) {
      await client.query(
        `INSERT INTO thesis.narratives (id, thesis_id, content, version, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [n.id, n.thesis_id, n.content, n.version, n.created_at],
      )
    }

    const proposals = sqlite
      .prepare(`SELECT ${PROPOSALS_COLUMNS.join(', ')} FROM proposals ORDER BY id`)
      .all() as ProposalRow[]
    for (const p of proposals) {
      await client.query(
        `INSERT INTO thesis.proposals
           (id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.thesis_id, p.status, p.chunk_ids_used, p.claude_reasoning, p.created_at, p.resolved_at],
      )
    }

    const changes = sqlite
      .prepare(`SELECT ${PROPOSAL_CHANGES_COLUMNS.join(', ')} FROM proposal_changes ORDER BY id`)
      .all() as ProposalChangeRow[]
    for (const c of changes) {
      // The target column is nullable BOOLEAN, so NULL is legitimate here - but
      // 2 or "yes" is not, and `!!c.approved` accepted both.
      const approved = requireNullableBooleanInt('proposal_changes', 'approved', c.id, c.approved)
      await client.query(
        `INSERT INTO thesis.proposal_changes
           (id, proposal_id, change_type, assumption_id, old_value, new_value,
            reasoning, evidence_quotes, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          c.id, c.proposal_id, c.change_type, c.assumption_id,
          c.old_value, c.new_value, c.reasoning, c.evidence_quotes, approved,
        ],
      )
    }

    const memberships = sqlite
      .prepare(
        `SELECT ${THEME_MEMBERSHIPS_COLUMNS.join(', ')} FROM theme_memberships ORDER BY theme_id, ticker`,
      )
      .all() as ThemeRow[]
    for (const m of memberships) {
      await client.query(
        'INSERT INTO thesis.theme_memberships (theme_id, ticker, weight) VALUES ($1,$2,$3)',
        [m.theme_id, m.ticker, m.weight],
      )
    }

    return [
      { table: 'thesis.theses', rows: theses.length },
      { table: 'thesis.assumptions', rows: assumptions.length },
      { table: 'thesis.narratives', rows: narratives.length },
      { table: 'thesis.proposals', rows: proposals.length },
      { table: 'thesis.proposal_changes', rows: changes.length },
      { table: 'thesis.theme_memberships', rows: memberships.length },
    ]
  } finally {
    sqlite.close()
  }
}
