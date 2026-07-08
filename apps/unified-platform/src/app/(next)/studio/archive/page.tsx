// /studio/archive — session history.
//
// THEME UNIFICATION (2026-07): graphite tokens + shared primitives, same as
// every other screen. Supersedes the legacy archive and design-system.md §8.
//
// Design intents (design-redesign-2026-07/screens/studio-v2/archive):
// - A session's OUTCOME is the scannable right column: either the linked
//   video's real performance (views/likes, gain-tinted) or a muted "not
//   filmed" — that's the question the archive answers at a glance.
// - Expansion uses native <details>/<summary> — server-component friendly.
// - storyArc is null on most real rows today (never written by the save
//   endpoint) — that state is designed in, not hidden.
// - Filter row is a visual spec only for now (search + type chips
//   non-functional) — earns its keep around ~20 sessions; today's real
//   count doesn't need it wired.

export const dynamic = 'force-dynamic'

import { loadStudioArchive, type ArchiveSession } from './data'
import { SectionCard, Label, AlertBanner, Empty } from '@/components/next/ui'
import { StudioNav } from '../studio-nav'

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtCount = (v: number) => v.toLocaleString('en-US')

export default async function StudioArchivePage() {
  const a = await loadStudioArchive()

  if (!a) {
    return (
      <main className="mx-auto max-w-[1080px] p-6">
        <AlertBanner level="warning" title="Database not configured" detail="Run npx prisma migrate dev and set DATABASE_URL to enable persistence." />
      </main>
    )
  }

  const filmed = a.sessions.filter((s) => s.video != null).length

  return (
    <main className="mx-auto max-w-[1080px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[20px] font-semibold text-ink">Studio · Archive</h1>
          <span className="tnum text-[12px] text-ink-3">{a.sessions.length} session{a.sessions.length === 1 ? '' : 's'} · {filmed} filmed</span>
        </div>
        <StudioNav current="archive" />
      </header>

      {a.sessions.length > 0 && (
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
      )}

      {a.sessions.length === 0 ? (
        <Empty
          title="No sessions saved yet"
          hint={<>Develop today&apos;s topic in the chat and hit <span className="font-medium text-ink-2">Save session</span> — it lands here with its story arc and visuals.</>}
          action={<a href="/studio/chat" className="text-[12px] font-medium text-accent">Open today&apos;s topic →</a>}
        />
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

function SessionRow({ s, defaultOpen }: { s: ArchiveSession; defaultOpen?: boolean }) {
  return (
    <li className="border-b border-hairline last:border-0">
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer list-none items-start gap-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="tnum w-14 shrink-0 pt-0.5 text-[12px] text-ink-3">{fmtDay(s.createdAt)}</span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium leading-5 text-ink">{s.topic.title}</span>
              <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">{s.topic.suggestedVisualType}</span>
            </div>
            <div className="mt-0.5 truncate text-[12px] text-ink-3">{s.topic.suggestedAngle}</div>
          </div>

          <div className="w-44 shrink-0 pt-0.5 text-right">
            {s.video ? (
              <>
                <div className="tnum text-[13px] font-medium text-gain">{fmtCount(s.video.views)} views</div>
                <div className="tnum text-[11px] text-ink-3">{fmtCount(s.video.likes)} likes · {s.video.postedAt ?? 'unposted'}</div>
              </>
            ) : (
              <span className="text-[12px] text-ink-3">not filmed</span>
            )}
          </div>

          <span className="pt-1 text-[10px] text-ink-3 transition-transform group-open:rotate-90">▶</span>
        </summary>

        <div className="ml-[72px] space-y-3 pb-4 pr-6">
          <p className="max-w-[640px] text-[13px] leading-5 text-ink-2">{s.topic.summary}</p>

          {s.storyArc ? (
            <div className="rounded-card border border-hairline bg-surface-2 px-3.5 py-3">
              <Label>Story arc</Label>
              <p className="mt-1.5 text-[14px] font-medium leading-5 text-ink">&ldquo;{s.storyArc.hook}&rdquo;</p>
              <ol className="mt-2 space-y-1">
                {s.storyArc.beats.map((b, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-5 text-ink-2">
                    <span className="tnum shrink-0 text-ink-3">{i + 1}.</span>
                    {b}
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-ink-3">
                <span><span className="font-medium text-ink-2">Personal angle</span> — {s.storyArc.personalAngle}</span>
                <span><span className="font-medium text-ink-2">CTA</span> — {s.storyArc.cta}</span>
              </div>
            </div>
          ) : (
            <p className="text-[12px] italic text-ink-3">No story arc saved for this session.</p>
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
            <p className="text-[12px] leading-5 text-ink-3"><span className="font-medium text-ink-2">Notes</span> — {s.notes}</p>
          )}
        </div>
      </details>
    </li>
  )
}
