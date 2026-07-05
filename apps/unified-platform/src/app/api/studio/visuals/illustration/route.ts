import OpenAI from 'openai'
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  if (!checkRateLimit('studio:illustration')) {
    return NextResponse.json({ error: 'Rate limit exceeded, try again shortly' }, { status: 429 })
  }

  let body: { prompt?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { prompt } = body
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }
  if (prompt.length > 1000) {
    return NextResponse.json({ error: 'prompt is too long (max 1000 characters)' }, { status: 400 })
  }

  // Instantiate lazily so build-time static analysis doesn't require OPENAI_API_KEY
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })

  const enhanced = `${prompt}. Style: clean modern digital art, dark background (#09090b), vibrant accent colors, tech aesthetic, cinematic composition, no text or words in image.`

  let response
  try {
    response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: enhanced,
      size: '1024x1792',
      quality: 'standard',
      n: 1,
    })
  } catch {
    return NextResponse.json({ error: 'Image generation failed' }, { status: 502 })
  }

  return NextResponse.json({ url: response.data?.[0]?.url })
}
