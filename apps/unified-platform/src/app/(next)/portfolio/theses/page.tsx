// /portfolio/theses — Thesis tracking.
//
// Layout:
//   ┌ Review queue: pending thesis-change proposals (only if any) ─────────┐
//   ├ Held theses (core + satellite positions)                             ┤
//   ├ Watchlist theses                                                     ┤
//   └────────────────────────────────────────────────────────────────────────┘
//
// Adapted from design-redesign-2026-07/screens/theses, now wired to real
// thesis.db via the accept/reject API built alongside this screen (backend
// gap #13). See data.ts for the specific adaptations: no "exited" bucket
// exists in the real schema (0 rows), and related-names uses a direct
// graph.json edge lookup instead of the mockup's fixed relation-type enum.

export const dynamic = 'force-dynamic'

import { loadTheses } from './data'
import { ThesisBoard } from './thesis-board'
import { ReviewQueue } from './review-queue'
import { SectionCard, AsOf, AlertBanner } from '@/components/next/ui'

export default function ThesesPage() {
  const t = loadTheses()

  if (!t) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="Thesis data unavailable" detail="thesis-memory/data/thesis.db not found." />
      </main>
    )
  }

  const weakening = t.held.filter((r) => r.status === 'weakening' || r.status === 'broken').length

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Theses</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Why you hold what you hold — as reviewable state, not prose. {t.held.length} held ·{' '}
            {t.watchlist.length} watchlist · {weakening} weakening.
          </p>
        </div>
        <AsOf iso={t.exportedAt} />
      </header>

      {t.proposals.length > 0 && <ReviewQueue proposals={t.proposals} />}

      <SectionCard title="Held positions" asOf={t.exportedAt}>
        <ThesisBoard rows={t.held} related={t.related} />
        <p className="mt-2 text-[11px] leading-4 text-ink-3">Sorted weakest-first.</p>
      </SectionCard>

      <SectionCard title="Watchlist">
        <ThesisBoard rows={t.watchlist} related={t.related} />
      </SectionCard>

      {t.graphExportedAt && (
        <p className="text-[11px] leading-4 text-ink-3">
          Related-names data: dependency-graph-engine graph.json ({t.graphExportedAt.slice(0, 10)}) —
          US AI universe only{t.ungraphed.length > 0 && <>; no graph coverage yet for {t.ungraphed.join(', ')}</>}.
        </p>
      )}
    </main>
  )
}
