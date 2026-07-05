export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { readTheses } from '@/lib/thesis-db'
import { readBriefing, readAnalysis } from '@/lib/data'
import { checkRateLimit } from '@/lib/rate-limit'

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed, use POST' }, { status: 405 })
}

export async function POST() {
  if (!checkRateLimit('thesis-proposals')) {
    return NextResponse.json({ error: 'Rate limit exceeded, try again shortly' }, { status: 429 })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })
  }

  const today = new Date().toISOString().split('T')[0]
  const briefing = readBriefing(today)
  let thesisData
  try { thesisData = readTheses() } catch { thesisData = null }

  if (!thesisData || thesisData.theses.length === 0) {
    return NextResponse.json({ proposals: [] })
  }

  const analysis = (() => { try { return readAnalysis() } catch { return null } })()

  const thesisSummary = thesisData.theses.map(t => {
    const assumptions = thesisData.assumptions.filter(a => a.thesisId === t.id)
    const lines = assumptions.map(a => `  - ${a.label}: ${a.status}${a.lastEvidenceSummary ? ` (${a.lastEvidenceSummary.slice(0, 80)})` : ''}`)
    return `${t.ticker} (${t.type}, ${t.positionSize}):\n${lines.join('\n') || '  (no assumptions)'}`
  }).join('\n\n')

  const contextBlock = [
    analysis ? `Regime: ${analysis.latestRegime.regime} (${analysis.latestRegime.confidence})` : '',
    briefing ? `\nLatest briefing (${today}):\n${briefing.slice(0, 3000)}` : '(no briefing today)',
  ].filter(Boolean).join('\n')

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are an investment thesis analyst. Review the current investment theses and today's market data, then suggest specific updates.
For each thesis that has meaningful new evidence, propose: (1) which assumption status should change, (2) why, citing specific data.
Only flag theses with actionable evidence. Return JSON array of proposals.`,
    messages: [{
      role: 'user',
      content: `Current theses:\n${thesisSummary}\n\nMarket context:\n${contextBlock}\n\nReturn a JSON array of proposals. Each item: { ticker, assumption, currentStatus, proposedStatus, rationale }. Empty array if nothing material.`,
    }],
  })

  const block = message.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') return NextResponse.json({ proposals: [] })

  try {
    const jsonMatch = block.text.match(/\[[\s\S]*\]/)
    const proposals = jsonMatch ? JSON.parse(jsonMatch[0]) : []
    return NextResponse.json({ proposals, generatedAt: new Date().toISOString() })
  } catch {
    return NextResponse.json({ proposals: [], raw: block.text })
  }
}
