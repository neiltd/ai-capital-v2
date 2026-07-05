import { NextRequest, NextResponse } from 'next/server'
import { anthropic } from '@/lib/studio/agent'
import { prisma } from '@/lib/studio/db'

const ACCEPTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB — screenshots only, well above any real use

// Simple in-memory fixed-window rate limiter — single-user local app, no
// external dependency needed.
let windowStart = 0
let requestCount = 0

export async function POST(req: NextRequest) {
  if (Date.now() - windowStart > 60_000) {
    windowStart = Date.now()
    requestCount = 0
  }
  requestCount++
  if (requestCount > 10) {
    return NextResponse.json({ error: 'Rate limit exceeded, try again shortly' }, { status: 429 })
  }

  const contentLength = Number(req.headers.get('content-length'))
  if (!Number.isFinite(contentLength) || contentLength > MAX_FILE_BYTES + 4096) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 413 })
  }

  const formData = await req.formData()
  const file = formData.get('screenshot') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }
  if (!ACCEPTED_MEDIA_TYPES.has(file.type)) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type || '(unknown)'}` }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const base64 = buffer.toString('base64')
  const mediaType = file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

  let text: string
  try {
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
    const block = response.content[0]
    text = block?.type === 'text' ? block.text : '{}'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/studio/upload] Anthropic request failed:', message)
    return NextResponse.json({ error: 'Failed to analyze screenshot' }, { status: 502 })
  }

  let stats: { followers: number; profileViews: number; videoViews: number }
  try {
    stats = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Could not parse stats from screenshot' }, { status: 422 })
  }

  if (typeof stats.followers === 'number') {
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
