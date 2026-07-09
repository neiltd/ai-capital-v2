// /studio/archive — session history (studio-v2).
//
// THEME UNIFICATION (2026-07): graphite tokens + shared primitives, same as
// every other screen. Supersedes the legacy archive and design-system.md §8.
//
// Layout:
//   ┌ header: Studio · Archive                          sub-nav ───────────┐
//   ├ filter row: search (mock) · visual-type chips (mock) ────────────────┤
//   ├ SectionCard: session list                                            ┤
//   │   each row: date │ topic title + angle │ visual chips │ outcome      │
//   │   <details> expands to the story arc (hook / beats / angle / CTA)    │
//   └────────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - A session's OUTCOME is the scannable right column: either the linked
//   video's real performance (views/likes, gain-tinted) or a muted "not
//   filmed". That's the question the archive answers at a glance — which
//   ideas became videos and did they work.
// - Expansion uses native <details>/<summary> — server-component friendly,
//   no client JS. The engineer can keep this or swap for a client accordion.
// - storyArc is null on most real rows today (never written by the save
//   endpoint — README gap #2); that state is designed in, not hidden.
// - Filter row is a visual spec only (search + type chips). Wiring it means
//   a client wrapper or searchParams — engineer's call at 4 rows; it earns
//   its keep around ~20 sessions.

export const dynamic = 'force-dynamic'

import { loadStudioArchive, type ArchiveSession } from './data'
import { SectionCard, Label } from '@/components/next/ui'

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtCount = (v: number) => v.toLocaleString('en-US')

export default async function StudioArchivePage() {
  const a = await loadStudioArchive()
  const filmed = a.sessions.filter((s) => s.video != null).length

  return (
    <main className="mx-auto max-w-[1080px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[20px] font-semibold text-ink">Studio · Archive</h1>
          <span className="tnum text-[12px] text-ink-3">
            {a.sessions.length} session{a.sessions.length === 1 ? '' : 's'} · {filmed} filmed
          </span>
        </div>
        <StudioNav current="archive" />
      </header>

      {/* ------------------------- filter row (visual mock) ------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search topics…"
          className="w-64 rounded-chip border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
        />
        {['All', 'Chart', 'Card', 'Illustration', 'Filmed only'].map((f, i) => (
          <button
            key={f}
            type="button"
            className={
              i === 0
                ? 'rounded-chip border border-accent bg-accent px-2.5 py-1 text-[12px] font-medium text-white'
                : 'rounded-chip border border-hairline px-2.5 py-1 text-[12px] text-ink-2 hover:text-ink'
            }
          >
            {f}
          </button>
        ))}
      </div>

      {/* ------------------------------- session list ------------------------------- */}
      {a.sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline px-6 py-14 text-center">
          <div className="text-[13px] font-medium text-ink-2">No sessions saved yet</div>
          <div className="max-w-[420px] text-[12px] leading-5 text-ink-3">
            Develop today&apos;s topic in the chat and hit <span className="font-medium text-ink-2">Save session</span> — it lands here with its story arc and visuals.
          </div>
          <a href="/studio/chat" className="mt-2 text-[12px] font-medium text-accent">
            Open today&apos;s topic →
          </a>
        </div>
      ) : (
        <SectionCard asOf={a.generatedAt}>
          <ul>
            {a.sessions.map((s, i) => (
              <SessionRow key={s.id} s={s} defaultOpen={i === 0} />
            ))}
          </ul>
        </SectionCard>
      )}
    </main>
  )
}

/* --------------------------------- session row --------------------------------- */

function SessionRow({ s, defaultOpen }: { s: ArchiveSession; defaultOpen?: boolean }) {
  return (
    <li className="border-b border-hairline last:border-0">
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer list-none items-start gap-4 py-3 [&::-webkit-details-marker]:hidden">
          {/* date */}
          <span className="tnum w-14 shrink-0 pt-0.5 text-[12px] text-ink-3">{fmtDay(s.createdAt)}</span>

          {/* topic */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium leading-5 text-ink">{s.topic.title}</span>
              <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">
                {s.topic.suggestedVisualType}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[12px] text-ink-3">{s.topic.suggestedAngle}</div>
          </div>

          {/* outcome — the scannable column */}
          <div className="w-44 shrink-0 pt-0.5 text-right">
            {s.video ? (
              <>
                <div className="tnum text-[13px] font-medium text-gain">{fmtCount(s.video.views)} views</div>
                <div className="tnum text-[11px] text-ink-3">
                  {fmtCount(s.video.likes)} likes · {s.video.postedAt ?? 'unposted'}
                </div>
              </>
            ) : (
              <span className="text-[12px] text-ink-3">not filmed</span>
            )}
          </div>

          <span className="pt-1 text-[10px] text-ink-3 transition-transform group-open:rotate-90">▶</span>
        </summary>

        {/* ------------------------------ expanded body ------------------------------ */}
        <div className="ml-[72px] space-y-3 pb-4 pr-6">
          <p className="max-w-[640px] text-[13px] leading-5 text-ink-2">{s.topic.summary}</p>

          {s.storyArc ? (
            <div className="rounded-card border border-hairline bg-surface-2 px-3.5 py-3">
              <Label>Story arc</Label>
              <p className="mt-1.5 text-[14px] font-medium leading-5 text-ink">“{s.storyArc.hook}”</p>
              <ol className="mt-2 space-y-1">
                {s.storyArc.beats.map((b, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-5 text-ink-2">
                    <span className="tnum shrink-0 text-ink-3">{i + 1}.</span>
                    {b}
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-ink-3">
                <span>
                  <span className="font-medium text-ink-2">Personal angle</span> — {s.storyArc.personalAngle}
                </span>
                <span>
                  <span className="font-medium text-ink-2">CTA</span> — {s.storyArc.cta}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[12px] italic text-ink-3">
              No story arc saved for this session. {/* real rows hit this today — README gap #2 */}
            </p>
          )}

          {s.visuals.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {s.visuals.map((v, i) => (
                <span key={i} className="rounded-chip border border-hairline px-2 py-1 text-[11px] text-ink-2">
                  <span className="mr-1 uppercase tracking-wide text-ink-3">{v.type}</span>
                  {v.label}
                </span>
              ))}
            </div>
          )}

          {s.notes && (
            <p className="text-[12px] leading-5 text-ink-3">
              <span className="font-medium text-ink-2">Notes</span> — {s.notes}
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

/* ------------------------ studio sub-nav (shared visual) ------------------------ */

function StudioNav({ current }: { current: 'dashboard' | 'archive' | 'chat' }) {
  const items = [
    { id: 'chat', label: "Today's topic", href: '/studio/chat' },
    { id: 'dashboard', label: 'Dashboard', href: '/studio/dashboard' },
    { id: 'archive', label: 'Archive', href: '/studio/archive' },
  ] as const
  return (
    <nav className="flex items-center gap-4 text-[12px]">
      {items.map((it) => (
        <a
          key={it.id}
          href={it.href}
          className={it.id === current ? 'font-semibold text-ink' : 'text-ink-3 hover:text-ink-2'}
        >
          {it.label}
        </a>
      ))}
    </nav>
  )
}
