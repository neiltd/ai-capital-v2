// Loader for /studio. Real Prisma reads against creator-studio's own DB
// (separate deploy target, zero coupling to the investment pipeline).
//
// The design mockup's 5-stage kanban board (idea/scripted/filmed/edited/
// posted) has no real backing — the Session/Video schema has no `status`
// column (gap #26). Rather than fabricate stages, this shows real Session
// rows as a flat "in flight" list (no video linked yet) and a real
// posted-video list, both from actual schema fields. All three Prisma
// tables (Session, Video, GrowthSnapshot) are currently empty — same
// honest-empty-state situation as /markets/waves/trade.

import { prisma } from '@/lib/studio/db'

export interface SessionVM {
  id: string
  title: string
  summary: string
  createdAt: string
}

export interface VideoVM {
  id: string
  title: string
  postedAt: string | null
  views: number
  likes: number
  comments: number
  shares: number
}

export interface StudioViewModel {
  inFlight: SessionVM[]
  recentPosts: VideoVM[]
  latestFollowers: number | null
  followerSeries: number[]
}

function parseTopic(raw: string): { title: string; summary: string } {
  try {
    const t = JSON.parse(raw) as { title?: string; summary?: string }
    return { title: t.title ?? 'Untitled', summary: t.summary ?? '' }
  } catch {
    return { title: 'Untitled', summary: '' }
  }
}

export async function loadStudio(): Promise<StudioViewModel | null> {
  try {
    const [sessions, videos, snapshots] = await Promise.all([
      prisma.session.findMany({ where: { videoId: null }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.video.findMany({ orderBy: { views: 'desc' }, take: 20 }),
      prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' }, take: 30 }),
    ])

    return {
      inFlight: sessions.map((s) => {
        const { title, summary } = parseTopic(s.topic)
        return { id: s.id, title, summary, createdAt: s.createdAt.toISOString() }
      }),
      recentPosts: videos.map((v) => ({
        id: v.id,
        title: v.title,
        postedAt: v.postedAt?.toISOString() ?? null,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
      })),
      latestFollowers: snapshots.at(-1)?.followers ?? null,
      followerSeries: snapshots.map((s) => s.followers),
    }
  } catch {
    return null
  }
}
