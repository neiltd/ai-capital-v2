// DETERMINISTIC FABRICATED FIXTURES for the legacy copy.
//
// NOTHING HERE IS DERIVED FROM PRODUCTION. Every ticker is in a reserved
// ZZ-prefixed namespace, every company, URL, price, share count, hash and
// embedding is invented, and no value was read from a real store. That is not a
// style preference: a committed fixture derived from the real book would put
// portfolio data in the repository.
//
// GENERATED, NOT COMMITTED. A committed SQLite or Lance file is opaque - it
// cannot be diffed, and a reviewer must take its contents on trust. A committed
// GENERATOR is reviewable line by line, and its output is pinned by SHA-256 in
// the evidence manifest instead. Determinism comes from fixed values and fixed
// timestamps: there is no clock and no randomness anywhere below.
//
// POSITIVE AND NEGATIVE ARE SEPARATE. `writePositiveFixtures` produces a
// snapshot in which every source is valid. Each defect lives in its own
// `writeNegative*` variant, so a negative probe proves exactly one refusal and
// a positive run is never "valid except for the bit we planted".

import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { LanceRow, LanceTableLike } from '../src/legacy-copy/lance.js'
import { CANONICAL_UUID_RE } from '../src/legacy-copy/lance.js'

// ---------------------------------------------------------------------------
// LAYOUT
// ---------------------------------------------------------------------------

export const PORTFOLIO_DB = 'apps/scenario-simulator/data/portfolio.db'
export const CAPITAL_DB = 'apps/capital-intelligence-ingestion/data/sqlite.db'
export const THESIS_DB = 'apps/thesis-memory/data/thesis.db'
export const GRAPH_DB = 'apps/dependency-graph-engine/data/graph.db'
export const PREDICTIONS_JSONL = 'apps/investment-analyst-agents/archive/predictions.jsonl'
export const QA_JSONL = 'apps/investment-analyst-agents/archive/qa.jsonl'
export const LANCE_DIR = 'apps/capital-intelligence-ingestion/data/lancedb'
export const SOURCE_HEAD = 'SOURCE_HEAD'

/** A fabricated 40-hex commit id. Not any commit in this repository. */
export const FIXTURE_HEAD = 'abcdef0123456789abcdef0123456789abcdef01'

interface SqliteDb {
  exec(sql: string): unknown
  prepare(sql: string): { run(...params: unknown[]): unknown }
  close(): void
}

async function openWritableSqlite(path: string): Promise<SqliteDb> {
  mkdirSync(dirname(path), { recursive: true })
  const mod = await import('better-sqlite3')
  const Database = (mod.default ?? mod) as unknown as new (p: string) => SqliteDb
  return new Database(path)
}

// ---------------------------------------------------------------------------
// FABRICATED VALUES
// ---------------------------------------------------------------------------
//
// TEXT AFFINITY FOR THE DECIMAL COLUMNS, DELIBERATELY. SQLite has no exact
// decimal type: a NUMERIC column silently converts '1234567890.12345678901234567890'
// to the nearest float64 on the way IN, and the fixture would then be testing
// SQLite's rounding rather than the copy's fidelity. The target columns are
// PostgreSQL NUMERIC, which is exact, so the fixture stores the decimal as TEXT
// and the copy is asked to carry it through unchanged. The schema assertion
// compares column NAMES, not affinities, so this does not weaken it.
//
// Coverage carried by the values themselves: NULLs in every nullable column,
// decimals with more precision than a float64 holds exactly, a timestamp inside
// the US DST transition and one with an explicit offset, JSON objects and
// arrays, Thai script, an emoji with a combining mark, single and double quotes,
// and a backslash.

export const UNICODE_COMPANY = 'ZZ ทดสอบ Holdings \u{1F9EA}́'
export const QUOTED_REASON = 'he said "buy" then \'sold\' \\ backslash'
export const EXACT_DECIMAL = '1234567890.12345678901234567890'
export const DST_TIMESTAMP = '2026-03-08T02:30:00-08:00'
export const OFFSET_TIMESTAMP = '2026-07-01T12:00:00+07:00'

export interface PositiveCounts {
  'portfolio.positions': number
  'portfolio.trade_log': number
  'capital.watchlist': number
  'capital.documents': number
  'capital.fetch_log': number
  'capital.short_interest': number
  'capital.api_budget': number
  'capital.pending_manual_input': number
  'thesis.theses': number
  'thesis.assumptions': number
  'thesis.narratives': number
  'thesis.proposals': number
  'thesis.proposal_changes': number
  'thesis.theme_memberships': number
  'briefing.predictions': number
  'briefing.qa': number
  'graph.nodes': number
  'graph.edges': number
  'graph.proposals': number
  'graph.proposal_edges': number
  'capital.chunks': number
}

// ---------------------------------------------------------------------------
// SQLITE SOURCES
// ---------------------------------------------------------------------------

export async function writePortfolioDb(root: string): Promise<number[]> {
  const db = await openWritableSqlite(join(root, PORTFOLIO_DB))
  try {
    db.exec(
      `CREATE TABLE positions (
         ticker TEXT PRIMARY KEY, company TEXT, shares TEXT, avg_cost TEXT,
         current_price TEXT, current_value TEXT, unrealized_pnl TEXT,
         updated_at TEXT, asset_class TEXT, currency TEXT, price_symbol TEXT, strategy TEXT);
       CREATE TABLE trade_log (
         id INTEGER PRIMARY KEY, date TEXT, ticker TEXT, action TEXT, shares TEXT,
         price TEXT, reason TEXT, current_price TEXT, pct_change TEXT);`,
    )
    const pos = db.prepare(
      'INSERT INTO positions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    pos.run('ZZTEST1', UNICODE_COMPANY, '10.5', '1.25', '2', '21', '7.75',
      DST_TIMESTAMP, 'us_equity', 'USD', '', 'tactical')
    pos.run('ZZTEST2', 'ZZ Second Co', EXACT_DECIMAL, EXACT_DECIMAL, '0', '0', '0',
      OFFSET_TIMESTAMP, 'th_equity', 'THB', 'ZZ2.BK', 'dca')
    pos.run('ZZTEST3', "ZZ O'Brien & Sons \\ Ltd", '1', '1', '1', '1', '0',
      '2026-01-01T00:00:00Z', 'gold', 'USD', '', 'tax_locked')

    const trade = db.prepare('INSERT INTO trade_log VALUES (?,?,?,?,?,?,?,?,?)')
    trade.run(1, '2026-01-02', 'ZZTEST1', 'buy', '10.5', '1.25', QUOTED_REASON, '2', '60')
    trade.run(2, '2026-02-03', 'ZZTEST2', 'sell', '1', EXACT_DECIMAL, '', '0', '0')
    return [3, 2]
  } finally {
    db.close()
  }
}

export async function writeCapitalDb(root: string): Promise<number[]> {
  const db = await openWritableSqlite(join(root, CAPITAL_DB))
  try {
    db.exec(
      `CREATE TABLE watchlist (
         ticker TEXT PRIMARY KEY, company TEXT, cik TEXT, themes TEXT, news_only INTEGER,
         ir_feed_url TEXT, ir_feed_status TEXT, active INTEGER, added_at TEXT,
         news_search_terms TEXT, thesis_update_days INTEGER);
       CREATE TABLE documents (doc_hash TEXT PRIMARY KEY, ticker TEXT, fetched_at TEXT);
       CREATE TABLE fetch_log (
         id INTEGER PRIMARY KEY, ticker TEXT, source TEXT, fetched_at TEXT,
         doc_count INTEGER, chunk_count INTEGER);
       CREATE TABLE short_interest (
         date TEXT, ticker TEXT, short_volume NUMERIC, short_exempt_volume NUMERIC,
         total_volume NUMERIC, short_pct NUMERIC, PRIMARY KEY (date, ticker));
       CREATE TABLE api_budget (source TEXT, date TEXT, requests_used INTEGER,
         PRIMARY KEY (source, date));
       CREATE TABLE pending_manual_input (
         id TEXT PRIMARY KEY, ticker TEXT, source TEXT, reason TEXT,
         suggested_action TEXT, created_at TEXT, resolved_at TEXT);`,
    )
    const w = db.prepare('INSERT INTO watchlist VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    // cik and ir_feed_url NULL on one row; both booleans exercised as 0 and 1.
    w.run('ZZTEST1', UNICODE_COMPANY, null, '["zz-theme"]', 0, null, 'pending', 1,
      DST_TIMESTAMP, '["zz term"]', 1)
    w.run('ZZTEST2', 'ZZ Second Co', '0000000000', '[]', 1, 'https://zz.invalid/ir',
      'discovered', 0, OFFSET_TIMESTAMP, '[]', 7)

    const d = db.prepare('INSERT INTO documents VALUES (?,?,?)')
    d.run('zzhash-a', 'ZZTEST1', DST_TIMESTAMP)
    d.run('zzhash-b', 'ZZTEST2', OFFSET_TIMESTAMP)

    const f = db.prepare('INSERT INTO fetch_log VALUES (?,?,?,?,?,?)')
    f.run(1, 'ZZTEST1', 'zz-source', DST_TIMESTAMP, 2, 3)
    f.run(2, 'ZZTEST2', 'zz-source', OFFSET_TIMESTAMP, 0, 0)

    const s = db.prepare('INSERT INTO short_interest VALUES (?,?,?,?,?,?)')
    s.run('2026-01-02', 'ZZTEST1', '100', '1', '1000', EXACT_DECIMAL)

    const b = db.prepare('INSERT INTO api_budget VALUES (?,?,?)')
    b.run('zz-api', '2026-01-02', 5)

    const p = db.prepare('INSERT INTO pending_manual_input VALUES (?,?,?,?,?,?,?)')
    // resolved_at NULL on one row, set on the other.
    p.run('zzp-1', 'ZZTEST1', 'zz-source', QUOTED_REASON, 'zz action', DST_TIMESTAMP, null)
    p.run('zzp-2', 'ZZTEST2', 'zz-source', 'resolved', 'zz action', DST_TIMESTAMP,
      OFFSET_TIMESTAMP)

    return [2, 2, 2, 1, 1, 2]
  } finally {
    db.close()
  }
}

export async function writeThesisDb(root: string): Promise<number[]> {
  const db = await openWritableSqlite(join(root, THESIS_DB))
  try {
    db.exec(
      `CREATE TABLE theses (id TEXT PRIMARY KEY, ticker TEXT, type TEXT,
         position_size TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE assumptions (id TEXT PRIMARY KEY, thesis_id TEXT, label TEXT,
         status TEXT, last_evidence_summary TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE narratives (id TEXT PRIMARY KEY, thesis_id TEXT, content TEXT,
         version INTEGER, created_at TEXT);
       CREATE TABLE proposals (id TEXT PRIMARY KEY, thesis_id TEXT, status TEXT,
         chunk_ids_used TEXT, claude_reasoning TEXT, created_at TEXT, resolved_at TEXT);
       CREATE TABLE proposal_changes (id TEXT PRIMARY KEY, proposal_id TEXT,
         change_type TEXT, assumption_id TEXT, old_value TEXT, new_value TEXT,
         reasoning TEXT, evidence_quotes TEXT, approved INTEGER);
       CREATE TABLE theme_memberships (theme_id TEXT, ticker TEXT, weight NUMERIC,
         PRIMARY KEY (theme_id, ticker));`,
    )
    // A two-level FK graph: thesis -> proposal -> proposal_change, plus
    // assumptions and narratives hanging off the thesis.
    db.prepare('INSERT INTO theses VALUES (?,?,?,?,?,?)')
      .run('zzt-1', 'ZZTEST1', 'long', 'core', DST_TIMESTAMP, OFFSET_TIMESTAMP)
    const a = db.prepare('INSERT INTO assumptions VALUES (?,?,?,?,?,?,?)')
    a.run('zza-1', 'zzt-1', 'ZZ assumption one', 'holding', null, DST_TIMESTAMP, DST_TIMESTAMP)
    a.run('zza-2', 'zzt-1', UNICODE_COMPANY, 'broken', 'zz evidence', DST_TIMESTAMP,
      OFFSET_TIMESTAMP)
    db.prepare('INSERT INTO narratives VALUES (?,?,?,?,?)')
      .run('zzn-1', 'zzt-1', QUOTED_REASON, 1, DST_TIMESTAMP)
    const p = db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?)')
    p.run('zzpr-1', 'zzt-1', 'open', '["zzc-1"]', 'zz reasoning', DST_TIMESTAMP, null)
    const c = db.prepare('INSERT INTO proposal_changes VALUES (?,?,?,?,?,?,?,?,?)')
    // approved exercised as NULL, 0 and 1 - the target column is nullable.
    c.run('zzpc-1', 'zzpr-1', 'edit', 'zza-1', 'old', 'new', 'zz why', '["q"]', null)
    c.run('zzpc-2', 'zzpr-1', 'edit', null, 'old', 'new', 'zz why', '[]', 1)
    c.run('zzpc-3', 'zzpr-1', 'edit', 'zza-2', 'old', 'new', 'zz why', '[]', 0)
    db.prepare('INSERT INTO theme_memberships VALUES (?,?,?)')
      .run('zzth-1', 'ZZTEST1', EXACT_DECIMAL)
    return [1, 2, 1, 1, 3, 1]
  } finally {
    db.close()
  }
}

export async function writeGraphDb(root: string): Promise<number[]> {
  const db = await openWritableSqlite(join(root, GRAPH_DB))
  try {
    db.exec(
      `CREATE TABLE nodes (ticker TEXT PRIMARY KEY, company TEXT, themes TEXT);
       CREATE TABLE edges (id TEXT PRIMARY KEY, from_ticker TEXT, to_ticker TEXT,
         rel_type TEXT, strength TEXT, description TEXT, status TEXT,
         source_chunk_ids TEXT, evidence_quote TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT, claude_reasoning TEXT,
         chunk_ids_used TEXT, created_at TEXT, resolved_at TEXT);
       CREATE TABLE proposal_edges (id TEXT PRIMARY KEY, proposal_id TEXT,
         from_ticker TEXT, to_ticker TEXT, rel_type TEXT, strength TEXT,
         description TEXT, evidence_quote TEXT, approved INTEGER);`,
    )
    const n = db.prepare('INSERT INTO nodes VALUES (?,?,?)')
    n.run('ZZTEST1', UNICODE_COMPANY, '[]')
    n.run('ZZTEST2', 'ZZ Second Co', '["zz"]')
    db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('zze-1', 'ZZTEST1', 'ZZTEST2', 'supplies', 'strong', QUOTED_REASON, 'active',
        '[]', null, DST_TIMESTAMP, OFFSET_TIMESTAMP)
    db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?)')
      .run('zzgp-1', 'open', 'zz reasoning', '[]', DST_TIMESTAMP, null)
    const pe = db.prepare('INSERT INTO proposal_edges VALUES (?,?,?,?,?,?,?,?,?)')
    pe.run('zzpe-1', 'zzgp-1', 'ZZTEST1', 'ZZTEST2', 'supplies', 'weak', 'zz', null, null)
    return [2, 1, 1, 1]
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// JSONL SOURCES
// ---------------------------------------------------------------------------

export function writePredictionsJsonl(root: string): number {
  const path = join(root, PREDICTIONS_JSONL)
  mkdirSync(dirname(path), { recursive: true })
  const lines = [
    JSON.stringify({
      date: '2026-01-02', regime: 'zz-regime', confidence: 'low',
      scenarios: [{ name: UNICODE_COMPANY, p: 0.5 }],
      actions: { hold: ['ZZTEST1'], note: QUOTED_REASON },
    }),
    JSON.stringify({
      date: '2026-01-03', regime: 'zz-regime', confidence: 'high',
      scenarios: [], actions: {},
    }),
  ]
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
  return lines.length
}

/**
 * EMPTY BUT PRESENT. A valid zero-row source, and deliberately part of the
 * POSITIVE set: an empty archive is an ordinary state, unlike a missing file.
 */
export function writeQaJsonlEmpty(root: string): number {
  const path = join(root, QA_JSONL)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', 'utf-8')
  return 0
}

export function writeQaJsonlPopulated(root: string): number {
  const path = join(root, QA_JSONL)
  mkdirSync(dirname(path), { recursive: true })
  const lines = [
    JSON.stringify({
      date: '2026-01-02', timestamp: DST_TIMESTAMP, mode: 'oneshot',
      exchanges: [{ q: 'zz?', a: UNICODE_COMPANY }],
    }),
  ]
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
  return lines.length
}

// ---------------------------------------------------------------------------
// LANCE SOURCE
// ---------------------------------------------------------------------------

/** A deterministic, non-constant 384-dimension unit-ish vector. */
export function fixtureVector(seed: number): number[] {
  const out = new Array<number>(384)
  for (let i = 0; i < 384; i++) out[i] = Number((((i + seed) % 97) / 97).toFixed(6))
  return out
}

/** One embedded U+0000, written as a visible escape. */
export const NUL_CONTENT = 'ZZ content\u0000with a NUL'
/** What the adapter must send to PostgreSQL once the NUL is stripped. */
export const NUL_CONTENT_SANITIZED = 'ZZ contentwith a NUL'

export const CHUNK_ID_A = '0a111111-2222-4333-8444-555555555555'
export const CHUNK_ID_B = 'f0222222-3333-4444-8555-666666666666'
export const CHUNK_ID_C = '7c333333-4444-4555-8666-777777777777'

/** The positive chunk set: a normal row, an empty-to-NULL row, and a row whose
 *  content carries a NUL byte for the sanitiser to strip. */
export function positiveChunks(): LanceRow[] {
  return [
    {
      id: CHUNK_ID_A, ticker: 'ZZTEST1', company: UNICODE_COMPANY, source: 'zz-source',
      docType: 'zz-doc', section: 'business', publishedDate: '2026-01-02',
      fiscalPeriod: 'FY2026', url: 'https://zz.invalid/a', chunkIndex: 0,
      parentDocId: 'zzdoc-1', contentHash: 'zzhash-a', embeddingModel: 'zz/model',
      content: 'ZZ content one', vector: fixtureVector(1),
    },
    {
      id: CHUNK_ID_B, ticker: 'ZZTEST2', company: 'ZZ Second Co', source: 'zz-source',
      docType: 'zz-doc', section: '', publishedDate: '', fiscalPeriod: '',
      url: '', chunkIndex: 1, parentDocId: 'zzdoc-2', contentHash: 'zzhash-b',
      embeddingModel: 'zz/model', content: 'ZZ content two', vector: fixtureVector(2),
    },
    {
      id: CHUNK_ID_C, ticker: 'ZZTEST1', company: 'ZZ Third Co', source: 'zz-source',
      docType: 'zz-doc', section: 'risk_factors', publishedDate: '2026-02-03',
      fiscalPeriod: 'FY2026', url: 'https://zz.invalid/c', chunkIndex: 2,
      parentDocId: 'zzdoc-1', contentHash: 'zzhash-c', embeddingModel: 'zz/model',
      // The escape is VISIBLE in source; at runtime this string holds one real
      // U+0000 - the byte PostgreSQL TEXT rejects and sanitizeText strips.
      content: NUL_CONTENT, vector: fixtureVector(3),
    },
  ]
}

/**
 * An in-memory table with the surface `scanLanceChunks` needs. The real
 * directory writer belongs to the PostgreSQL slice; the traversal contract is
 * provable without a columnar file, and proving it here keeps the database-free
 * suite free of a native columnar dependency too.
 */
export function fakeLanceTable(rows: LanceRow[]): LanceTableLike {
  const matches = (r: LanceRow, predicate: string): boolean => {
    const m = /^id >= '(.)' AND id < '(.)'$/.exec(predicate)
    if (!m) throw new Error(`fixture table cannot evaluate predicate: ${predicate}`)
    const id = String(r.id)
    return id >= m[1] && id < m[2]
  }
  return {
    async countRows(filter?: string) {
      return filter === undefined ? rows.length : rows.filter(r => matches(r, filter)).length
    },
    query() {
      return {
        where(predicate: string) {
          return { async toArray() { return rows.filter(r => matches(r, predicate)) } }
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// SNAPSHOT ASSEMBLY
// ---------------------------------------------------------------------------

export function writeSourceHead(root: string, head: string = FIXTURE_HEAD): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, SOURCE_HEAD), head + '\n', 'utf-8')
}

/** The Lance directory is created as a plain non-empty tree here: the scan
 *  contract is exercised through `fakeLanceTable`, and the completeness check
 *  and the fingerprint need real ordinary nodes to walk. The PostgreSQL slice
 *  replaces this with a written table. */
export function writeLancePlaceholder(root: string): void {
  const dir = join(root, LANCE_DIR, 'chunks.lance')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fixture.manifest'), 'zz-fixture\n', 'utf-8')
}

// -- snapshot-shape negatives ------------------------------------------------

export function removeSnapshotPath(root: string, rel: string): void {
  rmSync(join(root, rel), { recursive: true, force: true })
}

export function emptyLanceDirectory(root: string): void {
  const dir = join(root, LANCE_DIR)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/** Replace a required file with a symlink to an identical copy elsewhere. */
export function symlinkRequiredFile(root: string, rel: string, outside: string): void {
  const p = join(root, rel)
  const data = readFileSync(p)
  writeFileSync(outside, data)
  rmSync(p)
  symlinkSync(outside, p)
}

/** A symlink INSIDE the Lance tree, below the required directory. */
export function symlinkInsideLance(root: string, outside: string): void {
  writeFileSync(outside, 'zz\n', 'utf-8')
  symlinkSync(outside, join(root, LANCE_DIR, 'chunks.lance', 'linked.manifest'))
}

/** A FIFO where only ordinary nodes belong. */
export function fifoInsideLance(root: string): void {
  execFileSync('/usr/bin/mkfifo', [join(root, LANCE_DIR, 'chunks.lance', 'pipe')])
}

export interface PositiveSnapshot {
  root: string
  counts: Partial<PositiveCounts>
}

export async function writePositiveFixtures(root: string): Promise<PositiveSnapshot> {
  mkdirSync(root, { recursive: true })
  const [positions, tradeLog] = await writePortfolioDb(root)
  const [watchlist, documents, fetchLog, shortInterest, apiBudget, pending] =
    await writeCapitalDb(root)
  const [theses, assumptions, narratives, proposals, changes, memberships] =
    await writeThesisDb(root)
  const [nodes, edges, gproposals, pedges] = await writeGraphDb(root)
  const predictions = writePredictionsJsonl(root)
  const qa = writeQaJsonlEmpty(root)
  writeLancePlaceholder(root)
  writeSourceHead(root)
  return {
    root,
    counts: {
      'portfolio.positions': positions,
      'portfolio.trade_log': tradeLog,
      'capital.watchlist': watchlist,
      'capital.documents': documents,
      'capital.fetch_log': fetchLog,
      'capital.short_interest': shortInterest,
      'capital.api_budget': apiBudget,
      'capital.pending_manual_input': pending,
      'thesis.theses': theses,
      'thesis.assumptions': assumptions,
      'thesis.narratives': narratives,
      'thesis.proposals': proposals,
      'thesis.proposal_changes': changes,
      'thesis.theme_memberships': memberships,
      'briefing.predictions': predictions,
      'briefing.qa': qa,
      'graph.nodes': nodes,
      'graph.edges': edges,
      'graph.proposals': gproposals,
      'graph.proposal_edges': pedges,
      'capital.chunks': positiveChunks().length,
    },
  }
}

// ---------------------------------------------------------------------------
// NEGATIVE FIXTURES - one defect each, never mixed into the positive set
// ---------------------------------------------------------------------------

export function writeNegativeMalformedJsonl(root: string): void {
  const path = join(root, PREDICTIONS_JSONL)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ date: '2026-01-02', regime: 'r', confidence: 'c', scenarios: [], actions: {} }) +
    '\n{ this is not json\n',
    'utf-8',
  )
}

export function writeNegativeMissingJsonl(root: string): void {
  const path = join(root, QA_JSONL)
  if (existsSync(path)) rmSync(path)
}

export async function writeNegativeCorruptSqlite(root: string): Promise<void> {
  const path = join(root, PORTFOLIO_DB)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'this is not a SQLite database header', 'utf-8')
}

export async function writeNegativeInvalidBoolean(root: string): Promise<void> {
  const db = await openWritableSqlite(join(root, CAPITAL_DB))
  try {
    db.prepare('UPDATE watchlist SET news_only = ? WHERE ticker = ?').run(2, 'ZZTEST1')
  } finally {
    db.close()
  }
}

export async function writeNegativeNullBoolean(root: string): Promise<void> {
  const db = await openWritableSqlite(join(root, CAPITAL_DB))
  try {
    db.prepare('UPDATE watchlist SET active = NULL WHERE ticker = ?').run('ZZTEST1')
  } finally {
    db.close()
  }
}

/** An added column the schema assertion has never seen. */
export async function writeNegativeSchemaDrift(root: string): Promise<void> {
  const db = await openWritableSqlite(join(root, PORTFOLIO_DB))
  try {
    db.exec('ALTER TABLE positions ADD COLUMN zz_unreviewed TEXT')
  } finally {
    db.close()
  }
}

export function negativeChunksWrongDimension(): LanceRow[] {
  const rows = positiveChunks()
  rows[0] = { ...rows[0], vector: fixtureVector(1).slice(0, 383) }
  return rows
}

export function negativeChunksDuplicateId(): LanceRow[] {
  const rows = positiveChunks()
  rows[2] = { ...rows[2], id: rows[0].id }
  return rows
}

export function negativeChunksNoncanonicalId(): LanceRow[] {
  const rows = positiveChunks()
  rows[1] = { ...rows[1], id: rows[1].id.toUpperCase() }
  return rows
}

/** Sanity: the canonical ids used above really are canonical. */
export function fixtureIdsAreCanonical(): boolean {
  return [CHUNK_ID_A, CHUNK_ID_B, CHUNK_ID_C].every(id => CANONICAL_UUID_RE.test(id))
}
