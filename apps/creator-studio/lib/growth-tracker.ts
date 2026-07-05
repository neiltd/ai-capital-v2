import { prisma } from './db'
import { writeFileSync } from 'fs'
import { join } from 'path'

const WEIGHTS_PATH = join(process.cwd(), 'data/performance-weights.json')

export async function syncTikTokStats(accessToken: string) {
  const res = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=follower_count,profile_deep_link',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  )

  if (!res.ok) throw new Error(`TikTok API error: ${res.status}`)
  const data = await res.json()
  const followers = data?.data?.user?.follower_count ?? 0

  await prisma.growthSnapshot.create({
    data: { followers, source: 'api' },
  })

  return { followers }
}

export async function rebuildWeights() {
  const videos = await prisma.video.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })

  if (videos.length === 0) return

  const grouped: Record<string, { totalViews: number; count: number }> = {}
  for (const v of videos) {
    if (!grouped[v.topicType]) grouped[v.topicType] = { totalViews: 0, count: 0 }
    grouped[v.topicType].totalViews += v.views
    grouped[v.topicType].count += 1
  }

  const avgViews =
    Object.values(grouped).reduce((s, g) => s + g.totalViews / g.count, 0) /
    Object.keys(grouped).length

  const weights: Record<string, number> = {}
  for (const [type, g] of Object.entries(grouped)) {
    weights[type] = (g.totalViews / g.count) / avgViews
  }

  writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2))
  return weights
}
