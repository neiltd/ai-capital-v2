// /studio — Creator Studio board.
//
// THEME UNIFICATION (2026-07): normalized off the original separate
// magenta/warm-paper theme (design-system.md §8) onto the same graphite
// tokens and shared primitives as every other screen — see
// design-redesign-2026-07/screens/studio-v2/README.md for the decision
// record. studio-tokens.css is no longer imported anywhere.
//
// Cut over from the legacy /studio index (2026-07-08) — that page was a
// working daily-topic AI chat feature, not a stub, so it moved to
// /studio/chat rather than being deleted.
//
// The design mockup's 5-stage kanban has no real backing (no `status`
// column on Session/Video) — see data.ts for what's real vs. dropped.

export const dynamic = 'force-dynamic'

import { loadStudio } from './data'
import { StatTile, SectionCard, AlertBanner, Empty } from '@/components/next/ui'
import { Sparkline } from '@/components/next/charts'
import { StudioNav } from './studio-nav'

const fmtCount = (v: number) => v.toLocaleString('en-US')

export default async function StudioPage() {
  const s = await loadStudio()

  if (!s) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="Database not configured" detail="Run npx prisma migrate dev and set DATABASE_URL to enable persistence." />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Studio · Board</h1>
        <StudioNav current="board" />
      </header>

      <StatTile
        label="Followers"
        value={s.latestFollowers != null ? fmtCount(s.latestFollowers) : '—'}
        footnote="see Dashboard for full growth history"
      >
        {s.followerSeries.length >= 2 && <Sparkline points={s.followerSeries} width={120} stroke="var(--accent)" />}
      </StatTile>

      <SectionCard title={`In flight — ${s.inFlight.length} idea${s.inFlight.length === 1 ? '' : 's'} not yet posted`}>
        {s.inFlight.length === 0 ? (
          <Empty
            title="No sessions yet"
            hint={<>Start one from <a href="/studio/chat" className="text-accent">Today&apos;s topic</a>.</>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {s.inFlight.map((c) => (
              <article key={c.id} className="rounded-card border border-hairline p-3.5">
                <h3 className="text-[14px] font-semibold leading-snug text-ink">{c.title}</h3>
                <p className="mt-1 text-[12px] leading-snug text-ink-2">{c.summary}</p>
                <p className="mt-2 text-[11px] text-ink-3">{c.createdAt.slice(0, 10)}</p>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Recent posts" actions={<a href="/studio/dashboard" className="text-[12px] text-accent">Full dashboard →</a>}>
        {s.recentPosts.length === 0 ? (
          <p className="text-[13px] text-ink-3">No posted videos yet.</p>
        ) : (
          <div className="space-y-3">
            {s.recentPosts.map((p) => {
              const max = Math.max(...s.recentPosts.map((x) => x.views)) || 1
              return (
                <div key={p.id} className="flex items-center gap-4">
                  <div className="w-56 min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink" title={p.title}>{p.title}</div>
                    <div className="text-[11px] text-ink-3">{p.postedAt?.slice(0, 10) ?? 'unposted'}</div>
                  </div>
                  <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(p.views / max) * 100}%` }} />
                  </div>
                  <div className="w-40 text-right text-[12px] text-ink-2">
                    <b className="text-ink">{fmtCount(p.views)}</b> views · {fmtCount(p.likes)} ♥
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </main>
  )
}
