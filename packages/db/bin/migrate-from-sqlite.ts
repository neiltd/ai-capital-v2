#!/usr/bin/env node
// Copy data from each app's SQLite into Postgres. Idempotent: target tables
// are emptied per source before insert, so re-running rebuilds from scratch.
//
// Usage:
//   tsx bin/migrate-from-sqlite.ts --source=portfolio
//
// Sources implemented this pass:
//   portfolio   apps/scenario-simulator/data/portfolio.db  → portfolio.{positions, trade_log}
//
// Future passes will add: ingestion (capital sqlite), simulation (sim.db),
// theses (thesis-memory), graph (dependency-graph-engine), etc.

import Database from 'better-sqlite3'
import { join } from 'path'
import { getPool, closePool, usePostgres } from '../src/pool.js'

interface SrcConfig {
  name:        string
  sqlitePath:  string
  description: string
  run:        () => Promise<{ table: string; rows: number }[]>
}

function workspaceRoot(): string {
  // CWD when invoked via `pnpm -F @common/db run migrate-data` is the package dir,
  // so step up twice (packages/db -> packages -> workspace root).
  return join(process.cwd(), '..', '..')
}

async function migratePortfolio(): Promise<{ table: string; rows: number }[]> {
  const sqlitePath = join(workspaceRoot(), 'apps/scenario-simulator/data/portfolio.db')
  const sqlite    = new Database(sqlitePath, { readonly: true })
  const pool       = getPool()
  const client     = await pool.connect()
  const out: { table: string; rows: number }[] = []

  try {
    await client.query('BEGIN')

    // ── positions ────────────────────────────────────────────────────────────
    await client.query('TRUNCATE portfolio.positions')
    interface PositionRow {
      ticker:         string
      company:        string
      shares:         number
      avg_cost:       number
      current_price:  number
      current_value:  number
      unrealized_pnl: number
      updated_at:     string
      asset_class:    string
      currency:       string
      price_symbol:   string
      strategy:       string
    }
    const positions = sqlite.prepare('SELECT * FROM positions ORDER BY ticker').all() as PositionRow[]
    for (const p of positions) {
      await client.query(
        `INSERT INTO portfolio.positions
           (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl,
            updated_at, asset_class, currency, price_symbol, strategy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          p.ticker, p.company, p.shares, p.avg_cost,
          p.current_price, p.current_value, p.unrealized_pnl,
          p.updated_at, p.asset_class, p.currency, p.price_symbol, p.strategy,
        ],
      )
    }
    out.push({ table: 'portfolio.positions', rows: positions.length })

    // ── trade_log ────────────────────────────────────────────────────────────
    await client.query('TRUNCATE portfolio.trade_log RESTART IDENTITY')
    interface TradeRow {
      id:            number
      date:          string
      ticker:        string
      action:        string
      shares:        number
      price:         number
      reason:        string
      current_price: number
      pct_change:    number
    }
    const trades = sqlite.prepare('SELECT * FROM trade_log ORDER BY id').all() as TradeRow[]
    for (const t of trades) {
      await client.query(
        `INSERT INTO portfolio.trade_log
           (trade_date, ticker, action, shares, price, reason, current_price, pct_change)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          // SQLite 'date' was stored as 'YYYY-MM-DD' string; cast straight to DATE.
          t.date, t.ticker, t.action, t.shares, t.price, t.reason, t.current_price, t.pct_change,
        ],
      )
    }
    out.push({ table: 'portfolio.trade_log', rows: trades.length })

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    sqlite.close()
  }
  return out
}

async function migrateCapital(): Promise<{ table: string; rows: number }[]> {
  const sqlitePath = join(workspaceRoot(), 'apps/capital-intelligence-ingestion/data/sqlite.db')
  const sqlite    = new Database(sqlitePath, { readonly: true })
  const pool       = getPool()
  const client     = await pool.connect()
  const out: { table: string; rows: number }[] = []

  // Batch-insert helper: chunks rows into IN-list params (Postgres caps at
  // 65535 params per query; 1000 rows × ~10 cols = comfortably under).
  const BATCH = 500

  try {
    await client.query('BEGIN')

    // ── watchlist ────────────────────────────────────────────────────────────
    await client.query('TRUNCATE capital.watchlist')
    interface WatchlistRow {
      ticker: string; company: string; cik: string | null; themes: string
      news_only: number; ir_feed_url: string | null; ir_feed_status: string
      active: number; added_at: string; news_search_terms: string
      thesis_update_days: number
    }
    const watchlist = sqlite.prepare('SELECT * FROM watchlist').all() as WatchlistRow[]
    for (const w of watchlist) {
      await client.query(
        `INSERT INTO capital.watchlist
           (ticker, company, cik, themes, news_only, ir_feed_url, ir_feed_status,
            active, added_at, news_search_terms, thesis_update_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          w.ticker, w.company, w.cik, w.themes,
          !!w.news_only, w.ir_feed_url, w.ir_feed_status,
          !!w.active, w.added_at, w.news_search_terms, w.thesis_update_days,
        ],
      )
    }
    out.push({ table: 'capital.watchlist', rows: watchlist.length })

    // ── documents (high-volume; batch via VALUES list) ───────────────────────
    await client.query('TRUNCATE capital.documents')
    interface DocRow { doc_hash: string; ticker: string; fetched_at: string }
    const docs = sqlite.prepare('SELECT doc_hash, ticker, fetched_at FROM documents').all() as DocRow[]
    for (let i = 0; i < docs.length; i += BATCH) {
      const slice = docs.slice(i, i + BATCH)
      const params: unknown[] = []
      const placeholders = slice.map((d, k) => {
        const base = k * 3
        params.push(d.doc_hash, d.ticker, d.fetched_at)
        return `($${base + 1}, $${base + 2}, $${base + 3})`
      }).join(',')
      await client.query(
        `INSERT INTO capital.documents (doc_hash, ticker, fetched_at) VALUES ${placeholders}`,
        params,
      )
    }
    out.push({ table: 'capital.documents', rows: docs.length })

    // ── fetch_log ────────────────────────────────────────────────────────────
    await client.query('TRUNCATE capital.fetch_log RESTART IDENTITY')
    interface FetchRow {
      id: number; ticker: string; source: string; fetched_at: string
      doc_count: number; chunk_count: number
    }
    const fetches = sqlite.prepare('SELECT * FROM fetch_log ORDER BY id').all() as FetchRow[]
    for (const f of fetches) {
      await client.query(
        `INSERT INTO capital.fetch_log (ticker, source, fetched_at, doc_count, chunk_count)
         VALUES ($1,$2,$3,$4,$5)`,
        [f.ticker, f.source, f.fetched_at, f.doc_count, f.chunk_count],
      )
    }
    out.push({ table: 'capital.fetch_log', rows: fetches.length })

    // ── short_interest ───────────────────────────────────────────────────────
    await client.query('TRUNCATE capital.short_interest')
    interface ShortRow {
      date: string; ticker: string; short_volume: number; short_exempt_volume: number
      total_volume: number; short_pct: number
    }
    const shorts = sqlite.prepare('SELECT * FROM short_interest').all() as ShortRow[]
    for (const s of shorts) {
      await client.query(
        `INSERT INTO capital.short_interest
           (date, ticker, short_volume, short_exempt_volume, total_volume, short_pct)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [s.date, s.ticker, s.short_volume, s.short_exempt_volume, s.total_volume, s.short_pct],
      )
    }
    out.push({ table: 'capital.short_interest', rows: shorts.length })

    // ── api_budget ───────────────────────────────────────────────────────────
    await client.query('TRUNCATE capital.api_budget')
    interface BudgetRow { source: string; date: string; requests_used: number }
    const budget = sqlite.prepare('SELECT * FROM api_budget').all() as BudgetRow[]
    for (const b of budget) {
      await client.query(
        `INSERT INTO capital.api_budget (source, date, requests_used) VALUES ($1,$2,$3)`,
        [b.source, b.date, b.requests_used],
      )
    }
    out.push({ table: 'capital.api_budget', rows: budget.length })

    // ── pending_manual_input ─────────────────────────────────────────────────
    await client.query('TRUNCATE capital.pending_manual_input')
    interface PendingRow {
      id: string; ticker: string; source: string; reason: string
      suggested_action: string; created_at: string; resolved_at: string | null
    }
    const pending = sqlite.prepare('SELECT * FROM pending_manual_input').all() as PendingRow[]
    for (const p of pending) {
      await client.query(
        `INSERT INTO capital.pending_manual_input
           (id, ticker, source, reason, suggested_action, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.ticker, p.source, p.reason, p.suggested_action, p.created_at, p.resolved_at],
      )
    }
    out.push({ table: 'capital.pending_manual_input', rows: pending.length })

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    sqlite.close()
  }
  return out
}

async function migrateThesis(): Promise<{ table: string; rows: number }[]> {
  const sqlitePath = join(workspaceRoot(), 'apps/thesis-memory/data/thesis.db')
  const sqlite = new Database(sqlitePath, { readonly: true })
  const pool   = getPool()
  const client = await pool.connect()
  const out: { table: string; rows: number }[] = []

  try {
    await client.query('BEGIN')

    // ── theses (parent) ──────────────────────────────────────────────────────
    await client.query(
      'TRUNCATE thesis.theses, thesis.assumptions, thesis.narratives, ' +
      '         thesis.proposals, thesis.proposal_changes, thesis.theme_memberships',
    )
    interface ThesisRow {
      id: string; ticker: string; type: string; position_size: string
      created_at: string; updated_at: string
    }
    const theses = sqlite.prepare('SELECT * FROM theses').all() as ThesisRow[]
    for (const t of theses) {
      await client.query(
        `INSERT INTO thesis.theses (id, ticker, type, position_size, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.id, t.ticker, t.type, t.position_size, t.created_at, t.updated_at],
      )
    }
    out.push({ table: 'thesis.theses', rows: theses.length })

    // ── assumptions ──────────────────────────────────────────────────────────
    interface AssumptionRow {
      id: string; thesis_id: string; label: string; status: string
      last_evidence_summary: string | null; created_at: string; updated_at: string
    }
    const assumptions = sqlite.prepare('SELECT * FROM assumptions').all() as AssumptionRow[]
    for (const a of assumptions) {
      await client.query(
        `INSERT INTO thesis.assumptions
           (id, thesis_id, label, status, last_evidence_summary, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.thesis_id, a.label, a.status, a.last_evidence_summary, a.created_at, a.updated_at],
      )
    }
    out.push({ table: 'thesis.assumptions', rows: assumptions.length })

    // ── narratives ───────────────────────────────────────────────────────────
    interface NarrativeRow {
      id: string; thesis_id: string; content: string; version: number; created_at: string
    }
    const narratives = sqlite.prepare('SELECT * FROM narratives').all() as NarrativeRow[]
    for (const n of narratives) {
      await client.query(
        `INSERT INTO thesis.narratives (id, thesis_id, content, version, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [n.id, n.thesis_id, n.content, n.version, n.created_at],
      )
    }
    out.push({ table: 'thesis.narratives', rows: narratives.length })

    // ── proposals ────────────────────────────────────────────────────────────
    interface ProposalRow {
      id: string; thesis_id: string; status: string; chunk_ids_used: string
      claude_reasoning: string; created_at: string; resolved_at: string | null
    }
    const proposals = sqlite.prepare('SELECT * FROM proposals').all() as ProposalRow[]
    for (const p of proposals) {
      await client.query(
        `INSERT INTO thesis.proposals
           (id, thesis_id, status, chunk_ids_used, claude_reasoning, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.thesis_id, p.status, p.chunk_ids_used, p.claude_reasoning, p.created_at, p.resolved_at],
      )
    }
    out.push({ table: 'thesis.proposals', rows: proposals.length })

    // ── proposal_changes ─────────────────────────────────────────────────────
    interface ProposalChangeRow {
      id: string; proposal_id: string; change_type: string; assumption_id: string | null
      old_value: string; new_value: string; reasoning: string; evidence_quotes: string
      approved: number | null
    }
    const changes = sqlite.prepare('SELECT * FROM proposal_changes').all() as ProposalChangeRow[]
    for (const c of changes) {
      await client.query(
        `INSERT INTO thesis.proposal_changes
           (id, proposal_id, change_type, assumption_id, old_value, new_value, reasoning, evidence_quotes, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          c.id, c.proposal_id, c.change_type, c.assumption_id,
          c.old_value, c.new_value, c.reasoning, c.evidence_quotes,
          c.approved === null ? null : !!c.approved,
        ],
      )
    }
    out.push({ table: 'thesis.proposal_changes', rows: changes.length })

    // ── theme_memberships ────────────────────────────────────────────────────
    interface ThemeRow { theme_id: string; ticker: string; weight: number }
    const memberships = sqlite.prepare('SELECT * FROM theme_memberships').all() as ThemeRow[]
    for (const m of memberships) {
      await client.query(
        `INSERT INTO thesis.theme_memberships (theme_id, ticker, weight) VALUES ($1,$2,$3)`,
        [m.theme_id, m.ticker, m.weight],
      )
    }
    out.push({ table: 'thesis.theme_memberships', rows: memberships.length })

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    sqlite.close()
  }
  return out
}

async function migrateBriefing(): Promise<{ table: string; rows: number }[]> {
  const { readFileSync, existsSync } = await import('fs')
  const predictionsPath = join(workspaceRoot(), 'apps/investment-analyst-agents/archive/predictions.jsonl')
  const qaPath          = join(workspaceRoot(), 'apps/investment-analyst-agents/archive/qa.jsonl')

  const pool   = getPool()
  const client = await pool.connect()
  const out: { table: string; rows: number }[] = []

  try {
    await client.query('BEGIN')

    // ── predictions ──────────────────────────────────────────────────────────
    await client.query('TRUNCATE briefing.predictions, briefing.qa RESTART IDENTITY')
    if (existsSync(predictionsPath)) {
      const lines = readFileSync(predictionsPath, 'utf-8').split('\n').filter(l => l.trim())
      // Dedup by date — the JSONL may have multiple entries per day from
      // manual re-runs; keep the last (it overwrites the row).
      let count = 0
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as {
            date: string; regime: string; confidence: string
            scenarios: unknown; actions: unknown
          }
          await client.query(
            `INSERT INTO briefing.predictions (date, regime, confidence, scenarios, actions)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (date) DO UPDATE SET
               regime     = EXCLUDED.regime,
               confidence = EXCLUDED.confidence,
               scenarios  = EXCLUDED.scenarios,
               actions    = EXCLUDED.actions`,
            [r.date, r.regime, r.confidence, JSON.stringify(r.scenarios), JSON.stringify(r.actions)],
          )
          count++
        } catch {
          /* skip malformed lines */
        }
      }
      out.push({ table: 'briefing.predictions', rows: count })
    } else {
      out.push({ table: 'briefing.predictions', rows: 0 })
    }

    // ── qa ───────────────────────────────────────────────────────────────────
    if (existsSync(qaPath)) {
      const lines = readFileSync(qaPath, 'utf-8').split('\n').filter(l => l.trim())
      let count = 0
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as {
            date: string; timestamp: string; mode: string; exchanges: unknown
          }
          await client.query(
            `INSERT INTO briefing.qa (date, asked_at, mode, exchanges)
             VALUES ($1,$2,$3,$4)`,
            [r.date, r.timestamp, r.mode, JSON.stringify(r.exchanges)],
          )
          count++
        } catch {
          /* skip malformed lines */
        }
      }
      out.push({ table: 'briefing.qa', rows: count })
    } else {
      out.push({ table: 'briefing.qa', rows: 0 })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return out
}

async function migrateGraph(): Promise<{ table: string; rows: number }[]> {
  const sqlitePath = join(workspaceRoot(), 'apps/dependency-graph-engine/data/graph.db')
  const sqlite = new Database(sqlitePath, { readonly: true })
  const pool   = getPool()
  const client = await pool.connect()
  const out: { table: string; rows: number }[] = []

  try {
    await client.query('BEGIN')

    // FK ordering: nodes → edges → proposals → proposal_edges
    await client.query(
      'TRUNCATE graph.nodes, graph.edges, graph.proposals, graph.proposal_edges',
    )

    interface NodeRow { ticker: string; company: string; themes: string }
    const nodes = sqlite.prepare('SELECT * FROM nodes').all() as NodeRow[]
    for (const n of nodes) {
      await client.query(
        `INSERT INTO graph.nodes (ticker, company, themes) VALUES ($1,$2,$3)`,
        [n.ticker, n.company, n.themes],
      )
    }
    out.push({ table: 'graph.nodes', rows: nodes.length })

    interface EdgeRow {
      id: string; from_ticker: string; to_ticker: string; rel_type: string
      strength: string; description: string; status: string; source_chunk_ids: string
      evidence_quote: string | null; created_at: string; updated_at: string
    }
    const edges = sqlite.prepare('SELECT * FROM edges').all() as EdgeRow[]
    for (const e of edges) {
      await client.query(
        `INSERT INTO graph.edges
           (id, from_ticker, to_ticker, rel_type, strength, description, status,
            source_chunk_ids, evidence_quote, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          e.id, e.from_ticker, e.to_ticker, e.rel_type, e.strength,
          e.description, e.status, e.source_chunk_ids, e.evidence_quote,
          e.created_at, e.updated_at,
        ],
      )
    }
    out.push({ table: 'graph.edges', rows: edges.length })

    interface GProposalRow {
      id: string; status: string; claude_reasoning: string; chunk_ids_used: string
      created_at: string; resolved_at: string | null
    }
    const proposals = sqlite.prepare('SELECT * FROM proposals').all() as GProposalRow[]
    for (const p of proposals) {
      await client.query(
        `INSERT INTO graph.proposals (id, status, claude_reasoning, chunk_ids_used, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, p.status, p.claude_reasoning, p.chunk_ids_used, p.created_at, p.resolved_at],
      )
    }
    out.push({ table: 'graph.proposals', rows: proposals.length })

    interface GProposalEdgeRow {
      id: string; proposal_id: string; from_ticker: string; to_ticker: string
      rel_type: string; strength: string; description: string
      evidence_quote: string | null; approved: number | null
    }
    const pedges = sqlite.prepare('SELECT * FROM proposal_edges').all() as GProposalEdgeRow[]
    for (const pe of pedges) {
      await client.query(
        `INSERT INTO graph.proposal_edges
           (id, proposal_id, from_ticker, to_ticker, rel_type, strength, description, evidence_quote, approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          pe.id, pe.proposal_id, pe.from_ticker, pe.to_ticker, pe.rel_type,
          pe.strength, pe.description, pe.evidence_quote,
          pe.approved === null ? null : !!pe.approved,
        ],
      )
    }
    out.push({ table: 'graph.proposal_edges', rows: pedges.length })

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    sqlite.close()
  }
  return out
}

const SOURCES: SrcConfig[] = [
  {
    name:        'portfolio',
    sqlitePath:  'apps/scenario-simulator/data/portfolio.db',
    description: 'Positions + trade log',
    run:         migratePortfolio,
  },
  {
    name:        'capital',
    sqlitePath:  'apps/capital-intelligence-ingestion/data/sqlite.db',
    description: 'Watchlist + dedup docs + fetch log + short interest + API budget + pending manual input',
    run:         migrateCapital,
  },
  {
    name:        'thesis',
    sqlitePath:  'apps/thesis-memory/data/thesis.db',
    description: 'Theses + assumptions + narratives + proposals + theme memberships',
    run:         migrateThesis,
  },
  {
    name:        'briefing',
    sqlitePath:  'apps/investment-analyst-agents/archive/*.jsonl',
    description: 'Predictions + Q&A archive (from JSONL)',
    run:         migrateBriefing,
  },
  {
    name:        'graph',
    sqlitePath:  'apps/dependency-graph-engine/data/graph.db',
    description: 'Nodes + edges + proposals',
    run:         migrateGraph,
  },
]

function parseArgs(): { source: string | null } {
  const arg = process.argv.slice(2).find(a => a.startsWith('--source='))
  return { source: arg ? arg.split('=')[1] : null }
}

async function main() {
  if (!usePostgres()) {
    console.error('migrate-from-sqlite: DATABASE_URL is not set.')
    process.exit(1)
  }
  const { source } = parseArgs()
  const targets = source
    ? SOURCES.filter(s => s.name === source)
    : SOURCES
  if (source && targets.length === 0) {
    console.error(`Unknown --source=${source}. Known: ${SOURCES.map(s => s.name).join(', ')}`)
    process.exit(1)
  }

  for (const src of targets) {
    console.log(`\n[migrate] ${src.name} (${src.description})  ←  ${src.sqlitePath}`)
    const results = await src.run()
    for (const r of results) console.log(`  + ${r.table}: ${r.rows} rows`)
  }

  await closePool()
}

main().catch(err => {
  console.error('migrate-from-sqlite failed:', err.message)
  console.error(err.stack)
  process.exit(1)
})
