import { prisma } from '@/lib/studio/db'
import { FollowerChart } from '@/components/studio/dashboard/FollowerChart'
import { TopVideosTable } from '@/components/studio/dashboard/TopVideosTable'
import { TopicHeatmap } from '@/components/studio/dashboard/TopicHeatmap'
import { DashboardActions } from '@/components/studio/dashboard/DashboardActions'
import Link from 'next/link'
import { PageHeader } from '@/components/capital/ui/PageHeader'
import { StatCard } from '@/components/capital/ui/StatCard'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Sparkline } from '@/components/capital/ui/Sparkline'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  let snapshots: Awaited<ReturnType<typeof prisma.growthSnapshot.findMany>> = []
  let videos: Awaited<ReturnType<typeof prisma.video.findMany>> = []
  let dbError: string | null = null

  try {
    ;[snapshots, videos] = await Promise.all([
      prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' }, take: 30 }),
      prisma.video.findMany({ orderBy: { views: 'desc' }, take: 20 }),
    ])
  } catch (err: unknown) {
    dbError = err instanceof Error ? err.message : 'Database unavailable'
  }

  const latestFollowers = snapshots.at(-1)?.followers ?? 0
  // growthSnapshot is the only model with a genuine daily time series — video
  // totals are lifetime counters per clip, not a series — so only the
  // Followers stat gets a sparkline.
  const followerSeries = snapshots.map(s => s.followers)

  const totalViews = videos.reduce((s, v) => s + v.views, 0)
  const totalLikes = videos.reduce((s, v) => s + v.likes, 0)
  const totalComments = videos.reduce((s, v) => s + v.comments, 0)
  const totalShares = videos.reduce((s, v) => s + v.shares, 0)
  const avgEngagementPct = totalViews > 0 ? ((totalLikes + totalComments + totalShares) / totalViews) * 100 : null

  return (
    <div className="min-h-screen p-4 space-y-4 max-w-2xl mx-auto">
      <PageHeader
        title="Dashboard"
        actions={
          <Link href="/studio" className="text-xs text-text-inactive hover:text-text-secondary transition-colors">
            ← Today
          </Link>
        }
      />

      {dbError && (
        <EmptyState
          tone="warning"
          title="Database not configured"
          description={
            <>
              Run <code className="font-mono text-indigo-active">npx prisma migrate dev</code> and set{' '}
              <code className="font-mono text-indigo-active">DATABASE_URL</code> to enable persistence.
            </>
          }
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Followers"
          value={latestFollowers > 0 ? latestFollowers.toLocaleString() : '—'}
          icon={followerSeries.length >= 2 ? <Sparkline values={followerSeries} width={56} height={20} /> : undefined}
          sub={snapshots.length > 0 ? `${snapshots.length} day${snapshots.length === 1 ? '' : 's'} logged` : 'no snapshots yet'}
        />
        <StatCard
          label="Total Views"
          value={totalViews > 0 ? totalViews.toLocaleString() : '—'}
          sub={`${videos.length} video${videos.length === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Total Likes"
          value={totalLikes > 0 ? totalLikes.toLocaleString() : '—'}
        />
        <StatCard
          label="Avg Engagement"
          value={avgEngagementPct != null ? `${avgEngagementPct.toFixed(1)}%` : '—'}
          sub="(likes+comments+shares)/views"
          tone="accent"
        />
      </div>

      <DashboardActions />

      {snapshots.length > 0 ? (
        <FollowerChart data={snapshots.map(s => ({ date: s.date.toISOString(), followers: s.followers }))} />
      ) : (
        <EmptyState
          icon="📈"
          title="No growth snapshots yet"
          description="Log a follower snapshot to start charting growth over time."
        />
      )}

      <TopicHeatmap videos={videos.map(v => ({ topicType: v.topicType, views: v.views }))} />

      {videos.length > 0 ? (
        <TopVideosTable videos={videos.map(v => ({ id: v.id, title: v.title, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, topicType: v.topicType }))} />
      ) : (
        <EmptyState
          icon="🎬"
          title="No videos logged yet"
          description="Add a video to see it ranked here with engagement rate."
        />
      )}
    </div>
  )
}
