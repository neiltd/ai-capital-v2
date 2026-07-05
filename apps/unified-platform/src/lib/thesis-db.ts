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
