// src/store/lancedb-store.ts
// Original LanceDB-backed implementation; renamed from lancedb.ts.
// The exported factory is now `createLanceStore` (still kept here) and
// the polymorphic outer factory lives in lancedb.ts.

import * as lancedb from '@lancedb/lancedb'
import type { Table, Connection } from '@lancedb/lancedb'
import type { Chunk, FilterOptions } from './types.js'
import type { LanceStore } from './types.js'

const TABLE_NAME = 'chunks'

/** Escape single quotes in string values for SQL filter expressions */
function escapeStr(value: string): string {
  return value.replace(/'/g, "''")
}

/** Convert a Chunk into the flat record stored in LanceDB */
function chunkToRecord(chunk: Chunk): Record<string, unknown> {
  return {
    id: chunk.id,
    ticker: chunk.ticker,
    company: chunk.company,
    source: chunk.source,
    docType: chunk.docType,
    section: chunk.section,
    publishedDate: chunk.publishedDate,
    fiscalPeriod: chunk.fiscalPeriod ?? '',
    url: chunk.url,
    chunkIndex: chunk.chunkIndex,
    parentDocId: chunk.parentDocId,
    contentHash: chunk.contentHash,
    embeddingModel: chunk.embeddingModel,
    content: chunk.content,
    vector: chunk.embedding,
  }
}

/** Convert a LanceDB record back to a Chunk */
function recordToChunk(row: Record<string, unknown>): Chunk {
  return {
    id: row['id'] as string,
    ticker: row['ticker'] as string,
    company: row['company'] as string,
    source: row['source'] as Chunk['source'],
    docType: row['docType'] as Chunk['docType'],
    section: row['section'] as string,
    publishedDate: row['publishedDate'] as string,
    fiscalPeriod: (row['fiscalPeriod'] as string) || null,
    url: row['url'] as string,
    chunkIndex: row['chunkIndex'] as number,
    parentDocId: row['parentDocId'] as string,
    contentHash: row['contentHash'] as string,
    embeddingModel: row['embeddingModel'] as string,
    content: row['content'] as string,
    embedding: Array.from(row['vector'] as Iterable<number>),
  }
}

/** Build an SQL WHERE clause from FilterOptions */
function buildFilter(filters: FilterOptions): string | null {
  const conditions: string[] = []

  if (filters.ticker) {
    if (Array.isArray(filters.ticker)) {
      const tickers = filters.ticker.map(t => `'${escapeStr(t)}'`).join(', ')
      conditions.push(`ticker IN (${tickers})`)
    } else {
      conditions.push(`ticker = '${escapeStr(filters.ticker)}'`)
    }
  }

  if (filters.source) {
    conditions.push(`source = '${escapeStr(filters.source)}'`)
  }

  if (filters.docType) {
    conditions.push(`docType = '${escapeStr(filters.docType)}'`)
  }

  if (filters.section) {
    conditions.push(`section = '${escapeStr(filters.section)}'`)
  }

  if (filters.dateFrom) {
    conditions.push(`publishedDate >= '${escapeStr(filters.dateFrom)}'`)
  }

  if (filters.dateTo) {
    conditions.push(`publishedDate <= '${escapeStr(filters.dateTo)}'`)
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null
}

export async function createLanceStore(dbPath: string): Promise<LanceStore> {
  const db: Connection = await lancedb.connect(dbPath)
  // table is lazily initialized on first write
  let table: Table | null = null

  async function getTable(): Promise<Table | null> {
    if (table) return table
    const names = await db.tableNames()
    if (names.includes(TABLE_NAME)) {
      table = await db.openTable(TABLE_NAME)
    }
    return table
  }

  async function chunkExists(contentHash: string): Promise<boolean> {
    const tbl = await getTable()
    if (!tbl) return false
    const count = await tbl.countRows(`contentHash = '${escapeStr(contentHash)}'`)
    return count > 0
  }

  return {
    async insertChunks(chunks: Chunk[]): Promise<void> {
      if (chunks.length === 0) return

      // Filter out chunks that already exist (dedup by contentHash)
      const newChunks: Chunk[] = []
      for (const chunk of chunks) {
        const exists = await chunkExists(chunk.contentHash)
        if (!exists) {
          newChunks.push(chunk)
        }
      }

      if (newChunks.length === 0) return

      const records = newChunks.map(chunkToRecord)

      if (!table) {
        const names = await db.tableNames()
        if (names.includes(TABLE_NAME)) {
          table = await db.openTable(TABLE_NAME)
          await table.add(records)
        } else {
          // createTable with first record initializes the table
          table = await db.createTable(TABLE_NAME, records)
        }
      } else {
        await table.add(records)
      }
    },

    chunkExists,

    async filterByTicker(ticker: string): Promise<Chunk[]> {
      const tbl = await getTable()
      if (!tbl) return []
      const rows = await tbl
        .query()
        .where(`ticker = '${escapeStr(ticker)}'`)
        .toArray()
      return rows.map(r => recordToChunk(r as Record<string, unknown>))
    },

    async search(queryVector: number[], filters: FilterOptions, topK: number): Promise<Chunk[]> {
      const tbl = await getTable()
      if (!tbl) return []

      const filterStr = buildFilter(filters)

      let q = tbl.vectorSearch(queryVector).limit(topK)
      if (filterStr) {
        q = q.where(filterStr)
      }

      const rows = await q.toArray()
      return rows.map(r => recordToChunk(r as Record<string, unknown>))
    },

    close(): void {
      // LanceDB connections are GC'd automatically; no explicit close needed
      // but we can null out references
      table = null
      db.close()
    },
  }
}
