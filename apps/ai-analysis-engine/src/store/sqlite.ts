import Database from 'better-sqlite3'
import type { MacroRegime, PropagationSignal, AnalysisRun } from '../types.js'

export interface AnalysisStore {
  insertRegime(regime: MacroRegime): void
  getLatestRegime(): MacroRegime | null
  getRegimesByDate(date: string): MacroRegime[]
  insertSignal(signal: PropagationSignal): void
  getSignalsByDate(date: string): PropagationSignal[]
  insertRun(run: AnalysisRun): void
  close(): void
}

export function createAnalysisStore(dbPath: string): AnalysisStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS macro_regimes (
      id               TEXT PRIMARY KEY,
      date             TEXT NOT NULL,
      regime           TEXT NOT NULL,
      confidence       TEXT NOT NULL,
      rationale        TEXT NOT NULL,
      key_indicators   TEXT NOT NULL,
      affected_tickers TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS propagation_signals (
      id             TEXT PRIMARY KEY,
      date           TEXT NOT NULL,
      source_ticker  TEXT NOT NULL,
      target_ticker  TEXT NOT NULL,
      signal_type    TEXT NOT NULL,
      direction      TEXT NOT NULL,
      magnitude      TEXT NOT NULL,
      sentiment      TEXT NOT NULL,
      description    TEXT NOT NULL,
      evidence_quote TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id                       TEXT PRIMARY KEY,
      date                     TEXT NOT NULL,
      companies_analyzed       INTEGER NOT NULL,
      regime_id                TEXT NOT NULL,
      propagation_signal_count INTEGER NOT NULL,
      duration_ms              INTEGER NOT NULL,
      created_at               TEXT NOT NULL
    );
  `)

  function rowToRegime(row: Record<string, unknown>): MacroRegime {
    return {
      id:              row.id as string,
      date:            row.date as string,
      regime:          row.regime as string,
      confidence:      row.confidence as MacroRegime['confidence'],
      rationale:       row.rationale as string,
      keyIndicators:   JSON.parse(row.key_indicators as string),
      affectedTickers: JSON.parse(row.affected_tickers as string),
      createdAt:       row.created_at as string,
    }
  }

  function rowToSignal(row: Record<string, unknown>): PropagationSignal {
    return {
      id:            row.id as string,
      date:          row.date as string,
      sourceTicker:  row.source_ticker as string,
      targetTicker:  row.target_ticker as string,
      signalType:    row.signal_type as PropagationSignal['signalType'],
      direction:     row.direction as PropagationSignal['direction'],
      magnitude:     row.magnitude as PropagationSignal['magnitude'],
      sentiment:     row.sentiment as PropagationSignal['sentiment'],
      description:   row.description as string,
      evidenceQuote: row.evidence_quote as string | null,
      createdAt:     row.created_at as string,
    }
  }

  return {
    insertRegime(r) {
      db.prepare(`
        INSERT INTO macro_regimes
          (id, date, regime, confidence, rationale, key_indicators, affected_tickers, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.id, r.date, r.regime, r.confidence, r.rationale,
             JSON.stringify(r.keyIndicators), JSON.stringify(r.affectedTickers), r.createdAt)
    },
    getLatestRegime() {
      const row = db.prepare(
        'SELECT * FROM macro_regimes ORDER BY created_at DESC LIMIT 1'
      ).get() as Record<string, unknown> | undefined
      return row ? rowToRegime(row) : null
    },
    getRegimesByDate(date) {
      return (db.prepare('SELECT * FROM macro_regimes WHERE date = ? ORDER BY created_at')
        .all(date) as Record<string, unknown>[]).map(rowToRegime)
    },
    insertSignal(s) {
      db.prepare(`
        INSERT INTO propagation_signals
          (id, date, source_ticker, target_ticker, signal_type, direction,
           magnitude, sentiment, description, evidence_quote, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.date, s.sourceTicker, s.targetTicker, s.signalType,
             s.direction, s.magnitude, s.sentiment, s.description, s.evidenceQuote, s.createdAt)
    },
    getSignalsByDate(date) {
      return (db.prepare('SELECT * FROM propagation_signals WHERE date = ? ORDER BY created_at')
        .all(date) as Record<string, unknown>[]).map(rowToSignal)
    },
    insertRun(run) {
      db.prepare(`
        INSERT INTO analysis_runs
          (id, date, companies_analyzed, regime_id, propagation_signal_count, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.date, run.companiesAnalyzed, run.regimeId,
             run.propagationSignalCount, run.durationMs, run.createdAt)
    },
    close() { db.close() },
  }
}
