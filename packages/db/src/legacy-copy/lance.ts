// LANCE adapter: apps/capital-intelligence-ingestion/data/lancedb, table `chunks`
//   chunks -> capital.chunks   (vector -> embedding, camelCase -> snake_case)
//
// WHY NOT limit/offset. The tool this replaces paged with
// `table.query().limit(BATCH).offset(offset)`. Offset pagination is only sound
// under a total order, and the LanceDB JavaScript API at the pinned version
// exposes NO orderBy at all - `Query` offers select, where, limit, offset,
// withRowId, fastSearch, nearestTo, toArray, toArrow and explainPlan, and
// nothing else. An unordered offset scan may return a row twice and skip
// another, and nothing in the old tool would have noticed.
//
// SO: FIXED DISJOINT PARTITIONS, EACH READ WHOLE. The id is a canonical
// lowercase UUID, so its first hex digit partitions the key space into sixteen
// disjoint, exhaustive ranges. Each partition is read in full - no limit, no
// offset - and its row count is compared against countRows() for the SAME
// predicate. The partition counts must sum to the table total, taken before and
// again after the scan; the ids must be globally unique; and every id must be a
// canonical UUID, because an id outside that domain would fall into no
// partition and is caught by the same accounting rather than silently dropped.

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import { CopyRefused, resolveUnderRoot } from '../legacy-copy.js'

/** capital.chunks.embedding is vector(384) NOT NULL. */
export const EMBEDDING_DIMENSIONS = 384

/** Refuse rather than read an unbounded partition into memory. */
export const DEFAULT_MAX_PARTITION_ROWS = 50_000

/** Canonical lowercase UUID. Uppercase is refused: two spellings of one id
 *  would partition differently and defeat the accounting below. */
export const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const HEX_DIGITS = '0123456789abcdef'.split('')

export interface LancePartition {
  label: string
  predicate: string
}

/**
 * Sixteen disjoint, exhaustive ranges over the first hex digit. Exhaustive
 * WITHIN the canonical UUID domain - which is the point: an id outside it
 * belongs to no partition, so the totals disagree and the copy refuses.
 */
export function uuidPartitions(): LancePartition[] {
  return HEX_DIGITS.map((d, i) => {
    const next = i + 1 < HEX_DIGITS.length ? HEX_DIGITS[i + 1] : 'g'
    return { label: d, predicate: `id >= '${d}' AND id < '${next}'` }
  })
}

export interface LanceRow {
  id: string
  ticker: string
  company: string
  source: string
  docType: string
  section: string
  publishedDate: string
  fiscalPeriod: string
  url: string
  chunkIndex: number
  parentDocId: string
  contentHash: string
  embeddingModel: string
  content: string
  vector: unknown
}

/** The minimal surface this adapter needs; a test supplies its own. */
export interface LanceTableLike {
  countRows(filter?: string): Promise<number>
  query(): { where(p: string): { toArray(): Promise<unknown[]> } }
}
export interface LanceConnectionLike {
  tableNames(): Promise<string[]>
  openTable(name: string): Promise<LanceTableLike>
}

/**
 * PostgreSQL TEXT rejects NUL (0x00); scraped upstream content contains it.
 * Strip it and nothing else - this is a sanitiser, not a normaliser, and it
 * does not touch line endings, whatever the old tool's comment claimed.
 *
 * The escape is spelled \\u0000 DELIBERATELY. The tool this replaces carried a
 * LITERAL NUL byte inside its regular expression, which renders as nothing in a
 * terminal, a diff or a review - so the one character the expression exists to
 * match was the one character a reader could not see.
 */
export function sanitizeText(v: string): string {
  return v.replace(/\u0000/g, '')
}

export function emptyToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const stripped = sanitizeText(v)
  return stripped.trim() === '' ? null : stripped
}

/**
 * The vector, validated BEFORE any SQL is built. The old tool serialised
 * whatever length it was given and let the server reject it mid-transaction,
 * which reports a type error rather than "this source row is wrong".
 */
export function vectorToPg(id: string, v: unknown): string {
  const arr = toNumberArray(v)
  if (arr.length !== EMBEDDING_DIMENSIONS) {
    throw new CopyRefused(
      `chunk ${id} carries a ${arr.length}-dimension vector; capital.chunks.embedding ` +
      `is vector(${EMBEDDING_DIMENSIONS}).`,
    )
  }
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new CopyRefused(`chunk ${id} vector element ${i} is not finite.`)
    }
  }
  return '[' + arr.join(',') + ']'
}

function toNumberArray(v: unknown): number[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.map(Number)
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, Number)
  const indexed = v as { length?: number; get?: (i: number) => number; toArray?: () => number[] }
  if (typeof indexed.toArray === 'function') return indexed.toArray().map(Number)
  if (typeof indexed.length === 'number' && typeof indexed.get === 'function') {
    const out = new Array<number>(indexed.length)
    for (let i = 0; i < indexed.length; i++) out[i] = Number(indexed.get(i))
    return out
  }
  throw new CopyRefused('a chunk vector is not an array-like of numbers.')
}

export interface LanceScanResult {
  rows: LanceRow[]
  totalBefore: number
  totalAfter: number
  perPartition: { label: string; declared: number; read: number }[]
}

/**
 * The whole traversal, separated from the SQL so it can be proved on its own.
 */
export async function scanLanceChunks(
  table: LanceTableLike,
  maxPartitionRows: number = DEFAULT_MAX_PARTITION_ROWS,
): Promise<LanceScanResult> {
  const totalBefore = await table.countRows()
  const seen = new Set<string>()
  const rows: LanceRow[] = []
  const perPartition: { label: string; declared: number; read: number }[] = []

  for (const part of uuidPartitions()) {
    const declared = await table.countRows(part.predicate)
    if (declared > maxPartitionRows) {
      throw new CopyRefused(
        `partition ${part.label} holds ${declared} rows, above the configured maximum ` +
        `of ${maxPartitionRows}. The partition is read whole by design; raise the ` +
        'maximum deliberately or split the key space further.',
      )
    }
    const read = (await table.query().where(part.predicate).toArray()) as LanceRow[]
    if (read.length !== declared) {
      throw new CopyRefused(
        `partition ${part.label} declared ${declared} rows but returned ${read.length}. ` +
        'A partial read is not a partial copy: the scan is refused.',
      )
    }
    for (const r of read) {
      if (typeof r.id !== 'string' || !CANONICAL_UUID_RE.test(r.id)) {
        throw new CopyRefused(
          `chunk id ${JSON.stringify(r.id)} is not a canonical lowercase UUID. Source ` +
          'identity must be canonical, or the partition accounting cannot be trusted.',
        )
      }
      if (seen.has(r.id)) {
        throw new CopyRefused(`chunk id ${r.id} appears more than once in the source.`)
      }
      seen.add(r.id)
      rows.push(r)
    }
    perPartition.push({ label: part.label, declared, read: read.length })
  }

  const summed = perPartition.reduce((n, p) => n + p.read, 0)
  if (summed !== totalBefore) {
    throw new CopyRefused(
      `the sixteen UUID partitions account for ${summed} of ${totalBefore} rows. Rows ` +
      'outside the canonical UUID domain belong to no partition; this is a source ' +
      'identity failure, not a partitioning one.',
    )
  }
  const totalAfter = await table.countRows()
  if (totalAfter !== totalBefore) {
    throw new CopyRefused(
      `the source table changed during the scan (${totalBefore} -> ${totalAfter} rows).`,
    )
  }
  if (seen.size !== totalBefore) {
    throw new CopyRefused(
      `${seen.size} distinct ids for ${totalBefore} rows; the source is not uniquely keyed.`,
    )
  }

  // Sorted by id so the insertion order - and therefore the target - does not
  // depend on the order partitions happened to return.
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { rows, totalBefore, totalAfter, perPartition }
}

/** Injectable for the database-free tests; production uses @lancedb/lancedb. */
export type LanceConnect = (path: string) => Promise<LanceConnectionLike>

export async function copyLance(
  client: CopyClient,
  ctx: CopyContext,
  connectFn?: LanceConnect,
): Promise<TableResult[]> {
  const path = resolveUnderRoot(
    ctx.sourceRoot, 'apps/capital-intelligence-ingestion/data/lancedb',
  )
  const connect = connectFn ?? (async (p: string) => {
    const mod = await import('@lancedb/lancedb')
    return (await mod.connect(p)) as unknown as LanceConnectionLike
  })

  const db = await connect(path)
  const names = await db.tableNames()
  if (!names.includes('chunks')) {
    throw new CopyRefused(`the LanceDB snapshot at ${path} has no "chunks" table.`)
  }
  const table = await db.openTable('chunks')
  const scan = await scanLanceChunks(table)

  await client.query('TRUNCATE capital.chunks')
  for (const r of scan.rows) {
    await client.query(
      `INSERT INTO capital.chunks
         (id, ticker, company, source, doc_type, section, published_date,
          fiscal_period, url, chunk_index, parent_doc_id, content_hash,
          embedding_model, content, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        r.id,
        r.ticker,
        sanitizeText(r.company),
        r.source,
        r.docType,
        sanitizeText(r.section ?? ''),
        emptyToNull(r.publishedDate),
        sanitizeText(r.fiscalPeriod ?? ''),
        emptyToNull(r.url),
        r.chunkIndex,
        r.parentDocId,
        r.contentHash,
        r.embeddingModel,
        sanitizeText(r.content),
        vectorToPg(r.id, r.vector),
      ],
    )
  }

  return [{ table: 'capital.chunks', rows: scan.rows.length }]
}
