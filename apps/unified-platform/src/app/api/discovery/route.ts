import { NextResponse } from 'next/server'
import { readDiscovery } from '@/lib/data'
import type { DiscoveryResponse } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse<DiscoveryResponse>> {
  const discovery = readDiscovery()
  return NextResponse.json({ discovery, missing: discovery === null })
}
