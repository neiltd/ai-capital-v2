export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readAnalysis, readSimulation, readGraph, readStockIntel, readWorldIntel } from '@/lib/data'

export async function GET() {
  try {
    const analysis = readAnalysis()
    const simulation = readSimulation()
    const graph = readGraph()
    const stockIntel = readStockIntel()
    const worldIntel = readWorldIntel()
    return NextResponse.json({ analysis, simulation, graph, stockIntel, worldIntel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
