import Database from 'better-sqlite3'
import { join } from 'path'
import { createLanceStore, getPool, usePostgres, type LanceStore } from '@common/db'
import type { CompanyHealth, ThesisAssumption, RecentChunk, HealthScore } from '../types.js'

const DEFAULT_THESIS_DB  = join(process.cwd(), '../thesis-memory/data/thesis.db')
const DEFAULT_LANCE_PATH = join(process.cwd(), '../capital-intelligence-ingestion/data/lancedb')

function computeHealthScore(assumptions: ThesisAssumption[]): HealthScore {
  if (assumptions.length === 0) return 'insufficient_data'
  if (assumptions.some(a => a.status === 'broken')) return 'negative'
  if (assumptions.every(a => a.status === 'stable' || a.status === 'strengthening')) return 'positive'
  return 'neutral'
}

interface ThesisReader {
  getThesisByTicker(ticker: string): Promise<{ id: string; narrative: string; assumptions: ThesisAssumption[] } | null>
  close(): void
}

// SQLite-backed thesis reader — kept for the legacy local-file path.
function sqliteThesisReader(dbPath: string): ThesisReader {
  const db = new Database(dbPath, { readonly: true })
  return {
    async getThesisByTicker(ticker) {
      const row = db.prepare("SELECT id FROM theses WHERE ticker = ? AND type = 'company'")
        .get(ticker) as { id: string } | undefined
      if (!row) return null
      const narrative = db.prepare(
        'SELECT content FROM narratives WHERE thesis_id = ? ORDER BY version DESC LIMIT 1'
      ).get(row.id) as { content: string } | undefined
      const assumptions = (db.prepare(
        'SELECT label, status FROM assumptions WHERE thesis_id = ? ORDER BY created_at'
      ).all(row.id) as Array<{ label: string; status: string }>)
        .map(r => ({ text: r.label, status: r.status as ThesisAssumption['status'] }))
      return { id: row.id, narrative: narrative?.content ?? '', assumptions }
    },
    close() { db.close() },
  }
}

// Postgres-backed thesis reader — talks to thesis.* schema.
function pgThesisReader(): ThesisReader {
  const pool = getPool()
  return {
    async getThesisByTicker(ticker) {
      const { rows: theses } = await pool.query<{ id: string }>(
        "SELECT id FROM thesis.theses WHERE ticker = $1 AND type = 'company'",
        [ticker],
      )
      if (theses.length === 0) return null
      const id = theses[0].id

      const { rows: narrativeRows } = await pool.query<{ content: string }>(
        'SELECT content FROM thesis.narratives WHERE thesis_id = $1 ORDER BY version DESC LIMIT 1',
        [id],
      )
      const { rows: assumptionRows } = await pool.query<{ label: string; status: string }>(
        'SELECT label, status FROM thesis.assumptions WHERE thesis_id = $1 ORDER BY created_at',
        [id],
      )
      return {
        id,
        narrative: narrativeRows[0]?.content ?? '',
        assumptions: assumptionRows.map(r => ({ text: r.label, status: r.status as ThesisAssumption['status'] })),
      }
    },
    close() { /* shared pool */ },
  }
}

export async function collectHealth(
  nodes: Array<{ ticker: string; company: string }>,
  options: { thesisDbPath?: string; lanceDbPath?: string } = {},
): Promise<CompanyHealth[]> {
  const thesisDbPath = options.thesisDbPath ?? DEFAULT_THESIS_DB
  const lanceDbPath  = options.lanceDbPath  ?? DEFAULT_LANCE_PATH

  const thesisReader = usePostgres() ? pgThesisReader() : sqliteThesisReader(thesisDbPath)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  let vectorStore: LanceStore | null = null
  try {
    vectorStore = await createLanceStore(lanceDbPath)
  } catch (error) {
    console.warn(`vector store unavailable at ${lanceDbPath}:`, error)
  }

  const results: CompanyHealth[] = []

  try {
    for (const node of nodes) {
      const thesis = await thesisReader.getThesisByTicker(node.ticker)

      if (!thesis) {
        results.push({
          ticker: node.ticker, company: node.company,
          thesisSummary: '', assumptions: [], recentChunks: [],
          healthScore: 'insufficient_data',
        })
        continue
      }

      const recentChunks: RecentChunk[] = []
      if (vectorStore) {
        try {
          // Pull ticker's chunks; date-filter to last 7 days, cap at 10.
          // We don't have a server-side date filter on filterByTicker, but the
          // cap means we mostly read recent rows from PG (clustered on
          // (ticker, published_date DESC) via the partial index in 006_vectors.sql).
          const chunks = await vectorStore.filterByTicker(node.ticker)
          chunks
            .filter(c => { try { return new Date(c.publishedDate) >= sevenDaysAgo } catch { return false } })
            .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate))
            .slice(0, 10)
            .forEach(c => recentChunks.push({
              chunkId:       c.id,
              title:         c.docType,
              source:        c.source,
              publishedDate: c.publishedDate,
              content:       c.content.slice(0, 500),
            }))
        } catch {
          // silently skip per-ticker vector store errors
        }
      }

      results.push({
        ticker:        node.ticker,
        company:       node.company,
        thesisSummary: thesis.narrative,
        assumptions:   thesis.assumptions,
        recentChunks,
        healthScore:   computeHealthScore(thesis.assumptions),
      })
    }
  } finally {
    thesisReader.close()
    if (vectorStore) vectorStore.close()
  }

  return results
}
