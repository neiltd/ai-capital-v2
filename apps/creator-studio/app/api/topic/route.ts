import { NextResponse } from 'next/server'
import { pickDailyTopic } from '@/lib/topic-engine'

export async function GET() {
  try {
    const topic = pickDailyTopic()
    return NextResponse.json(topic)
  } catch (err) {
    console.error('Topic pick failed:', err)
    return NextResponse.json(
      { error: 'Could not load topic — check HUB_EXPORTS_PATH in .env.local' },
      { status: 500 }
    )
  }
}
