export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readAnalysis, readBriefing, readSimulation } from '@/lib/data'

export async function GET() {
  const today = new Date().toISOString().split('T')[0]

  try {
    const analysis = readAnalysis()
    const simulation = readSimulation()
    const markdown = readBriefing(today)

    if (!markdown) {
      return NextResponse.json({
        date: today,
        markdown: '',
        regime: analysis.latestRegime.regime,
        confidence: analysis.latestRegime.confidence,
        scenarios: simulation.scenarios.map(s => ({
          scenarioType: s.scenarioType,
          title: s.title,
          probability: s.probability,
          timeHorizon: s.timeHorizon,
        })),
        missing: true,
      })
    }

    return NextResponse.json({
      date: today,
      markdown,
      regime: analysis.latestRegime.regime,
      confidence: analysis.latestRegime.confidence,
      scenarios: simulation.scenarios.map(s => ({
        scenarioType: s.scenarioType,
        title: s.title,
        probability: s.probability,
        timeHorizon: s.timeHorizon,
      })),
      missing: false,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
