// /studio — Creator Studio.
//
// DELIBERATELY DISTINCT design language (design-system.md §8): light/warm
// paper, magenta + orange accent pair, rounded cards with soft shadows.
// Shares only token infrastructure with the dashboard — no graphite, no
// status strip, no net worth. Raw hex-var styles on purpose, not the
// dashboard's semantic tailwind classes (see studio-tokens.css header).
//
// Cut over from the legacy /studio index (2026-07-08) — that page was a
// working daily-topic AI chat feature, not a stub, so it moved to
// /studio/chat rather than being deleted. Dashboard and Archive stay on the
// legacy shell for now (gap #26 — board `status` column, post-performance
// entries — blocks a full re-build of those).
//
// The design mockup's 5-stage kanban has no real backing (no `status`
// column on Session/Video) — see data.ts for what's real vs. dropped.

export const dynamic = 'force-dynamic'

import './studio-tokens.css'
import { loadStudio } from './data'
import { Sparkline } from '@/components/next/charts'

export default async function StudioPage() {
  const s = await loadStudio()

  if (!s) {
    return (
      <div className="studio-theme flex min-h-screen items-center justify-center" style={{ backgroundColor: 'var(--st-paper)', color: 'var(--st-ink)' }}>
        <p className="text-[15px]" style={{ color: 'var(--st-ink-2)' }}>
          Database not configured — run <code>npx prisma migrate dev</code> and set <code>DATABASE_URL</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="studio-theme min-h-screen" style={{ backgroundColor: 'var(--st-paper)', color: 'var(--st-ink)' }}>
      <nav className="flex items-center gap-6 px-8 py-4" style={{ borderBottom: '1px solid var(--st-line)' }}>
        <a href="/today" className="text-[14px]" style={{ color: 'var(--st-ink-3)' }}>← AI Capital</a>
        <span className="text-[18px] font-bold tracking-tight">
          Creator <span style={{ color: 'var(--st-magenta)' }}>Studio</span>
        </span>
        <div className="ml-auto flex items-center gap-5 text-[14px]" style={{ color: 'var(--st-ink-2)' }}>
          <a href="/studio" className="font-semibold" style={{ color: 'var(--st-ink)' }}>Board</a>
          <a href="/studio/chat">Today&apos;s topic</a>
          <a href="/studio/dashboard">Dashboard</a>
          <a href="/studio/archive">Archive</a>
        </div>
      </nav>

      <main className="mx-auto max-w-[1520px] space-y-8 p-8">
        {/* -------------------------------- followers -------------------------------- */}
        <section className="flex items-center gap-4 rounded-2xl p-4" style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}>
          <div>
            <div className="text-[13px]" style={{ color: 'var(--st-ink-3)' }}>Followers</div>
            <div className="text-[22px] font-bold tracking-tight">
              {s.latestFollowers != null ? s.latestFollowers.toLocaleString() : '—'}
            </div>
          </div>
          {s.followerSeries.length >= 2 && <Sparkline points={s.followerSeries} width={120} stroke="var(--st-magenta)" />}
        </section>

        {/* ------------------------------ content ideas ------------------------------ */}
        <section>
          <h1 className="text-[22px] font-bold tracking-tight">In flight</h1>
          <p className="mt-1 text-[15px]" style={{ color: 'var(--st-ink-2)' }}>
            {s.inFlight.length} idea{s.inFlight.length === 1 ? '' : 's'} not yet posted.
          </p>
          {s.inFlight.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed p-8 text-center text-[14px]" style={{ borderColor: 'var(--st-line)', color: 'var(--st-ink-3)' }}>
              No sessions yet — start one from <a href="/studio/chat" style={{ color: 'var(--st-magenta)' }}>Today&apos;s topic</a>.
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              {s.inFlight.map((c) => (
                <article key={c.id} className="rounded-xl p-3.5" style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}>
                  <h3 className="text-[15px] font-semibold leading-snug">{c.title}</h3>
                  <p className="mt-1 text-[13px] leading-snug" style={{ color: 'var(--st-ink-2)' }}>{c.summary}</p>
                  <p className="mt-2 text-[12px]" style={{ color: 'var(--st-ink-3)' }}>{c.createdAt.slice(0, 10)}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* -------------------------------- analytics -------------------------------- */}
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-[18px] font-bold tracking-tight">Recent posts</h2>
            <a href="/studio/dashboard" className="text-[14px]" style={{ color: 'var(--st-magenta)' }}>Full dashboard →</a>
          </div>
          <div className="mt-3 rounded-2xl p-5" style={{ backgroundColor: 'var(--st-card)', boxShadow: 'var(--st-shadow)' }}>
            {s.recentPosts.length === 0 ? (
              <p className="text-[13px]" style={{ color: 'var(--st-ink-3)' }}>No posted videos yet.</p>
            ) : (
              <div className="space-y-3">
                {s.recentPosts.map((p) => {
                  const max = Math.max(...s.recentPosts.map((x) => x.views)) || 1
                  return (
                    <div key={p.id} className="flex items-center gap-4">
                      <div className="w-56 min-w-0">
                        <div className="truncate text-[14px] font-medium" title={p.title}>{p.title}</div>
                        <div className="text-[12px]" style={{ color: 'var(--st-ink-3)' }}>{p.postedAt?.slice(0, 10) ?? 'unposted'}</div>
                      </div>
                      <div className="h-[10px] flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--st-card-2)' }}>
                        <div className="h-full rounded-full" style={{ width: `${(p.views / max) * 100}%`, backgroundColor: 'var(--st-magenta)' }} />
                      </div>
                      <div className="w-40 text-right text-[13px]" style={{ color: 'var(--st-ink-2)' }}>
                        <b style={{ color: 'var(--st-ink)' }}>{p.views.toLocaleString()}</b> views · {p.likes.toLocaleString()} ♥
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
