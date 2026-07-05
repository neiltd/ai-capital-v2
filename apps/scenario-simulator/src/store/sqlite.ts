import Database from 'better-sqlite3'
import type { SimulationRun, Scenario, PortfolioAction } from '../types.js'

export interface SimulationStore {
  insertRun(run: SimulationRun): void
  insertScenario(scenario: Scenario): void
  insertAction(action: PortfolioAction): void
  getLatestRun(): SimulationRun | null
  getScenariosByRunId(runId: string): Scenario[]
  getActionsByRunId(runId: string): PortfolioAction[]
  close(): void
}

export function createSimulationStore(dbPath: string): SimulationStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS simulation_runs (
      id             TEXT PRIMARY KEY,
      date           TEXT NOT NULL,
      type           TEXT NOT NULL,
      trigger        TEXT,
      scenario_count INTEGER NOT NULL,
      action_count   INTEGER NOT NULL,
      duration_ms    INTEGER NOT NULL,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL,
      date              TEXT NOT NULL,
      scenario_type     TEXT NOT NULL,
      title             TEXT NOT NULL,
      narrative         TEXT NOT NULL,
      time_horizon      TEXT NOT NULL,
      probability       INTEGER NOT NULL,
      regime_transition TEXT,
      triggers          TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_actions (
      id                     TEXT PRIMARY KEY,
      run_id                 TEXT NOT NULL,
      scenario_id            TEXT NOT NULL,
      ticker                 TEXT NOT NULL,
      action                 TEXT NOT NULL,
      conviction             TEXT NOT NULL,
      allocation_change_pct  INTEGER NOT NULL,
      rationale              TEXT NOT NULL,
      created_at             TEXT NOT NULL
    );
  `)

  return {
    insertRun(run) {
      db.prepare(`
        INSERT INTO simulation_runs (id, date, type, trigger, scenario_count, action_count, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.date, run.type, run.trigger, run.scenarioCount, run.actionCount, run.durationMs, run.createdAt)
    },

    insertScenario(s) {
      db.prepare(`
        INSERT INTO scenarios (id, run_id, date, scenario_type, title, narrative, time_horizon, probability, regime_transition, triggers, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.runId, s.date, s.scenarioType, s.title, s.narrative, s.timeHorizon, s.probability, s.regimeTransition, JSON.stringify(s.triggers), s.createdAt)
    },

    insertAction(a) {
      db.prepare(`
        INSERT INTO portfolio_actions (id, run_id, scenario_id, ticker, action, conviction, allocation_change_pct, rationale, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.runId, a.scenarioId, a.ticker, a.action, a.conviction, a.allocationChangePct, a.rationale, a.createdAt)
    },

    getLatestRun() {
      type Row = { id: string; date: string; type: string; trigger: string | null; scenario_count: number; action_count: number; duration_ms: number; created_at: string }
      const row = db.prepare('SELECT * FROM simulation_runs ORDER BY created_at DESC LIMIT 1').get() as Row | undefined
      if (!row) return null
      return {
        id: row.id, date: row.date, type: row.type as SimulationRun['type'],
        trigger: row.trigger, scenarioCount: row.scenario_count,
        actionCount: row.action_count, durationMs: row.duration_ms, createdAt: row.created_at,
      }
    },

    getScenariosByRunId(runId) {
      type Row = { id: string; run_id: string; date: string; scenario_type: string; title: string; narrative: string; time_horizon: string; probability: number; regime_transition: string | null; triggers: string; created_at: string }
      return (db.prepare('SELECT * FROM scenarios WHERE run_id = ?').all(runId) as Row[]).map(r => ({
        id: r.id, runId: r.run_id, date: r.date,
        scenarioType: r.scenario_type as Scenario['scenarioType'],
        title: r.title, narrative: r.narrative, timeHorizon: r.time_horizon,
        probability: r.probability, regimeTransition: r.regime_transition,
        triggers: JSON.parse(r.triggers) as string[],
        createdAt: r.created_at,
      }))
    },

    getActionsByRunId(runId) {
      type Row = { id: string; run_id: string; scenario_id: string; ticker: string; action: string; conviction: string; allocation_change_pct: number; rationale: string; created_at: string }
      return (db.prepare('SELECT * FROM portfolio_actions WHERE run_id = ?').all(runId) as Row[]).map(r => ({
        id: r.id, runId: r.run_id, scenarioId: r.scenario_id, ticker: r.ticker,
        action: r.action as PortfolioAction['action'],
        conviction: r.conviction as PortfolioAction['conviction'],
        allocationChangePct: r.allocation_change_pct,
        rationale: r.rationale, createdAt: r.created_at,
      }))
    },

    close() { db.close() },
  }
}
