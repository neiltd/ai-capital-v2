import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/studio/db'
import { z } from 'zod'

const schema = z.object({
  title: z.string().min(1),
  tiktokId: z.string().optional(),
  views: z.number().int().min(0),
  likes: z.number().int().min(0),
  comments: z.number().int().min(0),
  shares: z.number().int().min(0),
  topicType: z.enum(['ai-news', 'personal-story', 'workforce']).default('ai-news'),
  followers: z.number().int().min(0).optional(),
  sessionId: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { title, tiktokId, views, likes, comments, shares, topicType, followers, sessionId } = parsed.data

  const video = await prisma.video.upsert({
    where: { tiktokId: tiktokId ?? `manual-${Date.now()}` },
    create: { title, tiktokId, views, likes, comments, shares, topicType, sessionId },
    update: { views, likes, comments, shares },
  })

  if (followers !== undefined) {
    await prisma.growthSnapshot.create({
      data: { followers, source: 'manual' },
    })
  }

  return NextResponse.json({ id: video.id })
}
