// Loader for /world. Real disk reads (no fetch — server component), per
// docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// Source: world-intelligence-data-hub-/exports/world-map/intelligence.json
// (schema 2.0 — events, storylines, countrySignals; all real fields).
//
// Scoped down from the design mockup: the mockup's per-event "consumption
// state" (fedRegime / briefingRank / briefingQuote — which events entered
// today's regime-analysis context block or briefing top-5) has no real
// counter anywhere in the pipeline to source it from, so it's dropped
// rather than fabricated. Same for the memory-agent causal-chain/
// counterfactual enrichment (intelligence/outputs/events/<date>.json,
// title-joined in investment-analyst-agents/src/briefing/world-storylines.ts)
// — porting that join is real future work, not done here; the List tab
// shows the base event fields only.

import { readWorldIntel } from '@/lib/data'
import type { WorldEvent, WorldStoryline, WorldCountrySignal } from '@/types'

export interface WorldViewModel {
  date: string
  generatedAt: string
  eventCount: number
  uniqueSourceCount: number
  reviewExcludedCount: number
  events: WorldEvent[]
  storylines: WorldStoryline[]
  countrySignals: WorldCountrySignal[]
}

export function loadWorld(): WorldViewModel | null {
  let w: ReturnType<typeof readWorldIntel>
  try { w = readWorldIntel() } catch { return null }
  if (!w) return null

  return {
    date: w.date,
    generatedAt: w.generatedAt ?? w.date,
    eventCount: w.eventCount ?? w.events.length,
    uniqueSourceCount: w.uniqueSourceCount ?? 0,
    reviewExcludedCount: w.reviewExcludedCount ?? 0,
    events: [...w.events].sort((a, b) => b.severity - a.severity),
    storylines: [...(w.storylines ?? [])].sort((a, b) => b.maxSeverity - a.maxSeverity),
    countrySignals: w.countrySignals,
  }
}
