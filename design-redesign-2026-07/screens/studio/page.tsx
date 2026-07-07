// /studio — Creator Studio pipeline board.
// (Supersedes screens/specs/creator-studio.md — the design-language decision
// table from that spec now lives in studio-tokens.css + this header.)
//
// DELIBERATELY DISTINCT design language (design-system.md §8): light/warm
// paper, magenta + orange accent pair, 15px base type, rounded-xl cards with
// soft shadows, board/calendar layouts. Shares only token INFRASTRUCTURE
// (spacing/type scale, radius names, shadcn primitives) with the dashboard —
// no graphite, no tabular-number worship, no status strip, no net worth.
// Own shell: top-nav with a reciprocal "← AI Capital" link; URL space stays
// /studio/* in its own route group with `.studio-theme` scoping the tokens
// (see studio-tokens.css) so neither theme can leak into the other.
//
// This page uses raw hex-var styles rather than the dashboard's semantic
// tailwind classes on purpose — the studio must not import the dashboard's
// visual vocabulary, only its scales.

import './studio-tokens.css'
import { loadStudio } from './data'
import type { Platform, StudioCard } from './data'

const PLATFORM: Record<Platform, { label: string; wash: string; ink: string }> = {
  tiktok: { label: 'TikTok', wash: 'var(--st-magenta-wash)', ink: 'var(--st-magenta)' },
  reels: { label: 'Reels', wash: 'var(--st-orange-wash)', ink: 'var(--st-orange)' },
  shorts: { label: 'Shorts', wash: 'var(--st-card-2)', ink: 'var(--st-ink-2)' },
}

function PlatformChip({ p }: { p: Platform }) {
  const s = PLATFORM[p]
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[12px] font-medium"
      style={{ backgroundColor: s.wash, color: s.ink }}
    >
      {s.label}
    </span>
  )
}

export default async function StudioPage() {
  const s = await loadStudio()

  return (
    <div className="studio-theme min-h-screen" style={{ backgroundColor: 'var(--st-paper)', color: 'var(--st-ink)' }}>
      {/* ------------------------- studio's own top-nav ------------------------- */}
      {/* No sidebar, no status strip — net worth has no business on a content
          board. Switching back to the dashboard is a deliberate act. */}
      <nav className="flex items-center gap-6 px-8 py-4" style={{ borderBottom: '1px solid var(--st-line)' }}>
        <a href="/today" className="text-[14px]" style={{ color: 'var(--st-ink-3)' }}>← AI Capital</a>
        <span className="text-[18px] font-bold tracking-tight">
          Creator <span style={{ color: 'var(--st-magenta)' }}>Studio</span>
        </span>
        <div className="ml-auto flex items-center gap-5 text-[14px]" style={{ color: 'var(--st-ink-2)' }}>
          <a href="/studio" className="font-semibold" style={{ color: 'var(--st-ink)' }}>Board</a>
          <a href="/studio/calendar">Calendar</a>
          <a href="/studio/analytics">Analytics</a>
          <button
            className="rounded-full px-4 py-1.5 text-[14px] font-semibold text-white"
            style={{ backgroundColor: 'var(--st-magenta)' }}
          >
            + New idea
          </button>
        </div>
      </nav>

      <main className="mx-auto max-w-[1520px] space-y-8 p-8">
        {/* ------------------------------ pipeline board ------------------------------ */}
        <section>
          <h1 className="text-[22px] font-bold tracking-tight">Pipeline</h1>
          <p className="mt-1 text-[15px]" style={{ color: 'var(--st-ink-2)' }}>
            {s.cards.length} pieces in flight · drag cards between stages (dnd-kit in the real app)
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {s.stages.map((stage) => {
              const cards = s.cards.filter((c) => c.stage === stage.id)
              return (
                <div key={stage.id} className="rounded-2xl p-3" style={{ backgroundColor: 'var(--st-card-2)' }}>
                  <div className="flex items-baseline justify-between px-1 pb-2">
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--st-ink-2)' }}>
                      {stage.title}
                    </span>
                    <span className="text-[13px]" style={{ color: 'var(--st-ink-3)' }}>{cards.length}</span>
                  </div>
                  <div className="space-y-3">
                    {cards.map((c) => (
                      <BoardCard key={c.id} c={c} posted={stage.id === 'posted'} />
                    ))}
                    {cards.length === 0 && (
                      <div
                        className="rounded-xl border border-dashed p-4 text-center text-[13px]"
                        style={{ borderColor: 'var(--st-line)', color: 'var(--st-ink-3)' }}
                      >
                        drop here
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* ------------------------------ week calendar ------------------------------ */}
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-[18px] font-bold tracking-tight">This week</h2>
            <a href="/studio/calendar" className="text-[14px]" style={{ color: 'var(--st-magenta)' }}>Full calendar →</a>
          </div>
          <div className="mt-3 grid grid-cols-7 gap-2">
            {s.week.map((d) => (
              <div
                key={d.date}
                className="min-h-24 rounded-xl p-2.5"
                style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}
              >
                <div className="text-[12px] font-medium" style={{ color: 'var(--st-ink-3)' }}>
                  {d.weekday} <span>{d.date.slice(8)}</span>
                </div>
                {d.cards.map((c) => (
                  <div key={c.id + c.platform} className="mt-1.5 rounded-lg px-2 py-1.5" style={{ backgroundColor: PLATFORM[c.platform].wash }}>
                    <div className="truncate text-[12px] font-medium" title={c.title}>{c.title}</div>
                    <div className="text-[11px]" style={{ color: PLATFORM[c.platform].ink }}>{PLATFORM[c.platform].label}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------- analytics -------------------------------- */}
        {/* Reuses the dataviz METHOD (system-agnostic), not the dashboard's
            palette: magenta/orange series validated separately against the
            paper surface. */}
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-[18px] font-bold tracking-tight">Recent posts</h2>
            <a href="/studio/analytics" className="text-[14px]" style={{ color: 'var(--st-magenta)' }}>All analytics →</a>
          </div>
          <div className="mt-3 rounded-2xl p-5" style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}>
            <div className="space-y-3">
              {s.performance.map((p) => {
                const max = Math.max(...s.performance.map((x) => x.views))
                return (
                  <div key={p.cardId + p.platform} className="flex items-center gap-4">
                    <div className="w-56 min-w-0">
                      <div className="truncate text-[14px] font-medium" title={p.title}>{p.title}</div>
                      <div className="text-[12px]" style={{ color: 'var(--st-ink-3)' }}>
                        {PLATFORM[p.platform].label} · {p.postedAt}
                      </div>
                    </div>
                    <div className="h-[10px] flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--st-card-2)' }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(p.views / max) * 100}%`,
                          backgroundColor: p.platform === 'tiktok' ? 'var(--st-magenta)' : 'var(--st-orange)',
                        }}
                      />
                    </div>
                    <div className="w-40 text-right text-[13px]" style={{ color: 'var(--st-ink-2)' }}>
                      <b style={{ color: 'var(--st-ink)' }}>{p.views.toLocaleString()}</b> views ·{' '}
                      {p.likes.toLocaleString()} ♥ · {p.saves} 🔖
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="mt-4 text-[13px]" style={{ color: 'var(--st-ink-3)' }}>
              Manual entry for now — performance ingestion is gap #26. Saves-per-view is the number
              that decides what gets a sequel.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

function BoardCard({ c, posted }: { c: StudioCard; posted: boolean }) {
  return (
    <article
      className="cursor-grab rounded-xl p-3.5 transition-transform hover:-translate-y-0.5"
      style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}
    >
      <div className="flex items-start gap-2.5">
        {c.thumbnail && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[18px]" style={{ backgroundColor: 'var(--st-card-2)' }} aria-hidden>
            {c.thumbnail}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-snug">
            <a href={`/studio/idea/${c.id}`} className="hover:underline" style={{ textDecorationColor: 'var(--st-magenta)' }}>
              {c.title}
            </a>
          </h3>
          <p className="mt-1 text-[13px] leading-snug" style={{ color: 'var(--st-ink-2)' }}>{c.hook}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {c.platforms.map((p) => <PlatformChip key={p} p={p} />)}
        <span className="ml-auto text-[12px]" style={{ color: posted ? 'var(--st-good)' : c.stageAgeDays > 4 ? 'var(--st-orange)' : 'var(--st-ink-3)' }}>
          {posted ? `posted ${c.scheduledFor}` : `${c.stageAgeDays}d here${c.stageAgeDays > 4 ? ' — stuck?' : ''}`}
        </span>
      </div>
    </article>
  )
}
