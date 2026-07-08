import Database from 'better-sqlite3'
import path from 'path'

function dataRoot(): string {
  const root = process.env.DATA_ROOT
  if (!root) throw new Error('DATA_ROOT env var is not set')
  return root
}

export interface ThesisRow {
  id: string
  ticker: string
  type: 'company' | 'theme'
  positionSize: 'core' | 'satellite' | 'watchlist' | 'none'
  updatedAt: string
}

export interface AssumptionRow {
  id: string
  thesisId: string
  label: string
  status: 'strengthening' | 'stable' | 'weakening' | 'broken'
  lastEvidenceSummary: string | null
  updatedAt: string
}

interface ThesisRaw {
  id: string
  ticker: string
  type: string
  position_size: string
  updated_at: string
}

interface AssumptionRaw {
  id: string
  thesis_id: string
  label: string
  status: string
  last_evidence_summary: string | null
  updated_at: string
}

export interface ProposalRow {
  id: string
  thesisId: string
  status: 'pending' | 'approved' | 'rejected'
  claudeReasoning: string
  createdAt: string
  resolvedAt: string | null
}

export interface ProposalChangeRow {
  id: string
  proposalId: string
  changeType: 'assumption_status' | 'narrative' | 'portfolio_action'
  assumptionId: string | null
  oldValue: string
  newValue: string
  reasoning: string
  evidenceQuotes: string[]
  approved: boolean | null
}

interface ProposalRaw {
  id: string
  thesis_id: string
  status: string
  claude_reasoning: string
  created_at: string
  resolved_at: string | null
}

interface ProposalChangeRaw {
  id: string
  proposal_id: string
  change_type: string
  assumption_id: string | null
  old_value: string
  new_value: string
  reasoning: string
  evidence_quotes: string
  approved: number | null
}

export function readTheses(): { theses: ThesisRow[]; assumptions: AssumptionRow[] } {
  const dbPath = path.join(dataRoot(), 'thesis-memory/data/thesis.db')
  const db = new Database(dbPath, { readonly: true })
  try {
    const rawTheses = db
      .prepare('SELECT id, ticker, type, position_size, updated_at FROM theses ORDER BY updated_at DESC')
      .all() as ThesisRaw[]

    const rawAssumptions = db
      .prepare(
        'SELECT id, thesis_id, label, status, last_evidence_summary, updated_at FROM assumptions ORDER BY updated_at DESC'
      )
      .all() as AssumptionRaw[]

    const theses: ThesisRow[] = rawTheses.map(r => ({
      id: r.id,
      ticker: r.ticker,
      type: r.type as ThesisRow['type'],
      positionSize: r.position_size as ThesisRow['positionSize'],
      updatedAt: r.updated_at,
    }))

    const assumptions: AssumptionRow[] = rawAssumptions.map(r => ({
      id: r.id,
      thesisId: r.thesis_id,
      label: r.label,
      status: r.status as AssumptionRow['status'],
      lastEvidenceSummary: r.last_evidence_summary,
      updatedAt: r.updated_at,
    }))

    return { theses, assumptions }
  } finally {
    db.close()
  }
}

export function readProposals(): { proposals: ProposalRow[]; changes: ProposalChangeRow[] } {
  const dbPath = path.join(dataRoot(), 'thesis-memory/data/thesis.db')
  const db = new Database(dbPath, { readonly: true })
  try {
    const rawProposals = db
      .prepare('SELECT id, thesis_id, status, claude_reasoning, created_at, resolved_at FROM proposals ORDER BY created_at DESC')
      .all() as ProposalRaw[]

    const rawChanges = db
      .prepare('SELECT id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved FROM proposal_changes')
      .all() as ProposalChangeRaw[]

    const proposals: ProposalRow[] = rawProposals.map(r => ({
      id: r.id,
      thesisId: r.thesis_id,
      status: r.status as ProposalRow['status'],
      claudeReasoning: r.claude_reasoning,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }))

    const changes: ProposalChangeRow[] = rawChanges.map(r => ({
      id: r.id,
      proposalId: r.proposal_id,
      changeType: r.change_type as ProposalChangeRow['changeType'],
      assumptionId: r.assumption_id,
      oldValue: r.old_value,
      newValue: r.new_value,
      reasoning: r.reasoning,
      evidenceQuotes: JSON.parse(r.evidence_quotes) as string[],
      approved: r.approved === null ? null : r.approved === 1,
    }))

    return { proposals, changes }
  } finally {
    db.close()
  }
}

/**
 * Accept or reject a pending proposal. On accept, applies each
 * assumption_status change to the live assumptions table (not just a flag
 * flip) — accepting a proposal means the thesis actually changes.
 * Transactional: either every row updates or none do.
 */
export function resolveProposal(id: string, decision: 'accept' | 'reject'): { ok: true } | { ok: false; error: string } {
  const dbPath = path.join(dataRoot(), 'thesis-memory/data/thesis.db')
  const db = new Database(dbPath)
  try {
    const now = new Date().toISOString()
    const newStatus = decision === 'accept' ? 'approved' : 'rejected'

    const run = db.transaction(() => {
      const proposal = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string } | undefined
      if (!proposal) throw new Error('Proposal not found')
      if (proposal.status !== 'pending') throw new Error(`Proposal is already ${proposal.status}, not pending`)

      db.prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?').run(newStatus, now, id)

      const changes = db
        .prepare('SELECT id, change_type, assumption_id, new_value, reasoning FROM proposal_changes WHERE proposal_id = ?')
        .all(id) as Array<{ id: string; change_type: string; assumption_id: string | null; new_value: string; reasoning: string }>

      for (const c of changes) {
        db.prepare('UPDATE proposal_changes SET approved = ? WHERE id = ?').run(decision === 'accept' ? 1 : 0, c.id)
        if (decision === 'accept' && c.change_type === 'assumption_status' && c.assumption_id) {
          db.prepare('UPDATE assumptions SET status = ?, last_evidence_summary = ?, updated_at = ? WHERE id = ?')
            .run(c.new_value, c.reasoning, now, c.assumption_id)
        }
      }
    })

    run()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    db.close()
  }
}
