// CAPITAL adapter: apps/capital-intelligence-ingestion/data/sqlite.db
//   watchlist             -> capital.watchlist
//   documents             -> capital.documents
//   fetch_log             -> capital.fetch_log            (RESTART IDENTITY)
//   short_interest        -> capital.short_interest
//   api_budget            -> capital.api_budget           (cold-preserved)
//   pending_manual_input  -> capital.pending_manual_input
//
// This adapter owns no transaction and no pool.

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import {
  assertSqliteSchema,
  openSourceSqlite,
  requireBooleanInt,
  resolveUnderRoot,
} from '../legacy-copy.js'

export const WATCHLIST_COLUMNS = [
  'ticker', 'company', 'cik', 'themes', 'news_only', 'ir_feed_url', 'ir_feed_status',
  'active', 'added_at', 'news_search_terms', 'thesis_update_days',
] as const
export const DOCUMENTS_COLUMNS = ['doc_hash', 'ticker', 'fetched_at'] as const
export const FETCH_LOG_COLUMNS = ['id', 'ticker', 'source', 'fetched_at', 'doc_count', 'chunk_count'] as const
export const SHORT_INTEREST_COLUMNS = [
  'date', 'ticker', 'short_volume', 'short_exempt_volume', 'total_volume', 'short_pct',
] as const
export const API_BUDGET_COLUMNS = ['source', 'date', 'requests_used'] as const
export const PENDING_COLUMNS = [
  'id', 'ticker', 'source', 'reason', 'suggested_action', 'created_at', 'resolved_at',
] as const

interface WatchlistRow {
  ticker: string; company: string; cik: string | null; themes: string
  news_only: unknown; ir_feed_url: string | null; ir_feed_status: string
  active: unknown; added_at: string; news_search_terms: string; thesis_update_days: number
}
interface DocRow { doc_hash: string; ticker: string; fetched_at: string }
interface FetchRow {
  id: number; ticker: string; source: string; fetched_at: string
  doc_count: number; chunk_count: number
}
interface ShortRow {
  date: string; ticker: string; short_volume: number; short_exempt_volume: number
  total_volume: number; short_pct: number
}
interface BudgetRow { source: string; date: string; requests_used: number }
interface PendingRow {
  id: string; ticker: string; source: string; reason: string
  suggested_action: string; created_at: string; resolved_at: string | null
}

export async function copyCapital(client: CopyClient, ctx: CopyContext): Promise<TableResult[]> {
  const path = resolveUnderRoot(ctx.sourceRoot, 'apps/capital-intelligence-ingestion/data/sqlite.db')
  const sqlite = await openSourceSqlite(path)
  try {
    assertSqliteSchema(sqlite, 'watchlist', [...WATCHLIST_COLUMNS])
    assertSqliteSchema(sqlite, 'documents', [...DOCUMENTS_COLUMNS])
    assertSqliteSchema(sqlite, 'fetch_log', [...FETCH_LOG_COLUMNS])
    assertSqliteSchema(sqlite, 'short_interest', [...SHORT_INTEREST_COLUMNS])
    assertSqliteSchema(sqlite, 'api_budget', [...API_BUDGET_COLUMNS])
    assertSqliteSchema(sqlite, 'pending_manual_input', [...PENDING_COLUMNS])

    // -- watchlist ----------------------------------------------------------
    await client.query('TRUNCATE capital.watchlist')
    const watchlist = sqlite
      .prepare(`SELECT ${WATCHLIST_COLUMNS.join(', ')} FROM watchlist ORDER BY ticker`)
      .all() as WatchlistRow[]
    for (const w of watchlist) {
      // Both target columns are BOOLEAN NOT NULL. `!!w.news_only` turned 2 and
      // "false" into TRUE and NULL into FALSE; each value is now checked.
      const newsOnly = requireBooleanInt('watchlist', 'news_only', w.ticker, w.news_only)
      const active = requireBooleanInt('watchlist', 'active', w.ticker, w.active)
      await client.query(
        `INSERT INTO capital.watchlist
           (ticker, company, cik, themes, news_only, ir_feed_url, ir_feed_status,
            active, added_at, news_search_terms, thesis_update_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          w.ticker, w.company, w.cik, w.themes, newsOnly, w.ir_feed_url, w.ir_feed_status,
          active, w.added_at, w.news_search_terms, w.thesis_update_days,
        ],
      )
    }

    // -- documents ----------------------------------------------------------
    await client.query('TRUNCATE capital.documents')
    const docs = sqlite
      .prepare(`SELECT ${DOCUMENTS_COLUMNS.join(', ')} FROM documents ORDER BY doc_hash`)
      .all() as DocRow[]
    for (const d of docs) {
      await client.query(
        'INSERT INTO capital.documents (doc_hash, ticker, fetched_at) VALUES ($1,$2,$3)',
        [d.doc_hash, d.ticker, d.fetched_at],
      )
    }

    // -- fetch_log ----------------------------------------------------------
    await client.query('TRUNCATE capital.fetch_log RESTART IDENTITY')
    const fetches = sqlite
      .prepare(`SELECT ${FETCH_LOG_COLUMNS.join(', ')} FROM fetch_log ORDER BY id`)
      .all() as FetchRow[]
    for (const f of fetches) {
      await client.query(
        `INSERT INTO capital.fetch_log (ticker, source, fetched_at, doc_count, chunk_count)
         VALUES ($1,$2,$3,$4,$5)`,
        [f.ticker, f.source, f.fetched_at, f.doc_count, f.chunk_count],
      )
    }

    // -- short_interest -----------------------------------------------------
    await client.query('TRUNCATE capital.short_interest')
    const shorts = sqlite
      .prepare(
        `SELECT ${SHORT_INTEREST_COLUMNS.join(', ')} FROM short_interest ORDER BY date, ticker`,
      )
      .all() as ShortRow[]
    for (const s of shorts) {
      await client.query(
        `INSERT INTO capital.short_interest
           (date, ticker, short_volume, short_exempt_volume, total_volume, short_pct)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [s.date, s.ticker, s.short_volume, s.short_exempt_volume, s.total_volume, s.short_pct],
      )
    }

    // -- api_budget (cold-preserved: no runtime role holds any privilege) ----
    await client.query('TRUNCATE capital.api_budget')
    const budget = sqlite
      .prepare(`SELECT ${API_BUDGET_COLUMNS.join(', ')} FROM api_budget ORDER BY source, date`)
      .all() as BudgetRow[]
    for (const b of budget) {
      await client.query(
        'INSERT INTO capital.api_budget (source, date, requests_used) VALUES ($1,$2,$3)',
        [b.source, b.date, b.requests_used],
      )
    }

    // -- pending_manual_input ------------------------------------------------
    await client.query('TRUNCATE capital.pending_manual_input')
    const pending = sqlite
      .prepare(`SELECT ${PENDING_COLUMNS.join(', ')} FROM pending_manual_input ORDER BY id`)
      .all() as PendingRow[]
    for (const p of pending) {
      await client.query(
        `INSERT INTO capital.pending_manual_input
           (id, ticker, source, reason, suggested_action, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.ticker, p.source, p.reason, p.suggested_action, p.created_at, p.resolved_at],
      )
    }

    return [
      { table: 'capital.watchlist', rows: watchlist.length },
      { table: 'capital.documents', rows: docs.length },
      { table: 'capital.fetch_log', rows: fetches.length },
      { table: 'capital.short_interest', rows: shorts.length },
      { table: 'capital.api_budget', rows: budget.length },
      { table: 'capital.pending_manual_input', rows: pending.length },
    ]
  } finally {
    sqlite.close()
  }
}
