// DCA dip-buy target ladder → a deterministic "🎯 DCA Targets" section
// appended to every daily briefing. Kept in sync with the user's TradingView
// price alerts. Rendered deterministically (NOT via the LLM) so the exact
// price levels are always accurate and never reworded/dropped.
//
// Live prices are fetched best-effort from Yahoo to show distance-to-trigger;
// a failed fetch just omits the distance for that row — the target still shows.

import { readFileSync, existsSync } from 'fs'

/**
 * The unit a Yahoo quote is actually denominated in. This is NOT the same thing
 * as `DcaTarget.currency` — see the note on that field.
 *   'USD' | 'THB' → a price, rendered with the matching symbol
 *   'index'       → index points (e.g. ^SET50.BK), which are not money
 *   'rate'        → an FX pair (e.g. THB=X), which is a rate, not a price
 */
export type QuoteUnit = 'USD' | 'THB' | 'index' | 'rate'

export interface DcaTarget {
  label:       string
  yahooSymbol: string
  target:      number
  direction:   'below' | 'above'
  /**
   * Which CASH POT funds this buy ('USD' = CASH_USD ladder, 'THB' = the baht
   * DCA sleeve). It is deliberately NOT the currency of the quote: the baht-
   * funded DIME rows track USD-listed proxies (KKP US500-UH-E → VOO, KKP
   * NDQ100-UH-E → QQQ, VEA → VEA), so their live price is in dollars even
   * though the money spent is baht. Rendering the quote with this field is the
   * bug fixed on 2026-08-25 — it printed VOO's $701.83 as "฿701.83".
   */
  currency:    string
  /** Unit of the Yahoo quote. Derived from `yahooSymbol` when omitted. */
  quoteCurrency?: QuoteUnit
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
 * What unit is this symbol quoted in? An explicit `quoteCurrency` always wins;
 * otherwise it is derived from Yahoo's own symbol conventions, so a new ladder
 * row gets the right unit without anyone having to remember to set the field.
 */
export function resolveQuoteUnit(t: Pick<DcaTarget, 'yahooSymbol' | 'quoteCurrency'>): QuoteUnit {
  if (t.quoteCurrency) return t.quoteCurrency
  const sym = t.yahooSymbol
  if (sym.endsWith('=X'))  return 'rate'    // FX pair — THB=X is baht PER dollar
  if (sym.startsWith('^')) return 'index'   // index level — points, not money
  if (sym.endsWith('.BK')) return 'THB'     // SET-listed — quoted in baht
  return 'USD'                              // everything else on Yahoo defaults to USD
}

/** Render a quoted number in its own unit — never in the funding bucket's unit. */
export function formatQuote(value: number, unit: QuoteUnit): string {
  switch (unit) {
    case 'THB':   return `฿${value.toFixed(2)}`
    case 'index': return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pts`
    case 'rate':  return `฿${value.toFixed(2)}/$`
    default:      return `$${value.toFixed(2)}`
  }
}

/** Human label for the cash pot a row draws on. */
export function fundingBucketLabel(currency: string): string {
  return currency === 'THB' ? '฿ baht' : '$ USD'
}

/**
 * Build one markdown table row. Pure (price is passed in, not fetched) so the
 * exact rendering of every ladder level is unit-testable without the network.
 */
export function buildDcaRow(t: DcaTarget, px: number | null): string {
  const unit      = resolveQuoteUnit(t)
  const targetStr = formatQuote(t.target, unit)
  let priceStr = '—'
  let distStr  = '—'
  let status   = ''
  if (px !== null) {
    priceStr = formatQuote(px, unit)
    // absolute gap between current price and the trigger, as % of current
    const distPct = Math.abs((px - t.target) / px) * 100
    const hit = t.direction === 'below' ? px <= t.target : px >= t.target
    if (hit) {
      status  = '🟢 **TRIGGERED**'
      distStr = 'at/through level'
    } else {
      distStr = `${distPct.toFixed(1)}% away`
    }
  }
  return `| ${t.label} | ${priceStr} | ${targetStr} | ${distStr} | ${fundingBucketLabel(t.currency)} | ${t.buyNow} | ${t.buyDeeper} | ${t.note}${status ? ' ' + status : ''} |`
}

/**
 * Render the DCA target ladder as a markdown section, enriched best-effort with
 * live prices and distance-to-trigger. Returns '' if there are no targets.
 */
export async function renderDcaTargetsSection(ladder: DcaLadder): Promise<string> {
  const { budget, targets } = ladder
  if (targets.length === 0) return ''

  const prices = await Promise.all(targets.map(t => fetchQuote(t.yahooSymbol)))

  const rows = targets.map((t, i) => buildDcaRow(t, prices[i]))

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
    '*"Current" and "Buy ≤" are quoted in the **instrument\'s own unit** — the baht-funded DIME rows track USD-listed proxies (KKP US500-UH-E → VOO, KKP NDQ100-UH-E → QQQ), so their levels are in dollars. "Funded from" is the cash pot the money comes out of.*',
    '',
    '| Instrument | Current | Buy ≤ | Distance | Funded from | Buy now | Deeper dip | Note |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    ...budgetLines,
    '',
  ].join('\n')
}
