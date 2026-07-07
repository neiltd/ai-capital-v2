// /portfolio/theses — Thesis tracking. (Supersedes screens/specs/theses.md.)
//
// Layout:
//   ┌ Review queue: pending thesis-change proposals (only if any) ─────────┐
//   ├ Thesis board — held positions (row click → detail drawer)            ┤
//   ├ Watchlist & exited — previously-held/closed theses (history=memory)  ┤
//   └────────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - The review queue sits ABOVE everything until cleared — accepting or
//   rejecting a thesis-change proposal is the highest-leverage
//   human-in-the-loop moment in the app (like PR review requests).
// - Proposals render as diffs: current value muted, proposed value in ink,
//   with the evidence quote that triggered the change. Never a bare verdict.
// - Closed/exited theses stay visible — history is memory; the CRWD row is
//   how you remember an exit was a harvest, not a thesis break.
// - Every drawer carries "Related names" from the dependency graph
//   (competitors / supply chain / customers / same theme) so adjacent
//   tickers surface automatically instead of requiring prior knowledge.
//
// Backend gap #13 is blocking for live data: thesis-memory needs
// GET /api/theses + proposal accept/reject endpoints with an audit log.

import { loadTheses } from './data'
import { ThesisBoard } from './thesis-board'
import { SectionCard, AsOf, Label } from '../_shared/ui'

export default async function ThesesPage() {
  const t = await loadTheses()
  const weakening = t.held.filter((r) => r.status === 'weakening' || r.status === 'broken').length

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Theses</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Why you hold what you hold — as reviewable state, not prose. {t.held.length} held ·{' '}
            {t.closedAndWatchlist.length} exited/watchlist · {weakening} weakening.
          </p>
        </div>
        <AsOf iso={t.exportedAt} />
      </header>

      {/* ----------------------------- review queue ----------------------------- */}
      {t.proposals.length > 0 && (
        <SectionCard
          title={
            <span className="text-status-warning">
              Review queue · {t.proposals.length} pending proposal{t.proposals.length > 1 ? 's' : ''}
            </span>
          }
        >
          <ul className="divide-y divide-hairline">
            {t.proposals.map((p) => (
              <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={`?ticker=${p.ticker}`} className="text-[14px] font-semibold text-ink hover:text-accent">
                    {p.ticker}
                  </a>
                  <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">
                    {p.changeType.replace('_', ' ')}
                  </span>
                  <span className="text-[11px] text-ink-3">{p.source}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button className="rounded-chip bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90">
                      Accept
                    </button>
                    <button className="rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                      Reject
                    </button>
                    <button className="rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                      Edit…
                    </button>
                  </div>
                </div>

                {/* diff-style: current muted, proposed in ink */}
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div className="rounded-chip border border-hairline p-2.5">
                    <Label>Current</Label>
                    <p className="mt-0.5 text-[13px] leading-5 text-ink-3 line-through decoration-hairline">
                      {p.oldValue}
                    </p>
                  </div>
                  <div className="rounded-chip border border-accent/40 p-2.5">
                    <Label>Proposed</Label>
                    <p className="mt-0.5 text-[13px] leading-5 text-ink">{p.newValue}</p>
                  </div>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{p.reasoning}</p>
                {p.evidenceQuotes.map((q) => (
                  <blockquote key={q} className="mt-1 border-l-2 border-hairline pl-2 text-[12px] italic leading-4 text-ink-3">
                    “{q}”
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-ink-3">
            Accept writes to thesis-memory with an audit entry (gap #13). Nothing changes without
            your click.
          </p>
        </SectionCard>
      )}

      {/* ------------------------------ held board ------------------------------ */}
      <SectionCard title="Held positions" asOf={t.exportedAt}>
        <ThesisBoard rows={t.held} related={t.related} variant="held" />
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Sorted weakest-first. ⚠ = unreviewed &gt;30d while status ≠ stable. Click a row for the
          full thesis, assumption statuses, evidence timeline, and graph-derived related names.
        </p>
      </SectionCard>

      {/* -------------------------- exited & watchlist -------------------------- */}
      <SectionCard title="Watchlist & exited">
        <ThesisBoard rows={t.closedAndWatchlist} related={t.related} variant="closed" />
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          Closed theses are kept, not deleted — the exit reason distinguishes “harvested, thesis
          intact” (CRWD, wash-sale until 07-15) from “thesis broken” (UNH). Watchlist rows (NVO,
          META) carry live re-entry conditions.
        </p>
      </SectionCard>

      <p className="text-[11px] leading-4 text-ink-3">
        Related-names data: dependency-graph-engine graph.json ({t.graphExportedAt.slice(0, 10)}),
        34 nodes / 42 edges — US AI universe only; {t.ungraphed.length > 0 && (
          <>no graph coverage yet for {t.ungraphed.join(', ')} (gap #17).</>
        )}
      </p>
    </main>
  )
}
