export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { resolveProposal } from '@/lib/thesis-db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: { decision?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.decision !== 'accept' && body.decision !== 'reject') {
    return NextResponse.json({ ok: false, error: 'decision must be "accept" or "reject"' }, { status: 400 })
  }

  const result = resolveProposal(params.id, body.decision)
  if (!result.ok) {
    return NextResponse.json(result, { status: 409 })
  }
  return NextResponse.json(result)
}
