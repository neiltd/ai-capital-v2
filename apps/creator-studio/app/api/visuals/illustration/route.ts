import OpenAI from 'openai'
import { NextRequest, NextResponse } from 'next/server'

const openaiKey = process.env.OPENAI_API_KEY
if (!openaiKey) throw new Error('OPENAI_API_KEY not set — illustration generation requires OpenAI')
const openai = new OpenAI({ apiKey: openaiKey })

export async function POST(req: NextRequest) {
  const { prompt } = await req.json()

  const enhanced = `${prompt}. Style: clean modern digital art, dark background (#09090b), vibrant accent colors, tech aesthetic, cinematic composition, no text or words in image.`

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: enhanced,
    size: '1024x1792',
    quality: 'standard',
    n: 1,
  })

  return NextResponse.json({ url: response.data?.[0]?.url })
}
