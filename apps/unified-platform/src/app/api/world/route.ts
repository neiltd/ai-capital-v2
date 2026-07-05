export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readStockIntel, readWorldIntel } from '@/lib/data'

export async function GET() {
  try {
    const stockIntel = readStockIntel()
    const worldIntel = readWorldIntel()
    return NextResponse.json({ stockIntel, worldIntel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
