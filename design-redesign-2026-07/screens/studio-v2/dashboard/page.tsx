// /studio/dashboard — Creator Studio growth analytics (studio-v2).
//
// THEME UNIFICATION (2026-07): supersedes design-system.md §8 and
// screens/studio/*. Creator Studio now uses the SAME graphite tokens and
// primitives as every other screen — no studio-tokens.css, no magenta/paper.
// See ../README.md for the decision record.
//
// Layout:
//   ┌ header: Studio · Dashboard              sub-nav ─────────────────────┐
//   ├ StatTiles: Followers(spark) · Profile views · Views · Engagement · Sessions ┤
//   ├ Follower growth line (7 cols)        │ Views by topic HBars (5 cols) ┤
//   ├ Videos table — full width, ranked by views, per-row engagement ──────┤
//   └───────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - Followers is the only real time series (Video counters are lifetime
//   totals), so it alone gets the line chart + sparkline. Single series →
//   accent hue, direct-labeled last point, no legend (title names it).
// - Views-by-topic is magnitude, not identity → single-hue HBars; the label
//   carries identity, never color.
// - "Log snapshot" / "Log video" actions preserved from legacy
//   DashboardActions (GrowthForm/VideoForm client modals) — buttons mocked
//   here; the forms themselves need a graphite restyle (see README gap #5).
// - Empty state is first-class: all three tables have ZERO rows in prod
//   today. Flip SHOW_EMPTY in data.ts to preview.

export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { loadStudioDashboard, type GrowthPoint, type VideoRow } from './data'
import { StatTile, SectionCard, Th, Td } from '@/components/next/ui'
import { Sparkline, HBar } from '@/components/next/charts'

const fmtCount = (v: number) => v.toLocaleString('en-US')
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
const topicLabel = (t: string) => t.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const engagement = (v: Pick<VideoRow, 'views' | 'likes' | 'comments' | 'shares'>) =>
  v.views > 0 ? (v.likes + v.comments + v.shares) / v.views : null

export default async function StudioDashboardPage() {
  const d = await loadStudioDashboard()

  const posted = d.videos.filter((v) => v.postedAt != null)
  const latest = d.snapshots.at(-1)
  const weekAgo = d.snapshots.length >= 8 ? d.snapshots.at(-8) : d.snapshots[0]
  const followerDelta7d = latest && weekAgo && latest !== weekAgo ? latest.followers - weekAgo.followers : null

  const totalViews = d.videos.reduce((s, v) => s + v.views, 0)
  const overallEng = engagement({
    views: totalViews,
    likes: d.videos.reduce((s, v) => s + v.likes, 0),
    comments: d.videos.reduce((s, v) => s + v.comments, 0),
    shares: d.videos.reduce((s, v) => s + v.shares, 0),
  })

  // Views by topic — topics derived from data, never a hardcoded list.
  const byTopic = new Map<string, { views: number; count: number }>()
  for (const v of d.videos) {
    const e = byTopic.get(v.topicType) ?? { views: 0, count: 0 }
    e.views += v.views
    e.count += 1
    byTopic.set(v.topicType, e)
  }
  const topics = [...byTopic.entries()]
    .map(([type, x]) => ({ type, ...x }))
    .sort((a, b) => b.views - a.views)
  const maxTopicViews = Math.max(1, ...topics.map((t) => t.views))

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Studio · Dashboard</h1>
        <StudioNav current="dashboard" />
      </header>

      {/* ------------------------------ stat tiles ------------------------------ */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile
          label="Followers"
          value={latest ? fmtCount(latest.followers) : '—'}
          delta={
            followerDelta7d != null ? (
              <span className={`tnum text-[13px] font-medium ${followerDelta7d >= 0 ? 'text-gain' : 'text-loss'}`}>
                {followerDelta7d >= 0 ? '+' : '−'}{fmtCount(Math.abs(followerDelta7d))} 7d
              </span>
            ) : undefined
          }
          footnote={latest ? `${d.snapshots.length} snapshots logged` : 'no snapshots yet'}
        >
          {d.snapshots.length >= 2 && (
            <Sparkline points={d.snapshots.map((s) => s.followers)} width={120} stroke="var(--accent)" />
          )}
        </StatTile>
        <StatTile
          label="Profile views"
          value={latest ? fmtCount(latest.profileViews) : '—'}
          footnote="latest snapshot, daily count"
        />
        <StatTile
          label="Total views"
          value={totalViews > 0 ? fmtCount(totalViews) : '—'}
          footnote={`${posted.length} posted video${posted.length === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Avg engagement"
          value={overallEng != null ? `${(overallEng * 100).toFixed(1)}%` : '—'}
          footnote="(likes + comments + shares) / views"
        />
        <StatTile
          label="Sessions"
          value={d.sessionCount > 0 ? fmtCount(d.sessionCount) : '—'}
          footnote="ideation chats saved to archive"
        />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* --------------------------- follower growth --------------------------- */}
        <SectionCard
          title="Follower growth"
          asOf={d.generatedAt}
          className="col-span-12 xl:col-span-7"
          actions={<MockButton>Log snapshot</MockButton>}
        >
          {d.snapshots.length >= 2 ? (
            <>
              <FollowerChart points={d.snapshots} />
              <p className="mt-1 text-[11px] leading-4 text-ink-3">
                Manual daily snapshots ({d.snapshots[0].date} → {latest!.date}). Hover a point for the exact count.
              </p>
            </>
          ) : (
            <Empty
              title="No growth snapshots yet"
              hint="Log a follower count to start charting growth — one snapshot a day is enough."
              action="Log first snapshot"
            />
          )}
        </SectionCard>

        {/* ---------------------------- views by topic ---------------------------- */}
        <SectionCard title="Views by topic" asOf={d.generatedAt} className="col-span-12 xl:col-span-5">
          {topics.length > 0 && totalViews > 0 ? (
            <>
              {topics.map((t) => (
                <HBar
                  key={t.type}
                  label={<span className="text-[12px]">{topicLabel(t.type)}</span>}
                  value={t.views / maxTopicViews}
                  display={fmtCount(t.views)}
                  color="var(--accent)"
                  trailing={
                    <span className="tnum w-24 shrink-0 text-right text-[11px] text-ink-3">
                      {((t.views / totalViews) * 100).toFixed(0)}% · {t.count} video{t.count === 1 ? '' : 's'}
                    </span>
                  }
                />
              ))}
              <p className="mt-2 text-[11px] leading-4 text-ink-3">
                Share of all logged views. Topics come from the data (`topicType`), not a fixed list.
              </p>
            </>
          ) : (
            <Empty title="No videos logged yet" hint="Log a video to see which topics actually pull views." />
          )}
        </SectionCard>

        {/* ------------------------------ videos table ------------------------------ */}
        <SectionCard
          title="Video performance"
          asOf={d.generatedAt}
          className="col-span-12"
          actions={<MockButton>Log video</MockButton>}
        >
          {d.videos.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Topic</Th>
                    <Th>Posted</Th>
                    <Th align="right">Views</Th>
                    <Th align="right">Likes</Th>
                    <Th align="right">Comments</Th>
                    <Th align="right">Shares</Th>
                    <Th align="right">Engagement</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.videos]
                    .sort((a, b) => b.views - a.views)
                    .map((v) => {
                      const eng = engagement(v)
                      return (
                        <tr key={v.id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                          <Td className="max-w-[380px] truncate">
                            <span className="font-medium text-ink">{v.title}</span>
                          </Td>
                          <Td>
                            <span className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3">
                              {topicLabel(v.topicType)}
                            </span>
                          </Td>
                          <Td>{fmtDate(v.postedAt) ?? <span className="text-ink-3">unposted</span>}</Td>
                          <Td align="right" className="font-semibold text-ink">{v.views > 0 ? fmtCount(v.views) : '—'}</Td>
                          <Td align="right">{v.views > 0 ? fmtCount(v.likes) : '—'}</Td>
                          <Td align="right">{v.views > 0 ? fmtCount(v.comments) : '—'}</Td>
                          <Td align="right">{v.views > 0 ? fmtCount(v.shares) : '—'}</Td>
                          <Td align="right">
                            {eng != null ? (
                              <span className={eng >= 0.08 ? 'font-medium text-gain' : ''}>{(eng * 100).toFixed(1)}%</span>
                            ) : (
                              <span className="text-ink-3">—</span>
                            )}
                          </Td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-4 text-ink-3">
                Ranked by lifetime views. Engagement turns green at ≥8% — a strong-video threshold, tune once there&apos;s data.
              </p>
            </div>
          ) : (
            <Empty
              title="No videos logged yet"
              hint="Log a posted video (or one still in edit) to rank it here with its engagement rate."
              action="Log first video"
            />
          )}
        </SectionCard>
      </div>
    </main>
  )
}

/* ------------------------ studio sub-nav (shared visual) ------------------------ */
// Same pattern on all three studio-v2 screens. Studio is now a sibling
// section of the app, not a separate shell — see README on the §8 reversal.

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

/* -------------------------------- empty state -------------------------------- */
// Shared pattern across studio-v2 — promote to components/next/ui.tsx during
// implementation (three screens use it; the investment screens could too).

function Empty({ title, hint, action }: { title: string; hint: string; action?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      <div className="max-w-[420px] text-[12px] leading-5 text-ink-3">{hint}</div>
      {action && <MockButton className="mt-2">{action}</MockButton>}
    </div>
  )
}

/* --------------------------------- mock button --------------------------------- */
// Visual spec only. Real ones open the (restyled) GrowthForm / VideoForm
// client modals from components/studio/dashboard — keep their behavior.

function MockButton({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={`rounded-chip border border-hairline bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:text-ink ${className}`}
    >
      {children}
    </button>
  )
}

/* --------------------------- follower line chart (SVG) --------------------------- */
// Single series → accent hue, no legend (title names it), direct label on
// the last point only, recessive grid, one axis pair, <title> hover on every
// point (≥8px hit targets via invisible halo).

function FollowerChart({ points }: { points: GrowthPoint[] }) {
  const W = 760, H = 240, PAD = { l: 44, r: 72, t: 16, b: 28 }
  const vals = points.map((p) => p.followers)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.followers).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const mid = points[Math.floor(points.length / 2)]

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img" aria-label={`Followers, ${points[0].date} to ${last.date}: ${min} to ${max}`} className="max-w-full">
        {/* recessive grid + single axis pair */}
        {[0.5].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={y(min + span * f)} y2={y(min + span * f)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(min)} y2={y(min)} stroke="var(--ink-3)" strokeWidth={1} />
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={y(min)} stroke="var(--ink-3)" strokeWidth={1} />
        {/* y ticks: min / mid / max only */}
        {[min, min + span / 2, max].map((v) => (
          <text key={v} x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-3)" className="tnum">
            {Math.round(v)}
          </text>
        ))}
        {/* x ticks: first / mid / last dates */}
        {[points[0], mid, last].map((p, i) => (
          <text
            key={p.date}
            x={x(points.indexOf(p))}
            y={H - PAD.b + 16}
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
            fontSize={10}
            fill="var(--ink-3)"
            className="tnum"
          >
            {p.date.slice(5)}
          </text>
        ))}
        {/* the series — thin 2px line, accent */}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* hover targets on every point (invisible halo, tooltip via <title>) */}
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.followers)} r={8} fill="transparent">
            <title>{`${p.date} — ${p.followers} followers · ${p.profileViews} profile views (${p.source})`}</title>
          </circle>
        ))}
        {/* last point: visible mark with 2px surface ring + direct label */}
        <circle cx={x(points.length - 1)} cy={y(last.followers)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
        <text x={x(points.length - 1) + 8} y={y(last.followers) + 3.5} fontSize={12} fontWeight={600} fill="var(--ink)" className="tnum">
          {last.followers}
        </text>
      </svg>
    </div>
  )
}
