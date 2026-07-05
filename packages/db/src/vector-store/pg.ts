// Postgres + pgvector backend for the vector chunk store.
// Talks to capital.chunks (packages/db/migrations/006_vectors.sql).
//
// Cosine-distance HNSW index lives on the column already — pgvector handles
// nearest-neighbour search via `embedding <=> $1::vector` and the planner
// uses the HNSW index automatically when ORDER BY <=> is present.

import { getPool } from '../pool.js'
import type { Chunk, FilterOptions } from './types.js'
import type { LanceStore } from './types.js'

/** Strip NUL bytes — PG TEXT rejects them, same as in the bulk migration. */
function sanitizeText(v: string): string {
  return v.replace(/ /g, '')
}

/** Convert a Chunk row to the pgvector text format `[v1,v2,...,vN]`. */
function vectorToPg(v: number[]): string {
  return '[' + v.join(',') + ']'
}

interface PgRow {
  id:               string
  ticker:           string
  company:          string
  source:           string
  doc_type:         string
  section:          string
  published_date:   Date | string | null
  fiscal_period:    string
  url:              string | null
  chunk_index:      number
  parent_doc_id:    string
  content_hash:     string
  embedding_model:  string
  content:          string
  embedding:        string  // pgvector returns text by default
}

function rowToChunk(r: PgRow): Chunk {
  return {
    id:               r.id,
    ticker:           r.ticker,
    company:          r.company,
    source:           r.source as Chunk['source'],
    docType:          r.doc_type as Chunk['docType'],
    section:          r.section,
    publishedDate:    typeof r.published_date === 'string'
                        ? r.published_date
                        : r.published_date?.toISOString().slice(0, 10) ?? '',
    fiscalPeriod:     r.fiscal_period || null,
    url:              r.url ?? '',
    chunkIndex:       r.chunk_index,
    parentDocId:      r.parent_doc_id,
    contentHash:      r.content_hash,
    embeddingModel:   r.embedding_model,
    content:          r.content,
    // Decode pgvector text format "[v1,v2,...,vN]" → number[]
    embedding:        r.embedding
      ? JSON.parse(r.embedding) as number[]
      : [],
  }
}

const SELECT_COLS = `
  id, ticker, company, source, doc_type, section, published_date,
  fiscal_period, url, chunk_index, parent_doc_id, content_hash,
  embedding_model, content, embedding::text AS embedding
`

function buildWhere(filters: FilterOptions): { sql: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  let i = 1

  if (filters.ticker) {
    if (Array.isArray(filters.ticker)) {
      const placeholders = filters.ticker.map(() => `$${i++}`).join(',')
      conds.push(`ticker IN (${placeholders})`)
      params.push(...filters.ticker)
    } else {
      conds.push(`ticker = $${i++}`)
      params.push(filters.ticker)
    }
  }
  if (filters.source)   { conds.push(`source   = $${i++}`); params.push(filters.source) }
  if (filters.docType)  { conds.push(`doc_type = $${i++}`); params.push(filters.docType) }
  if (filters.section)  { conds.push(`section  = $${i++}`); params.push(filters.section) }
  if (filters.dateFrom) { conds.push(`published_date >= $${i++}::date`); params.push(filters.dateFrom) }
  if (filters.dateTo)   { conds.push(`published_date <= $${i++}::date`); params.push(filters.dateTo) }

  return { sql: conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '', params }
}

export function createPgVectorStore(): LanceStore {
  const pool = getPool()

  return {
    async insertChunks(chunks: Chunk[]): Promise<void> {
      if (chunks.length === 0) return

      // Dedup by contentHash up front — single ANY() query is cheaper than
      // per-row chunkExists calls (which is what the LanceDB impl did).
      const hashes = chunks.map(c => c.contentHash)
      const { rows: existing } = await pool.query<{ content_hash: string }>(
        'SELECT content_hash FROM capital.chunks WHERE content_hash = ANY($1::text[])',
        [hashes],
      )
      const existingHashes = new Set(existing.map(r => r.content_hash))
      const newChunks = chunks.filter(c => !existingHashes.has(c.contentHash))
      if (newChunks.length === 0) return

      // Bulk insert in pages of 500 rows × 15 cols = 7500 params (< 65535 cap).
      const BATCH = 500
      for (let off = 0; off < newChunks.length; off += BATCH) {
        const slice = newChunks.slice(off, off + BATCH)
        const params: unknown[] = []
        const placeholders: string[] = []
        let i = 1
        for (const c of slice) {
          placeholders.push(
            '($' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++)
            + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++)
            + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ', $' + (i++) + ')'
          )
          const pubDate = c.publishedDate?.trim() ? c.publishedDate : null
          params.push(
            c.id,
            c.ticker,
            sanitizeText(c.company ?? ''),
            c.source,
            c.docType,
            sanitizeText(c.section ?? ''),
            pubDate,
            sanitizeText(c.fiscalPeriod ?? ''),
            c.url?.trim() ? c.url : null,
            c.chunkIndex,
            c.parentDocId,
            c.contentHash,
            c.embeddingModel,
            sanitizeText(c.content),
            vectorToPg(c.embedding),
          )
        }
        await pool.query(
          `INSERT INTO capital.chunks
             (id, ticker, company, source, doc_type, section, published_date,
              fiscal_period, url, chunk_index, parent_doc_id, content_hash,
              embedding_model, content, embedding)
           VALUES ${placeholders.join(',')}
           ON CONFLICT (id) DO NOTHING`,
          params,
        )
      }
    },

    async chunkExists(contentHash: string): Promise<boolean> {
      const { rows } = await pool.query(
        'SELECT 1 FROM capital.chunks WHERE content_hash = $1 LIMIT 1',
        [contentHash],
      )
      return rows.length > 0
    },

    async filterByTicker(ticker: string): Promise<Chunk[]> {
      const { rows } = await pool.query<PgRow>(
        `SELECT ${SELECT_COLS} FROM capital.chunks WHERE ticker = $1`,
        [ticker],
      )
      return rows.map(rowToChunk)
    },

    async search(queryVector: number[], filters: FilterOptions, topK: number): Promise<Chunk[]> {
      const where = buildWhere(filters)
      // The query vector is the last parameter; pg places it after the WHERE
      // bind values. Use it both for the ORDER BY (HNSW-served) and a tie-breaking
      // distance computation.
      const vectorParam = `$${where.params.length + 1}::vector`
      const limitParam  = `$${where.params.length + 2}`
      const sql = `
        SELECT ${SELECT_COLS}
          FROM capital.chunks
         ${where.sql}
         ORDER BY embedding <=> ${vectorParam}
         LIMIT ${limitParam}
      `
      const { rows } = await pool.query<PgRow>(sql, [
        ...where.params, vectorToPg(queryVector), topK,
      ])
      return rows.map(rowToChunk)
    },

    close(): void {
      // Shared pool — closed centrally by the caller's main().
    },
  }
}
