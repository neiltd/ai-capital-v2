// Postgres-backed ThesisStore. Talks to thesis.* schema (packages/db/migrations/003_thesis.sql).

import { getPool } from '@common/db'
import type {
  Thesis, ProposalChange,
  AssumptionStatus, ProposalStatus,
} from '../types.js'
import type { ThesisStore } from './thesis-store-types.js'

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === null || v === undefined) return 0
  return Number(v)
}

function asIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export function createPgThesisStore(): ThesisStore {
  const pool = getPool()

  return {
    async createThesis(t) {
      await pool.query(
        `INSERT INTO thesis.theses (id, ticker, type, position_size, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.id, t.ticker, t.type, t.positionSize, t.createdAt, t.updatedAt],
      )
    },

    async getThesis(ticker) {
      const { rows } = await pool.query(
        'SELECT id, ticker, type, position_size, created_at, updated_at FROM thesis.theses WHERE ticker = $1',
        [ticker],
      )
      if (rows.length === 0) return null
      const r = rows[0]
      return {
        id: r.id, ticker: r.ticker,
        type: r.type as Thesis['type'], positionSize: r.position_size as Thesis['positionSize'],
        createdAt: asIso(r.created_at), updatedAt: asIso(r.updated_at),
      }
    },

    async listTheses() {
      const { rows } = await pool.query(
        'SELECT id, ticker, type, position_size, created_at, updated_at FROM thesis.theses ORDER BY created_at',
      )
      return rows.map(r => ({
        id: r.id, ticker: r.ticker,
        type: r.type as Thesis['type'], positionSize: r.position_size as Thesis['positionSize'],
        createdAt: asIso(r.created_at), updatedAt: asIso(r.updated_at),
      }))
    },

    async updateThesisUpdatedAt(id, updatedAt) {
      await pool.query('UPDATE thesis.theses SET updated_at = $1 WHERE id = $2', [updatedAt, id])
    },

    async createAssumption(a) {
      await pool.query(
        `INSERT INTO thesis.assumptions
           (id, thesis_id, label, status, last_evidence_summary, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.thesisId, a.label, a.status, a.lastEvidenceSummary, a.createdAt, a.updatedAt],
      )
    },

    async getAssumptions(thesisId) {
      const { rows } = await pool.query(
        `SELECT id, thesis_id, label, status, last_evidence_summary, created_at, updated_at
           FROM thesis.assumptions WHERE thesis_id = $1 ORDER BY created_at`,
        [thesisId],
      )
      return rows.map(r => ({
        id: r.id, thesisId: r.thesis_id,
        label: r.label, status: r.status as AssumptionStatus,
        lastEvidenceSummary: r.last_evidence_summary,
        createdAt: asIso(r.created_at), updatedAt: asIso(r.updated_at),
      }))
    },

    async updateAssumptionStatus(id, status, evidenceSummary) {
      await pool.query(
        'UPDATE thesis.assumptions SET status = $1, last_evidence_summary = $2, updated_at = $3 WHERE id = $4',
        [status, evidenceSummary, new Date().toISOString(), id],
      )
    },

    async createNarrative(n) {
      await pool.query(
        `INSERT INTO thesis.narratives (id, thesis_id, content, version, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [n.id, n.thesisId, n.content, n.version, n.createdAt],
      )
    },

    async getCurrentNarrative(thesisId) {
      const { rows } = await pool.query(
        'SELECT id, thesis_id, content, version, created_at FROM thesis.narratives WHERE thesis_id = $1 ORDER BY version DESC LIMIT 1',
        [thesisId],
      )
      if (rows.length === 0) return null
      const r = rows[0]
      return {
        id: r.id, thesisId: r.thesis_id,
        content: r.content, version: num(r.version),
        createdAt: asIso(r.created_at),
      }
    },

    async getNarrativeHistory(thesisId) {
      const { rows } = await pool.query(
        'SELECT id, thesis_id, content, version, created_at FROM thesis.narratives WHERE thesis_id = $1 ORDER BY version',
        [thesisId],
      )
      return rows.map(r => ({
        id: r.id, thesisId: r.thesis_id,
        content: r.content, version: num(r.version),
        createdAt: asIso(r.created_at),
      }))
    },

    async createProposal(p) {
      await pool.query(
        `INSERT INTO thesis.proposals
           (id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.thesisId, p.status, JSON.stringify(p.chunkIdsUsed), p.claudeReasoning, p.createdAt, p.resolvedAt],
      )
    },

    async getPendingProposals() {
      const { rows } = await pool.query(
        `SELECT id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at
           FROM thesis.proposals WHERE status = 'pending' ORDER BY created_at`,
      )
      return rows.map(r => ({
        id: r.id, thesisId: r.thesis_id,
        status: r.status as ProposalStatus,
        chunkIdsUsed: JSON.parse(r.chunk_ids_used),
        claudeReasoning: r.claude_reasoning,
        createdAt: asIso(r.created_at),
        resolvedAt: r.resolved_at ? asIso(r.resolved_at) : null,
      }))
    },

    async getProposal(id) {
      const { rows } = await pool.query(
        `SELECT id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at
           FROM thesis.proposals WHERE id = $1`,
        [id],
      )
      if (rows.length === 0) return null
      const r = rows[0]
      return {
        id: r.id, thesisId: r.thesis_id,
        status: r.status as ProposalStatus,
        chunkIdsUsed: JSON.parse(r.chunk_ids_used),
        claudeReasoning: r.claude_reasoning,
        createdAt: asIso(r.created_at),
        resolvedAt: r.resolved_at ? asIso(r.resolved_at) : null,
      }
    },

    async updateProposalStatus(id, status) {
      await pool.query(
        'UPDATE thesis.proposals SET status = $1, resolved_at = $2 WHERE id = $3',
        [status, new Date().toISOString(), id],
      )
    },

    async createProposalChange(c) {
      await pool.query(
        `INSERT INTO thesis.proposal_changes
           (id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          c.id, c.proposalId, c.changeType, c.assumptionId,
          c.oldValue, c.newValue, c.reasoning,
          JSON.stringify(c.evidenceQuotes),
          c.approved === null ? null : c.approved,
        ],
      )
    },

    async getProposalChanges(proposalId) {
      const { rows } = await pool.query(
        `SELECT id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved
           FROM thesis.proposal_changes WHERE proposal_id = $1`,
        [proposalId],
      )
      return rows.map(r => ({
        id: r.id, proposalId: r.proposal_id,
        changeType: r.change_type as ProposalChange['changeType'],
        assumptionId: r.assumption_id,
        oldValue: r.old_value, newValue: r.new_value,
        reasoning: r.reasoning,
        evidenceQuotes: JSON.parse(r.evidence_quotes),
        approved: r.approved === null ? null : Boolean(r.approved),
      }))
    },

    async approveProposalChange(id, approved) {
      await pool.query(
        'UPDATE thesis.proposal_changes SET approved = $1 WHERE id = $2',
        [approved, id],
      )
    },

    async addThemeMembership(m) {
      await pool.query(
        `INSERT INTO thesis.theme_memberships (theme_id, ticker, weight)
         VALUES ($1,$2,$3)
         ON CONFLICT (theme_id, ticker) DO UPDATE SET weight = EXCLUDED.weight`,
        [m.themeId, m.ticker, m.weight],
      )
    },

    async getThemeMembers(themeId) {
      const { rows } = await pool.query(
        'SELECT theme_id, ticker, weight FROM thesis.theme_memberships WHERE theme_id = $1',
        [themeId],
      )
      return rows.map(r => ({ themeId: r.theme_id, ticker: r.ticker, weight: num(r.weight) }))
    },

    async close() {
      // Shared pool — closed centrally by the CLI main(); per-store close is a no-op.
    },
  }
}
