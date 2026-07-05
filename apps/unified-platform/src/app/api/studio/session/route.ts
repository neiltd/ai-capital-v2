import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/studio/db'
import { z } from 'zod'

const schema = z.object({
  topic: z.object({
    eventId: z.string(),
    title: z.string(),
    summary: z.string(),
    suggestedAngle: z.string(),
    suggestedVisualType: z.string(),
  }),
  storyArc: z.object({
    hook: z.string(),
    beats: z.array(z.string()),
    personalAngle: z.string(),
    cta: z.string(),
  }).optional(),
  visuals: z.array(z.object({ type: z.string(), url: z.string().optional(), label: z.string() })).default([]),
  notes: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { topic, storyArc, visuals, notes } = parsed.data

  const session = await prisma.session.create({
    data: {
      topic: JSON.stringify(topic),
      storyArc: storyArc ? JSON.stringify(storyArc) : null,
      visuals: JSON.stringify(visuals),
      notes,
    },
  })

  return NextResponse.json({ id: session.id })
}

function safeParse<T>(raw: string | null, fallback: T, field: string): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    console.warn(`[api/studio/session] failed to parse ${field} for session`)
    return fallback
  }
}

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  })
  return NextResponse.json(
    sessions.map(s => ({
      ...s,
      topic: safeParse(s.topic, null, 'topic'),
      storyArc: safeParse(s.storyArc, null, 'storyArc'),
      visuals: safeParse(s.visuals, [], 'visuals'),
    }))
  )
}
