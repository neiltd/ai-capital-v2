export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readProposals } from '@/lib/thesis-db'

export async function GET() {
  try {
    const data = readProposals()
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
