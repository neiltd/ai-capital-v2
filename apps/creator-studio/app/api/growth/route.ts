import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  followers: z.number().int(),
  profileViews: z.number().int().default(0),
  source: z.enum(['manual', 'api', 'screenshot']).default('manual'),
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

  const snapshot = await prisma.growthSnapshot.create({ data: parsed.data })
  return NextResponse.json(snapshot)
}

export async function GET() {
  const snapshots = await prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' } })
  return NextResponse.json(snapshots)
}
