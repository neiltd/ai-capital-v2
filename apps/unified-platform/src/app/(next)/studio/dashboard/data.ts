// Loader for /studio/dashboard. Real Prisma reads (no fetch — server
// component), per docs/frontend-migration-plan-2026-07-07.md §1.5.
// All three tables are currently empty in production.

import { prisma } from '@/lib/studio/db'

export interface GrowthPoint {
  date: string
  followers: number
  profileViews: number
  source: string
}

export interface VideoRow {
  id: string
  title: string
  topicType: string
  postedAt: string | null
  views: number
  likes: number
  comments: number
  shares: number
}

export interface StudioDashboardVM {
  generatedAt: string
  snapshots: GrowthPoint[]
  videos: VideoRow[]
  sessionCount: number
}

export async function loadStudioDashboard(): Promise<StudioDashboardVM | null> {
  try {
    const [snapshots, videos, sessionCount] = await Promise.all([
      prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' } }),
      prisma.video.findMany({ orderBy: { views: 'desc' } }),
      prisma.session.count(),
    ])

    return {
      generatedAt: new Date().toISOString(),
      snapshots: snapshots.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        followers: s.followers,
        profileViews: s.profileViews,
        source: s.source,
      })),
      videos: videos.map((v) => ({
        id: v.id,
        title: v.title,
        topicType: v.topicType,
        postedAt: v.postedAt?.toISOString().slice(0, 10) ?? null,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
      })),
      sessionCount,
    }
  } catch {
    return null
  }
}
