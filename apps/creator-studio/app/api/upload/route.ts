import { NextRequest, NextResponse } from 'next/server'
import { anthropic } from '@/lib/agent'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('screenshot') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const base64 = buffer.toString('base64')
  const mediaType = (file.type as 'image/jpeg' | 'image/png' | 'image/webp') ?? 'image/jpeg'

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: 'This is a TikTok analytics screenshot. Extract these numbers and return ONLY valid JSON: { "followers": number, "profileViews": number, "videoViews": number }. Use 0 for any value you cannot find.',
          },
        ],
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  let stats: { followers: number; profileViews: number; videoViews: number }
  try {
    stats = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Could not parse stats from screenshot' }, { status: 422 })
  }

  if (stats.followers) {
    await prisma.growthSnapshot.create({
      data: {
        followers: stats.followers,
        profileViews: stats.profileViews ?? 0,
        source: 'screenshot',
      },
    })
  }

  return NextResponse.json(stats)
}
