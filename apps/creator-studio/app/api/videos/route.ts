import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  title: z.string().min(1),
  tiktokId: z.string().optional(),
  postedAt: z.string().datetime().optional(),
  views: z.number().int().default(0),
  likes: z.number().int().default(0),
  comments: z.number().int().default(0),
  shares: z.number().int().default(0),
  topicType: z.string().default('ai-news'),
  sessionId: z.string().optional(),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const video = await prisma.video.create({
    data: {
      ...parsed.data,
      postedAt: parsed.data.postedAt ? new Date(parsed.data.postedAt) : null,
    },
  })
  return NextResponse.json(video)
}

export async function GET() {
  const videos = await prisma.video.findMany({ orderBy: { postedAt: 'desc' } })
  return NextResponse.json(videos)
}
