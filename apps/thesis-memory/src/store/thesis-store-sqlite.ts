// src/store/sqlite.ts
import Database from 'better-sqlite3'
import type {
  Thesis, Assumption, Narrative, Proposal, ProposalChange,
  ThemeMembership, AssumptionStatus, ProposalStatus,
} from '../types.js'
import type { ThesisStore } from './thesis-store-types.js'

export function createSqliteThesisStore(dbPath: string): ThesisStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS theses (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      position_size TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assumptions (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, last_evidence_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narratives (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, content TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL, status TEXT NOT NULL,
      chunk_ids_used TEXT NOT NULL, claude_reasoning TEXT NOT NULL,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS proposal_changes (
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, change_type TEXT NOT NULL,
      assumption_id TEXT, old_value TEXT NOT NULL, new_value TEXT NOT NULL,
      reasoning TEXT NOT NULL, evidence_quotes TEXT NOT NULL, approved INTEGER
    );
    CREATE TABLE IF NOT EXISTS theme_memberships (
      theme_id TEXT NOT NULL, ticker TEXT NOT NULL, weight REAL NOT NULL,
      PRIMARY KEY (theme_id, ticker)
    );
  `)

  function rowToThesis(row: Record<string, unknown>): Thesis {
    return {
      id: row.id as string, ticker: row.ticker as string,
      type: row.type as Thesis['type'], positionSize: row.position_size as Thesis['positionSize'],
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    }
  }

  function rowToAssumption(row: Record<string, unknown>): Assumption {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      label: row.label as string, status: row.status as AssumptionStatus,
      lastEvidenceSummary: row.last_evidence_summary as string | null,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    }
  }

  function rowToNarrative(row: Record<string, unknown>): Narrative {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      content: row.content as string, version: row.version as number,
      createdAt: row.created_at as string,
    }
  }

  function rowToProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string, thesisId: row.thesis_id as string,
      status: row.status as ProposalStatus,
      chunkIdsUsed: JSON.parse(row.chunk_ids_used as string),
      claudeReasoning: row.claude_reasoning as string,
      createdAt: row.created_at as string, resolvedAt: row.resolved_at as string | null,
    }
  }

  function rowToChange(row: Record<string, unknown>): ProposalChange {
    const approved = row.approved
    return {
      id: row.id as string, proposalId: row.proposal_id as string,
      changeType: row.change_type as ProposalChange['changeType'],
      assumptionId: row.assumption_id as string | null,
      oldValue: row.old_value as string, newValue: row.new_value as string,
      reasoning: row.reasoning as string,
      evidenceQuotes: JSON.parse(row.evidence_quotes as string),
      approved: approved === null ? null : Boolean(approved),
    }
  }

  return {
    async createThesis(t): Promise<void> {
      db.prepare(`INSERT INTO theses (id, ticker, type, position_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(t.id, t.ticker, t.type, t.positionSize, t.createdAt, t.updatedAt)
    },
    async getThesis(ticker): Promise<Thesis | null> {
      const row = db.prepare('SELECT * FROM theses WHERE ticker = ?').get(ticker) as Record<string, unknown> | undefined
      return row ? rowToThesis(row) : null
    },
    async listTheses(): Promise<Thesis[]> {
      return (db.prepare('SELECT * FROM theses ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToThesis)
    },
    async updateThesisUpdatedAt(id, updatedAt): Promise<void> {
      db.prepare('UPDATE theses SET updated_at = ? WHERE id = ?').run(updatedAt, id)
    },
    async createAssumption(a): Promise<void> {
      db.prepare(`INSERT INTO assumptions (id, thesis_id, label, status, last_evidence_summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.thesisId, a.label, a.status, a.lastEvidenceSummary, a.createdAt, a.updatedAt)
    },
    async getAssumptions(thesisId): Promise<Assumption[]> {
      return (db.prepare('SELECT * FROM assumptions WHERE thesis_id = ? ORDER BY created_at').all(thesisId) as Record<string, unknown>[]).map(rowToAssumption)
    },
    async updateAssumptionStatus(id, status, evidenceSummary): Promise<void> {
      db.prepare('UPDATE assumptions SET status = ?, last_evidence_summary = ?, updated_at = ? WHERE id = ?')
        .run(status, evidenceSummary, new Date().toISOString(), id)
    },
    async createNarrative(n): Promise<void> {
      db.prepare('INSERT INTO narratives (id, thesis_id, content, version, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(n.id, n.thesisId, n.content, n.version, n.createdAt)
    },
    async getCurrentNarrative(thesisId): Promise<Narrative | null> {
      const row = db.prepare('SELECT * FROM narratives WHERE thesis_id = ? ORDER BY version DESC LIMIT 1').get(thesisId) as Record<string, unknown> | undefined
      return row ? rowToNarrative(row) : null
    },
    async getNarrativeHistory(thesisId): Promise<Narrative[]> {
      return (db.prepare('SELECT * FROM narratives WHERE thesis_id = ? ORDER BY version').all(thesisId) as Record<string, unknown>[]).map(rowToNarrative)
    },
    async createProposal(p): Promise<void> {
      db.prepare(`INSERT INTO proposals (id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.thesisId, p.status, JSON.stringify(p.chunkIdsUsed), p.claudeReasoning, p.createdAt, p.resolvedAt)
    },
    async getPendingProposals(): Promise<Proposal[]> {
      return (db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at").all() as Record<string, unknown>[]).map(rowToProposal)
    },
    async getProposal(id): Promise<Proposal | null> {
      const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return row ? rowToProposal(row) : null
    },
    async updateProposalStatus(id, status): Promise<void> {
      db.prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), id)
    },
    async createProposalChange(c): Promise<void> {
      db.prepare(`INSERT INTO proposal_changes (id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.proposalId, c.changeType, c.assumptionId, c.oldValue, c.newValue, c.reasoning, JSON.stringify(c.evidenceQuotes), c.approved === null ? null : (c.approved ? 1 : 0))
    },
    async getProposalChanges(proposalId): Promise<ProposalChange[]> {
      return (db.prepare('SELECT * FROM proposal_changes WHERE proposal_id = ? ORDER BY id').all(proposalId) as Record<string, unknown>[]).map(rowToChange)
    },
    async approveProposalChange(id, approved): Promise<void> {
      db.prepare('UPDATE proposal_changes SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id)
    },
    async addThemeMembership(m): Promise<void> {
      db.prepare('INSERT OR REPLACE INTO theme_memberships (theme_id, ticker, weight) VALUES (?, ?, ?)').run(m.themeId, m.ticker, m.weight)
    },
    async getThemeMembers(themeId): Promise<ThemeMembership[]> {
      return (db.prepare('SELECT * FROM theme_memberships WHERE theme_id = ?').all(themeId) as Record<string, unknown>[])
        .map(row => ({ themeId: row.theme_id as string, ticker: row.ticker as string, weight: row.weight as number }))
    },
    async close(): Promise<void> { db.close() },
  }
}
