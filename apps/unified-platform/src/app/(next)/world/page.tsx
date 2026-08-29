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
import { CoverageCallout } from '@/components/next/coverage-notice'

export default function WorldPage() {
  const w = loadWorld()

  if (!w) {
    return (
      <main className="mx-auto max-w-[1520px] p-page-pad">
        <AlertBanner level="warning" title="World intelligence unavailable" detail="world-map/intelligence.json not found." />
        {/* Absence of the export is not absence of events — say which feeds we
            could not read either. */}
        <div className="mt-3"><CoverageCallout where="world intelligence" /></div>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
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

      {/* Beside the event feed it qualifies, not as a global banner. */}
      <CoverageCallout where="the events below" />

      <WorldTabs events={w.events} storylines={w.storylines} />
    </main>
  )
}
