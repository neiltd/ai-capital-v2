import { prisma } from '@/lib/db'
import { FollowerChart } from '@/components/dashboard/FollowerChart'
import { TopVideosTable } from '@/components/dashboard/TopVideosTable'
import { TopicHeatmap } from '@/components/dashboard/TopicHeatmap'
import { DashboardActions } from '@/components/dashboard/DashboardActions'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const [snapshots, videos] = await Promise.all([
    prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' }, take: 30 }),
    prisma.video.findMany({ orderBy: { views: 'desc' }, take: 20 }),
  ])

  const latestFollowers = snapshots.at(-1)?.followers ?? 0
  const totalViews = videos.reduce((s, v) => s + v.views, 0)
  const totalLikes = videos.reduce((s, v) => s + v.likes, 0)

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-bold">Dashboard</h1>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Today</Link>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Followers', value: latestFollowers.toLocaleString() },
          { label: 'Total Views', value: totalViews.toLocaleString() },
          { label: 'Total Likes', value: totalLikes.toLocaleString() },
        ].map(stat => (
          <div key={stat.label} className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
            <p className="text-xs text-zinc-400">{stat.label}</p>
            <p className="text-2xl font-bold mt-1">{stat.value || '—'}</p>
          </div>
        ))}
      </div>

      <DashboardActions />

      <FollowerChart data={snapshots.map(s => ({ date: s.date.toISOString(), followers: s.followers }))} />
      <TopicHeatmap videos={videos.map(v => ({ topicType: v.topicType, views: v.views }))} />
      <TopVideosTable videos={videos.map(v => ({ id: v.id, title: v.title, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, topicType: v.topicType }))} />
    </div>
  )
}
