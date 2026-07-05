import { NextRequest, NextResponse } from 'next/server'
import { syncTikTokStats, rebuildWeights } from '@/lib/growth-tracker'

export async function POST(req: NextRequest) {
  const accessToken = req.headers.get('x-tiktok-token') ?? process.env.TIKTOK_ACCESS_TOKEN

  if (!accessToken) {
    return NextResponse.json({ error: 'No TikTok access token' }, { status: 401 })
  }

  try {
    const stats = await syncTikTokStats(accessToken)
    const weights = await rebuildWeights()
    return NextResponse.json({ synced: true, stats, weights })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
