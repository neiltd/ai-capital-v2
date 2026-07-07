// /world — World intelligence. (Supersedes screens/specs/world-intel.md.)
//
// Layout:
//   ┌ Consumer strip: this feed → exactly 2 consumers (regime · briefing) ──┐
//   ├ Tabs: List ⇄ Map ⇄ Storylines   │ Event inspector (shared, sticky)   ┤
//   └──────────────────────────────────────────────────────────────────────────┘
//
// THE DESIGN POINT: world-intel does NOT flow through the general
// search/ingestion pipeline. It feeds two specific consumers directly —
// ai-analysis-engine's regime analysis (dedicated "World Intelligence"
// context block) and the briefing agent's top-5-events section
// (world-storylines.ts). This screen makes that linkage visible: every event
// carries `regime` / `briefing #n` consumption chips, the inspector shows
// "where this event went" with the exact briefing sentence that cited it,
// and un-consumed events are explicitly labeled — so this reads as the
// system's sensory input, not a disconnected news feed.

import { loadWorld } from './data'
import { WorldTabs } from './world-tabs'
import { AsOf, Label } from '../_shared/ui'

export default async function WorldPage() {
  const w = await loadWorld()

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">World intelligence</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {w.eventCount} events · {w.uniqueSourceCount} sources · {w.reviewExcludedCount} excluded
            by review — the feed that today&apos;s regime call and briefing were built from.
          </p>
        </div>
        <AsOf iso={w.generatedAt} />
      </header>

      {/* ---------------------- the two-consumer linkage strip ---------------------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-card border border-hairline bg-surface px-4 py-3">
          <Label>Consumer 1 · regime analysis</Label>
          <div className="mt-1 text-[14px] text-ink">
            <span className="tnum font-semibold">{w.consumers.regime.fed} of {w.consumers.regime.of}</span>{' '}
            events entered today&apos;s “World Intelligence” context block
          </div>
          <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
            bar: {w.consumers.regime.bar} → <a href="/today" className="text-accent">{w.consumers.regime.output}</a>
          </p>
        </div>
        <div className="rounded-card border border-hairline bg-surface px-4 py-3">
          <Label>Consumer 2 · briefing top-5</Label>
          <div className="mt-1 text-[14px] text-ink">
            <span className="tnum font-semibold">{w.consumers.briefing.fed} of {w.consumers.briefing.of}</span>{' '}
            events selected + enriched (causal chain, counterfactual, trade exposure)
          </div>
          <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
            via world-storylines.ts → <a href="/today" className="text-accent">{w.consumers.briefing.output}</a>
          </p>
        </div>
      </div>

      <WorldTabs events={w.events} storylines={w.storylines} />

      <p className="text-[11px] leading-4 text-ink-3">
        Backlinks are title-joined today; eventId-keyed briefing references need the structured
        briefing (gap #1). Storyline causal links exist in prose, not yet as edges (gap #23).
      </p>
    </main>
  )
}
