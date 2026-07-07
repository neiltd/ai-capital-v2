import Database from 'better-sqlite3'
import type { DiscoveryPosition, DiscoveryClosedPosition, DiscoveryRun, DiscoveryScenario, DiscoveryAction } from './types.js'

export interface CachedAnalysis {
  scenarios: DiscoveryScenario[]
  action:    DiscoveryAction
}

export class PaperPortfolio {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_positions (
        ticker                  TEXT PRIMARY KEY,
        company                 TEXT NOT NULL,
        shares                  REAL NOT NULL,
        avg_cost                REAL NOT NULL,
        current_price           REAL NOT NULL DEFAULT 0,
        current_value           REAL NOT NULL DEFAULT 0,
        unrealized_pnl          REAL NOT NULL DEFAULT 0,
        score                   INTEGER NOT NULL,
        source                  TEXT NOT NULL,
        rationale               TEXT NOT NULL,
        opened_at               TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        benchmark_price_at_open REAL,
        stop_price              REAL,
        target_price            REAL,
        adjusted_conviction     TEXT
      );
      CREATE TABLE IF NOT EXISTS discovery_runs (
        id               TEXT PRIMARY KEY,
        date             TEXT NOT NULL,
        candidates_found INTEGER NOT NULL,
        passed_filter    INTEGER NOT NULL,
        positions_opened INTEGER NOT NULL,
        threshold        INTEGER NOT NULL,
        duration_ms      INTEGER NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovery_analysis_cache (
        ticker         TEXT PRIMARY KEY,
        analyzed_at    TEXT NOT NULL,
        scenarios_json TEXT NOT NULL,
        action_json    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovery_closed_positions (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker                   TEXT NOT NULL,
        company                  TEXT NOT NULL,
        shares                   REAL NOT NULL,
        avg_cost                 REAL NOT NULL,
        exit_price               REAL NOT NULL,
        realized_pnl             REAL NOT NULL,
        score                    INTEGER NOT NULL,
        source                   TEXT NOT NULL,
        rationale                TEXT NOT NULL,
        exit_reason              TEXT NOT NULL,
        opened_at                TEXT NOT NULL,
        closed_at                TEXT NOT NULL,
        benchmark_price_at_open  REAL,
        benchmark_price_at_close REAL,
        stop_price               REAL,
        target_price             REAL,
        adjusted_conviction      TEXT
      );
    `)
    this.migrateAddColumn('discovery_positions', 'benchmark_price_at_open', 'REAL')
    this.migrateAddColumn('discovery_positions', 'stop_price', 'REAL')
    this.migrateAddColumn('discovery_positions', 'target_price', 'REAL')
    this.migrateAddColumn('discovery_positions', 'adjusted_conviction', 'TEXT')
    this.migrateAddColumn('discovery_closed_positions', 'benchmark_price_at_open', 'REAL')
    this.migrateAddColumn('discovery_closed_positions', 'benchmark_price_at_close', 'REAL')
    this.migrateAddColumn('discovery_closed_positions', 'stop_price', 'REAL')
    this.migrateAddColumn('discovery_closed_positions', 'target_price', 'REAL')
    this.migrateAddColumn('discovery_closed_positions', 'adjusted_conviction', 'TEXT')
  }

  // Additive schema migration for DBs created before benchmark tracking
  // existed — CREATE TABLE IF NOT EXISTS above is a no-op on an existing
  // table, so older files need the column added explicitly.
  private migrateAddColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }

  /**
   * Look up a cached analysis result for a ticker. Returns null when no entry
   * exists or when the cached row is older than `maxAgeDays`.
   */
  getCachedAnalysis(ticker: string, maxAgeDays: number): CachedAnalysis | null {
    const row = this.db.prepare(
      'SELECT analyzed_at, scenarios_json, action_json FROM discovery_analysis_cache WHERE ticker = ?'
    ).get(ticker) as { analyzed_at: string; scenarios_json: string; action_json: string } | undefined
    if (!row) return null

    const ageMs = Date.now() - new Date(row.analyzed_at).getTime()
    if (ageMs > maxAgeDays * 86_400_000) return null

    try {
      return {
        scenarios: JSON.parse(row.scenarios_json) as DiscoveryScenario[],
        action:    JSON.parse(row.action_json) as DiscoveryAction,
      }
    } catch {
      return null
    }
  }

  setCachedAnalysis(ticker: string, analysis: CachedAnalysis): void {
    this.db.prepare(`
      INSERT INTO discovery_analysis_cache (ticker, analyzed_at, scenarios_json, action_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        analyzed_at    = excluded.analyzed_at,
        scenarios_json = excluded.scenarios_json,
        action_json    = excluded.action_json
    `).run(
      ticker,
      new Date().toISOString(),
      JSON.stringify(analysis.scenarios),
      JSON.stringify(analysis.action),
    )
  }

  openPosition(
    ticker: string,
    company: string,
    shares: number,
    avgCost: number,
    score: number,
    source: 'companies_table' | 'news_mention',
    rationale: string,
    benchmarkPriceAtOpen: number | null = null,
    riskParams: { stopPrice?: number | null; targetPrice?: number | null; adjustedConviction?: 'high' | 'medium' | 'low' | null } = {},
  ): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT OR IGNORE INTO discovery_positions
        (ticker, company, shares, avg_cost, current_price, current_value, unrealized_pnl, score, source, rationale, opened_at, updated_at, benchmark_price_at_open, stop_price, target_price, adjusted_conviction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticker, company, shares, avgCost, avgCost, shares * avgCost, 0, score, source, rationale, now, now, benchmarkPriceAtOpen,
      riskParams.stopPrice ?? null, riskParams.targetPrice ?? null, riskParams.adjustedConviction ?? null,
    )
  }

  updatePrices(prices: Record<string, number>): void {
    const stmt = this.db.prepare(`
      UPDATE discovery_positions
      SET current_price = ?, current_value = ?, unrealized_pnl = ?, updated_at = ?
      WHERE ticker = ?
    `)
    const now = new Date().toISOString()
    const update = this.db.transaction((entries: Array<[string, number]>) => {
      for (const [ticker, price] of entries) {
        const row = this.db.prepare('SELECT shares, avg_cost FROM discovery_positions WHERE ticker = ?').get(ticker) as { shares: number; avg_cost: number } | undefined
        if (!row) continue
        const currentValue = row.shares * price
        const unrealizedPnl = currentValue - (row.shares * row.avg_cost)
        stmt.run(price, currentValue, unrealizedPnl, now, ticker)
      }
    })
    update(Object.entries(prices))
  }

  /**
   * Exit a paper position: moves it from discovery_positions into
   * discovery_closed_positions with a realized P&L, so win-rate and
   * realized-vs-unrealized performance become measurable at all. Throws if
   * the ticker isn't currently open — callers should check getOpenTickers()
   * first (or catch and treat as a no-op, matching openPosition's INSERT OR
   * IGNORE idempotency style).
   */
  closePosition(ticker: string, exitPrice: number, exitReason: string, benchmarkPriceAtClose: number | null = null): DiscoveryClosedPosition {
    const row = this.db.prepare(
      'SELECT * FROM discovery_positions WHERE ticker = ?'
    ).get(ticker) as Record<string, unknown> | undefined
    if (!row) throw new Error(`closePosition: no open position for ${ticker}`)

    const shares       = row.shares as number
    const avgCost      = row.avg_cost as number
    const realizedPnl  = shares * (exitPrice - avgCost)
    const closedAt     = new Date().toISOString()
    const benchmarkAtOpen = (row.benchmark_price_at_open as number | null) ?? null
    const stopPrice           = (row.stop_price as number | null) ?? null
    const targetPrice         = (row.target_price as number | null) ?? null
    const adjustedConviction  = (row.adjusted_conviction as 'high' | 'medium' | 'low' | null) ?? null

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO discovery_closed_positions
          (ticker, company, shares, avg_cost, exit_price, realized_pnl, score, source, rationale, exit_reason, opened_at, closed_at, benchmark_price_at_open, benchmark_price_at_close, stop_price, target_price, adjusted_conviction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.ticker, row.company, shares, avgCost, exitPrice, realizedPnl,
        row.score, row.source, row.rationale, exitReason, row.opened_at, closedAt,
        benchmarkAtOpen, benchmarkPriceAtClose, stopPrice, targetPrice, adjustedConviction,
      )
      this.db.prepare('DELETE FROM discovery_positions WHERE ticker = ?').run(ticker)
    })
    tx()

    return {
      ticker:      row.ticker as string,
      company:     row.company as string,
      shares,
      avgCost,
      exitPrice,
      realizedPnl,
      score:       row.score as number,
      source:      row.source as 'companies_table' | 'news_mention',
      rationale:   row.rationale as string,
      exitReason,
      openedAt:    row.opened_at as string,
      closedAt,
      benchmarkPriceAtOpen:  benchmarkAtOpen,
      benchmarkPriceAtClose: benchmarkPriceAtClose,
      stopPrice, targetPrice, adjustedConviction,
    }
  }

  getClosedPositions(): DiscoveryClosedPosition[] {
    const rows = this.db.prepare(
      'SELECT * FROM discovery_closed_positions ORDER BY closed_at DESC'
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      ticker:      row.ticker as string,
      company:     row.company as string,
      shares:      row.shares as number,
      avgCost:     row.avg_cost as number,
      exitPrice:   row.exit_price as number,
      realizedPnl: row.realized_pnl as number,
      score:       row.score as number,
      source:      row.source as 'companies_table' | 'news_mention',
      rationale:   row.rationale as string,
      exitReason:  row.exit_reason as string,
      openedAt:    row.opened_at as string,
      closedAt:    row.closed_at as string,
      benchmarkPriceAtOpen:  (row.benchmark_price_at_open as number | null) ?? null,
      benchmarkPriceAtClose: (row.benchmark_price_at_close as number | null) ?? null,
      stopPrice:             (row.stop_price as number | null) ?? null,
      targetPrice:           (row.target_price as number | null) ?? null,
      adjustedConviction:    (row.adjusted_conviction as 'high' | 'medium' | 'low' | null) ?? null,
    }))
  }

  getOpenTickers(): Set<string> {
    const rows = this.db.prepare('SELECT ticker FROM discovery_positions').all() as Array<{ ticker: string }>
    return new Set(rows.map(r => r.ticker))
  }

  getPositions(): DiscoveryPosition[] {
    const rows = this.db.prepare('SELECT * FROM discovery_positions ORDER BY opened_at DESC').all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      ticker:        row.ticker as string,
      company:       row.company as string,
      shares:        row.shares as number,
      avgCost:       row.avg_cost as number,
      currentPrice:  row.current_price as number,
      currentValue:  row.current_value as number,
      unrealizedPnl: row.unrealized_pnl as number,
      score:         row.score as number,
      source:        row.source as 'companies_table' | 'news_mention',
      rationale:     row.rationale as string,
      openedAt:      row.opened_at as string,
      updatedAt:     row.updated_at as string,
      benchmarkPriceAtOpen: (row.benchmark_price_at_open as number | null) ?? null,
      stopPrice:            (row.stop_price as number | null) ?? null,
      targetPrice:          (row.target_price as number | null) ?? null,
      adjustedConviction:   (row.adjusted_conviction as 'high' | 'medium' | 'low' | null) ?? null,
    }))
  }

  getTotalDeployed(): number {
    const row = this.db.prepare('SELECT SUM(shares * avg_cost) AS total FROM discovery_positions').get() as { total: number | null }
    return row.total ?? 0
  }

  insertRun(run: DiscoveryRun): void {
    this.db.prepare(`
      INSERT INTO discovery_runs (id, date, candidates_found, passed_filter, positions_opened, threshold, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.date, run.candidatesFound, run.passedFilter, run.positionsOpened, run.threshold, run.durationMs, run.createdAt)
  }

  close(): void {
    this.db.close()
  }
}
