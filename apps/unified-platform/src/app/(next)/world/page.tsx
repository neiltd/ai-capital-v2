// /world — World intelligence. List ⇄ Map ⇄ Storylines tabs.
//
// Adapted from design-redesign-2026-07/screens/world. Dropped the mockup's
// "two-consumer linkage strip" (event counters for "fed today's regime
// call" / "fed today's briefing top-5") — no real instrumentation exists
// for this anywhere in the pipeline, so it isn't shown rather than
// fabricated. Map tab reuses the existing worldmap sub-app (src/worldmap/)
// verbatim — port, don't rewrite.

export const dynamic = 'force-dynamic'

import { loadWorld } from './data'
import { WorldTabs } from './world-tabs'
import { AsOf, AlertBanner } from '@/components/next/ui'

export default function WorldPage() {
  const w = loadWorld()

  if (!w) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="World intelligence unavailable" detail="world-map/intelligence.json not found." />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-[1520px] space-y-4 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">World intelligence</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {w.eventCount} events · {w.uniqueSourceCount} sources · {w.reviewExcludedCount} excluded by review —
            the feed that today&apos;s regime call and briefing were built from.
          </p>
        </div>
        <AsOf iso={w.generatedAt} />
      </header>

      <WorldTabs events={w.events} storylines={w.storylines} />
    </main>
  )
}
