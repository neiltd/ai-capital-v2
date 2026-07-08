// /discover/graph — Dependency graph.
//
// Reuses the existing GraphClient.tsx (react-force-graph-2d, click-to-focus
// physics, selection-synced inspector rail) verbatim inside the new page
// shell — see data.ts for what was and wasn't adapted to the spec.

export const dynamic = 'force-dynamic'

import { GraphClient } from '@/app/(legacy)/capital/graph/GraphClient'
import { readGraph } from '@/lib/data'
import { loadGraphExposure } from './data'
import { SectionCard, AlertBanner, AsOf } from '@/components/next/ui'
import { fmtUsd, fmtPct } from '@/lib/next/format'

export default function DependencyGraphPage() {
  let graph: ReturnType<typeof readGraph> | null = null
  try { graph = readGraph() } catch { graph = null }
  const exposure = loadGraphExposure()

  if (!graph) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="Graph data unavailable" detail="dependency-graph-engine/data/graph.json not found." />
      </main>
    )
  }

  return (
    <main className="mx-auto flex h-[calc(100vh-40px)] max-w-[1520px] flex-col gap-4 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Dependency graph</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">{graph.nodes.length} companies · {graph.edges.length} relationships. Click a node to focus its network.</p>
        </div>
        {exposure?.exportedAt && <AsOf iso={exposure.exportedAt} />}
      </header>

      <div className="min-h-0 flex-1">
        <GraphClient data={graph} />
      </div>

      {exposure && exposure.themeExposure.length > 0 && (
        <SectionCard title="Theme exposure — how much of the real portfolio moves if a theme breaks">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {exposure.themeExposure.map((t) => (
              <div key={t.theme} className="rounded-chip border border-hairline p-2.5">
                <div className="text-[13px] font-semibold text-ink">{t.theme}</div>
                <div className="mt-1 tnum text-[16px] font-semibold text-ink">
                  {fmtUsd(t.exposureUsd)}
                  {t.pctOfNetWorth != null && <span className="ml-1.5 text-[12px] font-normal text-ink-3">{fmtPct(t.pctOfNetWorth)} of NW</span>}
                </div>
                <div className="mt-1 text-[11px] text-ink-3">{t.heldTickers.join(', ')}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </main>
  )
}
