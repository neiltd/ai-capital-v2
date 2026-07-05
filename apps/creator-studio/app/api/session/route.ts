import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
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
  chatHistory: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { topic, storyArc, visuals, notes, chatHistory } = parsed.data

  const session = await prisma.session.create({
    data: {
      topic: JSON.stringify(topic),
      storyArc: storyArc ? JSON.stringify(storyArc) : null,
      visuals: JSON.stringify(visuals),
      notes: notes ?? null,
      chatHistory: chatHistory ? JSON.stringify(chatHistory) : null,
    },
  })

  return NextResponse.json({ id: session.id })
}

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  })
  return NextResponse.json(
    sessions.map(s => ({
      ...s,
      topic: JSON.parse(s.topic),
      storyArc: s.storyArc ? JSON.parse(s.storyArc) : null,
      visuals: JSON.parse(s.visuals),
      chatHistory: s.chatHistory ? JSON.parse(s.chatHistory) : null,
    }))
  )
}
