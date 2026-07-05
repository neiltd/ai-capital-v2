import { writeFileSync } from 'fs'
import type { MacroRegime, PropagationSignal, CompanyHealth } from '../types.js'

function signalLine(s: PropagationSignal): string {
  return `- ${s.sourceTicker} → ${s.targetTicker} (${s.signalType}, ${s.direction}, ${s.magnitude}): ${s.description}`
}

export function generateReport(
  date: string,
  regime: MacroRegime,
  signals: PropagationSignal[],
  health: CompanyHealth[],
  outputPath: string,
): string {
  const positive = signals.filter(s => s.sentiment === 'positive')
  const negative = signals.filter(s => s.sentiment === 'negative')
  const neutral  = signals.filter(s => s.sentiment === 'neutral')

  const lines: string[] = [
    `# AI Analysis — ${date}`,
    '',
    `## Macro Regime: ${regime.regime} (${regime.confidence} confidence)`,
    regime.rationale,
    '',
    '**Key Indicators:**',
    ...regime.keyIndicators.map(i => `- ${i}`),
    '',
    `## Propagation Signals (${signals.length})`,
  ]

  if (positive.length > 0) { lines.push('', '### Positive', ...positive.map(signalLine)) }
  if (negative.length > 0) { lines.push('', '### Negative', ...negative.map(signalLine)) }
  if (neutral.length  > 0) { lines.push('', '### Neutral',  ...neutral.map(signalLine))  }
  if (signals.length  === 0) { lines.push('', '_No active propagation signals for this period._') }

  lines.push(
    '',
    '## Company Health Snapshot',
    '| Ticker | Company | Health |',
    '|--------|---------|--------|',
    ...health.map(h => `| ${h.ticker} | ${h.company} | ${h.healthScore} |`),
  )

  const content = lines.join('\n')
  writeFileSync(outputPath, content, 'utf-8')
  return content
}
