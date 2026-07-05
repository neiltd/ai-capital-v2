#!/usr/bin/env node
// Writes a morning-digest markdown that the user reads on wake.
//
// Reads from:
//   - data/pipeline-runs.db (Phase 3.2)             → stage success/fail tally + per-stage durations + orphans
//   - apps/investment-analyst-agents/briefings/$DATE.md → today's brief (UTC date — that's what the writer uses)
//   - apps/scenario-simulator/data/portfolio.db        → portfolio snapshot
//
// Writes:
//   - /tmp/morning-status.md   (latest; overwritten daily)
//   - logs/morning-status-$DATE.log  (archived; one per day)
//
// Designed to never throw — missing data → "(not available)" sections.

import Database from 'better-sqlite3'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const TODAY_UTC = new Date().toISOString().slice(0, 10)
const NOW_LOCAL = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })

const PIPELINE_DB_PATH = process.env.PIPELINE_RUNS_DB
  ?? join(ROOT, 'data', 'pipeline-runs.db')
const BRIEF_PATH       = join(ROOT, 'apps/investment-analyst-agents/briefings', `${TODAY_UTC}.md`)
const PORTFOLIO_DB     = join(ROOT, 'apps/scenario-simulator/data/portfolio.db')

const sections: string[] = []
const indicators: string[] = []   // green/red bullets for the header

// ── Pipeline health ──────────────────────────────────────────────────────────

function durationStr(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000)      return `${ms}ms`
  if (ms < 60_000)    return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

interface RunRow {
  stage:         string
  status:        string
  duration_ms:   number | null
  error_message: string | null
  started_at:    string
}

function pipelineSection(): string {
  if (!existsSync(PIPELINE_DB_PATH)) {
    indicators.push('⚪ pipeline_runs.db missing')
    return '## Pipeline health\n\n_pipeline_runs.db not found_\n'
  }
  try {
    const db = new Database(PIPELINE_DB_PATH, { readonly: true })

    // Today's top-level stages — runs started within the last 24h, no parent.
    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const rows = db.prepare(
      `SELECT stage, status, duration_ms, error_message, started_at
         FROM pipeline_runs
        WHERE parent_run_id IS NULL AND started_at >= ?
        ORDER BY started_at ASC`,
    ).all(cutoffIso) as RunRow[]

    if (rows.length === 0) {
      indicators.push('⚠️ no top-level runs in last 24h')
      db.close()
      return '## Pipeline health\n\n_No pipeline runs recorded in the last 24 hours._\n'
    }

    const success = rows.filter(r => r.status === 'success').length
    const failed  = rows.filter(r => r.status === 'failed' || r.status === 'killed' || r.status === 'timeout').length
    const running = rows.filter(r => r.status === 'running').length
    indicators.push(
      failed === 0 && running === 0
        ? `🟢 pipeline: ${success}/${rows.length} stages succeeded`
        : `🔴 pipeline: ${success} ok, ${failed} failed${running > 0 ? `, ${running} stuck running` : ''}`,
    )

    const lines = ['## Pipeline health', '']
    lines.push(`**${success} ok / ${failed} failed / ${running} running** (last 24h, top-level stages)`)
    lines.push('')
    lines.push('| Stage | Status | Duration | Notes |')
    lines.push('|---|---|---|---|')
    for (const r of rows) {
      const status = r.status === 'success'
        ? '✅'
        : r.status === 'failed' || r.status === 'killed' || r.status === 'timeout'
          ? `❌ ${r.status}`
          : `🔵 ${r.status}`
      const note = r.error_message ? `\`${r.error_message.replace(/\|/g, '\\|').slice(0, 80)}\`` : ''
      lines.push(`| ${r.stage} | ${status} | ${durationStr(r.duration_ms)} | ${note} |`)
    }

    // Capital-ingestion sub-stages — visible because YahooNews used to hang silently.
    const subRows = db.prepare(
      `SELECT stage, status, duration_ms, error_message, started_at
         FROM pipeline_runs
        WHERE parent_run_id IS NOT NULL AND started_at >= ?
        ORDER BY started_at ASC`,
    ).all(cutoffIso) as RunRow[]
    if (subRows.length > 0) {
      lines.push('')
      lines.push('### Sub-stages')
      lines.push('')
      lines.push('| Sub-stage | Status | Duration |')
      lines.push('|---|---|---|')
      for (const r of subRows) {
        const status = r.status === 'success' ? '✅' : r.status === 'running' ? '🔵 still running' : `❌ ${r.status}`
        lines.push(`| ${r.stage} | ${status} | ${durationStr(r.duration_ms)} |`)
      }
    }

    // Orphan detector — runs claiming 'running' but older than 4 hours.
    const orphans = db.prepare(
      `SELECT stage, started_at
         FROM pipeline_runs
        WHERE status = 'running' AND started_at < ?`,
    ).all(new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()) as Array<{ stage: string; started_at: string }>
    if (orphans.length > 0) {
      lines.push('')
      lines.push(`> ⚠️ ${orphans.length} run(s) stuck in \`running\` >4h — see dashboard /admin/pipeline.`)
      indicators.push(`⚠️ ${orphans.length} orphan run(s)`)
    }

    db.close()
    return lines.join('\n') + '\n'
  } catch (err) {
    indicators.push(`⚠️ pipeline check failed: ${(err as Error).message}`)
    return `## Pipeline health\n\n_Error reading pipeline_runs.db: ${(err as Error).message}_\n`
  }
}

// ── Today's brief ────────────────────────────────────────────────────────────

function briefSection(): string {
  if (!existsSync(BRIEF_PATH)) {
    indicators.push(`⚠️ today's brief missing (${TODAY_UTC}.md)`)
    return `## Today's brief\n\n_No brief at \`${BRIEF_PATH}\`._\n`
  }
  indicators.push(`🟢 brief ready (${TODAY_UTC}.md)`)
  try {
    const md = readFileSync(BRIEF_PATH, 'utf-8')

    // Extract the macro regime header (3rd line bolded after H1).
    const regimeMatch = md.match(/##\s+Macro Regime\s*\n+\*\*([^*]+)\*\*/)
    const regime = regimeMatch?.[1]?.trim() ?? 'unknown'

    // Pull the "Today's Recommended Actions" section through to next H2.
    const actionsMatch = md.match(/##\s+Today['']s Recommended Actions[\s\S]*?(?=\n##\s)/)
    const actions = actionsMatch?.[0] ?? '_Recommended Actions section not found in brief._'

    return [
      '## Today\'s brief',
      '',
      `**Regime:** ${regime}`,
      '',
      actions,
      '',
      `> Full brief: \`${BRIEF_PATH.replace(ROOT, '.')}\``,
      '',
    ].join('\n')
  } catch (err) {
    return `## Today's brief\n\n_Error reading brief: ${(err as Error).message}_\n`
  }
}

// ── Portfolio snapshot ───────────────────────────────────────────────────────

function portfolioSection(): string {
  if (!existsSync(PORTFOLIO_DB)) {
    return '## Portfolio snapshot\n\n_portfolio.db not found_\n'
  }
  try {
    const db = new Database(PORTFOLIO_DB, { readonly: true })

    interface PosRow {
      ticker: string; shares: number; avg_cost: number; current_price: number
      current_value: number; unrealized_pnl: number; currency: string
    }
    const positions = db.prepare(
      'SELECT ticker, shares, avg_cost, current_price, current_value, unrealized_pnl, currency FROM positions ORDER BY ABS(unrealized_pnl) DESC',
    ).all() as PosRow[]

    const totalValue = positions.reduce((s, p) => s + (p.current_value || 0), 0)
    const totalPnl   = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0)

    interface TradeRow {
      ticker: string; action: string; shares: number; price: number; reason: string; date: string
    }
    const recentTrades = db.prepare(
      `SELECT ticker, action, shares, price, reason, date FROM trade_log ORDER BY id DESC LIMIT 5`,
    ).all() as TradeRow[]

    const lines = ['## Portfolio snapshot', '']
    lines.push(`**${positions.length} positions** · **${totalValue.toFixed(2)} total value (mixed currencies)** · **${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} unrealized P&L**`)
    lines.push('')

    if (positions.length > 0) {
      lines.push('### Largest P&L movers')
      lines.push('')
      lines.push('| Ticker | Shares | Avg | Price | P&L |')
      lines.push('|---|---|---|---|---|')
      for (const p of positions.slice(0, 5)) {
        const pnlStr = p.unrealized_pnl >= 0 ? `+${p.unrealized_pnl.toFixed(2)}` : p.unrealized_pnl.toFixed(2)
        lines.push(`| ${p.ticker} | ${p.shares} | ${p.avg_cost.toFixed(2)} ${p.currency} | ${p.current_price.toFixed(2)} | ${pnlStr} |`)
      }
    }

    if (recentTrades.length > 0) {
      lines.push('')
      lines.push('### Recent trades (last 5)')
      lines.push('')
      for (const t of recentTrades) {
        lines.push(`- ${t.date} **${t.action.toUpperCase()}** ${t.shares} ${t.ticker} @ $${t.price.toFixed(4)}${t.reason ? ` — _${t.reason}_` : ''}`)
      }
    }

    db.close()
    return lines.join('\n') + '\n'
  } catch (err) {
    return `## Portfolio snapshot\n\n_Error: ${(err as Error).message}_\n`
  }
}

// ── Compose ──────────────────────────────────────────────────────────────────

// Sections built in dependency order so indicators populate from each.
const pipeline   = pipelineSection()
const brief      = briefSection()
const portfolio  = portfolioSection()

const header = [
  `# Morning status — ${TODAY_UTC}`,
  '',
  `_Generated at ${NOW_LOCAL}_`,
  '',
  ...indicators.map(l => `- ${l}`),
  '',
  '---',
  '',
].join('\n')

const body = [header, pipeline, brief, portfolio].join('\n')

writeFileSync('/tmp/morning-status.md', body, 'utf-8')
mkdirSync(join(ROOT, 'logs'), { recursive: true })
writeFileSync(join(ROOT, 'logs', `morning-status-${TODAY_UTC}.log`), body, 'utf-8')

console.log(`[morning-status] written to /tmp/morning-status.md (${body.length} bytes)`)
