// DCA dip-buy target ladder → a deterministic "🎯 DCA Targets" section
// appended to every daily briefing. Kept in sync with the user's TradingView
// price alerts. Rendered deterministically (NOT via the LLM) so the exact
// price levels are always accurate and never reworded/dropped.
//
// Live prices are fetched best-effort from Yahoo to show distance-to-trigger;
// a failed fetch just omits the distance for that row — the target still shows.

import { readFileSync, existsSync } from 'fs'

export interface DcaTarget {
  label:       string
  yahooSymbol: string
  target:      number
  direction:   'below' | 'above'
  currency:    string
  buyNow:      string   // tranche to buy when the alert first fires (e.g. "$1,750", "฿30,000", "convert", "watch")
  buyDeeper:   string   // second tranche on a further dip, or "—"
  note:        string
}

export interface DcaBudget {
  usdCap: string
  thbCap: string
  note:   string
}

interface DcaTargetsConfig {
  generatedAt?: string
  budget?:      DcaBudget
  targets:      DcaTarget[]
}

export interface DcaLadder {
  budget:  DcaBudget | null
  targets: DcaTarget[]
}

export function loadDcaTargets(path: string): DcaLadder {
  if (!existsSync(path)) return { budget: null, targets: [] }
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8')) as DcaTargetsConfig
    return {
      budget:  cfg.budget ?? null,
      targets: Array.isArray(cfg.targets) ? cfg.targets : [],
    }
  } catch {
    return { budget: null, targets: [] }
  }
}

async function fetchQuote(yahooSymbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } }
    const px = data.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof px === 'number' && px > 0 ? px : null
  } catch {
    return null
  }
}

/**
 * Render the DCA target ladder as a markdown section, enriched best-effort with
 * live prices and distance-to-trigger. Returns '' if there are no targets.
 */
export async function renderDcaTargetsSection(ladder: DcaLadder): Promise<string> {
  const { budget, targets } = ladder
  if (targets.length === 0) return ''

  const prices = await Promise.all(targets.map(t => fetchQuote(t.yahooSymbol)))

  const rows = targets.map((t, i) => {
    const px = prices[i]
    const cur = t.currency === 'THB' ? '฿' : '$'
    const targetStr = `${cur}${t.target}`
    let priceStr = '—'
    let distStr = '—'
    let status = ''
    if (px !== null) {
      priceStr = `${cur}${px.toFixed(2)}`
      // absolute gap between current price and the trigger, as % of current
      const distPct = Math.abs((px - t.target) / px) * 100
      const hit = t.direction === 'below' ? px <= t.target : px >= t.target
      if (hit) {
        status = '🟢 **TRIGGERED**'
        distStr = 'at/through level'
      } else {
        distStr = `${distPct.toFixed(1)}% away`
      }
    }
    return `| ${t.label} | ${priceStr} | ${targetStr} | ${distStr} | ${t.buyNow} | ${t.buyDeeper} | ${t.note}${status ? ' ' + status : ''} |`
  })

  const budgetLines = budget
    ? [
        '',
        `**Round budget:** deploy up to **${budget.usdCap}** (USD bucket) + **${budget.thbCap}** (THB bucket). ${budget.note}`,
      ]
    : []

  return [
    '',
    '---',
    '',
    '## 🎯 DCA Targets',
    '',
    '*Dip-buy ladder — synced with your TradingView alerts. "Distance" = how far current price is above the trigger. When an alert fires, buy the "Buy now" tranche; add the "Deeper dip" tranche on a further ~3-4% drop. 🟢 TRIGGERED = at/through your level.*',
    '',
    '| Instrument | Current | Buy ≤ | Distance | Buy now | Deeper dip | Note |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    ...budgetLines,
    '',
  ].join('\n')
}
