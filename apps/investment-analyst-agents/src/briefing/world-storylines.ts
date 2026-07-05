// Joins the briefing-time WorldIntelJSON events back to the raw world-intel
// event files so we can pull memory-agent enrichments (causal_links,
// expected_consequences, counterfactual) into the briefing prompt.
//
// The flattened worldIntel.events only carries title/summary/severity; the
// rich graph fields live on the original event files under
// apps/world-intelligence-data-hub-/intelligence/outputs/events/<date>.json.

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

interface RawEventGraph {
  causal_links?: Array<{ event_id: string; kind: string; confidence: number; rationale: string }>
  expected_consequences?: string[]
  causal_confidence?: number
  counterfactual?: string
}

interface RawEvent {
  event_id: string
  event:    { title: string; summary: string; severity: number; event_type: string }
  graph?:   RawEventGraph
  identity?: { first_seen_at?: string }
}

interface EnrichedWorldEvent {
  title:                string
  severity:             string | number
  summary:              string
  countries?:           string[]
  // ── memory-agent enrichment, only present when memory-agent has run ─────
  causalConfidence?:    number
  counterfactual?:      string
  causedByRationales:   string[]   // top 2 strongest caused_by rationales
  expectedConsequences: string[]   // top 3 predictions
  // ── trade-graph integration ──────────────────────────────────────────────
  affectedChokepoints:  string[]   // chokepoint ids detected from title/summary
  affectedTickers:      string[]   // portfolio tickers exposed via country OR chokepoint
}

function listRecentEventFiles(eventsDir: string, days: number): string[] {
  if (!existsSync(eventsDir)) return []
  return readdirSync(eventsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-days)
    .map(f => join(eventsDir, f))
}

function workspaceRoot(): string {
  let dir = process.cwd()
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

function eventsDir(): string {
  return join(workspaceRoot(), 'apps', 'world-intelligence-data-hub-', 'intelligence', 'outputs', 'events')
}

/**
 * Loads raw events from the last `days` daily files, returning a map keyed by
 * normalized title (lowercase trim) so we can match flattened briefing events.
 */
function buildTitleIndex(days: number): Map<string, RawEvent> {
  const out = new Map<string, RawEvent>()
  for (const file of listRecentEventFiles(eventsDir(), days)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as RawEvent[] | { events?: RawEvent[] }
      const arr: RawEvent[] = Array.isArray(raw) ? raw : (raw.events ?? [])
      for (const e of arr) {
        const key = (e.event?.title ?? '').trim().toLowerCase()
        if (key) out.set(key, e)
      }
    } catch { /* skip unreadable files */ }
  }
  return out
}

// Inlined from /api/trade-graph/events — keep in sync if needles change.
// Tagging the same way the worldmap layer does so the briefing surfaces a
// consistent "affected chokepoint" picture vs what the user sees on the map.
const CHOKEPOINT_PATTERNS: Array<{ id: string; needles: string[] }> = [
  { id: 'hormuz',            needles: ['hormuz', 'persian gulf', 'strait of hormuz'] },
  { id: 'suez',              needles: ['suez', 'suez canal'] },
  { id: 'malacca',           needles: ['malacca', 'strait of malacca'] },
  { id: 'panama',            needles: ['panama canal'] },
  { id: 'bab_el_mandeb',     needles: ['bab-el-mandeb', 'bab el-mandeb', 'red sea', 'houthi'] },
  { id: 'bosphorus',         needles: ['bosphorus', 'bosphorus strait'] },
  { id: 'cape_of_good_hope', needles: ['cape of good hope', 'cape town shipping'] },
  { id: 'drake',             needles: ['drake passage', 'cape horn'] },
  { id: 'taiwan_strait',     needles: ['taiwan strait', 'taiwan blockade'] },
  { id: 'english_channel',   needles: ['english channel'] },
]

function detectChokepoints(title: string, summary: string): string[] {
  const blob = `${title} ${summary}`.toLowerCase()
  return CHOKEPOINT_PATTERNS
    .filter(({ needles }) => needles.some(n => blob.includes(n)))
    .map(({ id }) => id)
}

/**
 * Enrich a list of flattened world-intel events (from WorldIntelJSON) with
 * memory-agent graph fields + trade-graph affected-ticker analysis when
 * available. Falls back to the flat data when no enrichment exists yet, so
 * the briefing always renders.
 *
 * Trade exposure is computed via the optional `tradeExposureLookup` which the
 * caller can pre-load from pg (see loadTradeExposureLookup). Without it the
 * affectedTickers field is empty — the briefing block stays valid.
 */
export function enrichWorldEvents<E extends { title: string; severity: string | number; summary: string; countries?: string[] }>(
  events: E[],
  opts:   { lookbackDays?: number; tradeExposureLookup?: TradeExposureLookup } = {},
): EnrichedWorldEvent[] {
  const lookback = opts.lookbackDays ?? 7
  const index = buildTitleIndex(lookback)
  const lookup = opts.tradeExposureLookup

  return events.map(e => {
    const raw = index.get(e.title.trim().toLowerCase())
    const graph = raw?.graph
    const causedByLinks = (graph?.causal_links ?? [])
      .filter(l => l.kind === 'caused_by')
      .sort((a, b) => b.confidence - a.confidence)
    const affectedChokepoints = detectChokepoints(e.title, e.summary ?? '')
    const affectedTickers = lookup
      ? lookup.tickersAffectedBy({ countries: e.countries ?? [], chokepoints: affectedChokepoints })
      : []
    return {
      title:                e.title,
      severity:             e.severity,
      summary:              e.summary,
      countries:            e.countries,
      causalConfidence:     graph?.causal_confidence,
      counterfactual:       graph?.counterfactual,
      causedByRationales:   causedByLinks.slice(0, 2).map(l => l.rationale),
      expectedConsequences: (graph?.expected_consequences ?? []).slice(0, 3),
      affectedChokepoints,
      affectedTickers,
    }
  })
}

// ── Trade-exposure lookup ────────────────────────────────────────────────────
// Loads the (country → tickers) and (chokepoint → tickers) indexes once from
// pg, then answers per-event exposure queries synchronously.

export interface TradeExposureLookup {
  tickersAffectedBy(opts: { countries: string[]; chokepoints: string[] }): string[]
}

export async function loadTradeExposureLookup(): Promise<TradeExposureLookup | null> {
  if (!process.env.DATABASE_URL) return null
  // Late import — only depend on @common/db when we're actually going to use it.
  const { getPool } = await import('@common/db/pool')
  const pool = getPool()

  // Country → tickers (only deps with criticality 1-2 to keep signal tight).
  // A ticker shows up for an affected country only if it has a "lethal" or
  // "essential" dep there. Lower-criticality deps drown out the signal.
  const countryRows = await pool.query<{ country_iso3: string; ticker: string }>(
    `select country_iso3, ticker from trade.ticker_dependencies where criticality <= 2`,
  )
  const byCountry = new Map<string, Set<string>>()
  for (const r of countryRows.rows) {
    const set = byCountry.get(r.country_iso3) ?? new Set<string>()
    set.add(r.ticker)
    byCountry.set(r.country_iso3, set)
  }

  // Chokepoint → tickers — DIRECT matches only. A ticker is affected by Hormuz
  // only if the LLM-derived dep names chokepoint_id='hormuz'. Going via
  // chokepoint_routes joined with country deps balloons the result to ~116
  // tickers per event, which is useless for prioritization.
  const chokeRows = await pool.query<{ chokepoint_id: string; ticker: string }>(
    `select chokepoint_id, ticker
       from trade.ticker_dependencies
      where chokepoint_id is not null and criticality <= 3`,
  )
  const byChokepoint = new Map<string, Set<string>>()
  for (const r of chokeRows.rows) {
    const set = byChokepoint.get(r.chokepoint_id) ?? new Set<string>()
    set.add(r.ticker)
    byChokepoint.set(r.chokepoint_id, set)
  }

  return {
    tickersAffectedBy: ({ countries, chokepoints }) => {
      const out = new Set<string>()
      for (const c of countries)    (byCountry.get(c)    ?? new Set<string>()).forEach(t => out.add(t))
      for (const cp of chokepoints) (byChokepoint.get(cp) ?? new Set<string>()).forEach(t => out.add(t))
      const arr = Array.from(out)
      arr.sort()
      return arr
    },
  }
}

/** Render an EnrichedWorldEvent as a brief text block for the LLM prompt. */
export function renderEnrichedEventBlock(e: EnrichedWorldEvent): string {
  const lines: string[] = []
  lines.push(`  [sev ${e.severity}] ${e.title}`)
  lines.push(`    Summary: ${e.summary.slice(0, 220)}`)
  if (e.causedByRationales.length > 0) {
    lines.push(`    Why now (causal chain):`)
    for (const r of e.causedByRationales) lines.push(`      - ${r}`)
  }
  if (e.counterfactual) {
    lines.push(`    Counterfactual (if this hadn't happened): ${e.counterfactual.slice(0, 350)}`)
  }
  if (e.expectedConsequences.length > 0) {
    lines.push(`    Expected near-term consequences:`)
    for (const c of e.expectedConsequences) lines.push(`      - ${c}`)
  }
  if (e.affectedChokepoints.length > 0) {
    lines.push(`    Affected chokepoints: ${e.affectedChokepoints.join(', ')}`)
  }
  if (e.affectedTickers.length > 0) {
    const head = e.affectedTickers.slice(0, 12).join(', ')
    const tail = e.affectedTickers.length > 12 ? ` (+${e.affectedTickers.length - 12} more)` : ''
    lines.push(`    Affected portfolio tickers (${e.affectedTickers.length}): ${head}${tail}`)
  }
  if (typeof e.causalConfidence === 'number') {
    lines.push(`    Causal confidence: ${e.causalConfidence.toFixed(2)}`)
  }
  return lines.join('\n')
}
