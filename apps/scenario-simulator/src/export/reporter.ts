import { writeFileSync } from 'fs'
import type { Position, Scenario, PortfolioAction } from '../types.js'

function fmtPnl(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
}

function portfolioTable(positions: Position[]): string {
  if (positions.length === 0) return '_No positions recorded._\n'
  const header = '| Ticker | Shares | Avg Cost | Price | Value | Unrealized P&L |\n|--------|--------|----------|-------|-------|----------------|\n'
  const rows   = positions.map(p =>
    `| ${p.ticker} | ${p.shares} | $${p.avgCost.toFixed(2)} | $${p.currentPrice.toFixed(2)} | $${p.currentValue.toFixed(2)} | ${fmtPnl(p.unrealizedPnl)} |`
  ).join('\n')
  return header + rows + '\n'
}

function typeLabel(t: Scenario['scenarioType']): string {
  if (t === 'whatif') return 'What-If'
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function scenarioSection(scenario: Scenario, actions: PortfolioAction[]): string {
  const lines: string[] = [
    `## ${typeLabel(scenario.scenarioType)}: ${scenario.title} (${scenario.probability}%, ${scenario.timeHorizon})`,
    '',
    scenario.narrative,
    '',
    '**Triggers:**',
    ...scenario.triggers.map(t => `- ${t}`),
    '',
    `**Regime Transition:** ${scenario.regimeTransition ? `→ ${scenario.regimeTransition}` : 'No change expected'}`,
  ]

  if (actions.length > 0) {
    lines.push('', '**Portfolio Actions:**')
    for (const a of actions) {
      const pct = a.allocationChangePct !== 0 ? ` ${a.allocationChangePct > 0 ? '+' : ''}${a.allocationChangePct}%` : ''
      lines.push(`- ${a.ticker}: **${a.action}${pct}** (${a.conviction} conviction) — ${a.rationale}`)
    }
  }

  return lines.join('\n')
}

export function generateReport(
  date: string,
  scenarios: Scenario[],
  actions: PortfolioAction[],
  positions: Position[],
  outputPath: string,
): void {
  const actionsByScenario = new Map<string, PortfolioAction[]>()
  for (const a of actions) {
    const list = actionsByScenario.get(a.scenarioId) ?? []
    list.push(a)
    actionsByScenario.set(a.scenarioId, list)
  }

  const parts: string[] = [
    `# Scenario Simulation — ${date}`,
    '',
    '## Current Portfolio',
    portfolioTable(positions),
  ]

  for (const s of scenarios) {
    parts.push(scenarioSection(s, actionsByScenario.get(s.id) ?? []))
    parts.push('')
  }

  writeFileSync(outputPath, parts.join('\n'), 'utf-8')
}
