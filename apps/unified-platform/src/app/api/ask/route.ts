import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { readAnalysis, readBriefing, readSimulation, readProfile, readWaves, readWaveActions, readMacro } from '@/lib/data'
import { readTheses } from '@/lib/thesis-db'

// Simple in-memory fixed-window rate limiter — single-user local app, no
// external dependency needed.
let windowStart = 0
let requestCount = 0

export async function POST(req: NextRequest) {
  if (Date.now() - windowStart > 60_000) {
    windowStart = Date.now()
    requestCount = 0
  }
  requestCount++
  if (requestCount > 10) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded, try again shortly' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const today = new Date().toISOString().split('T')[0]

  const briefing = readBriefing(today)
  if (!briefing) {
    return new Response(
      JSON.stringify({ error: 'No briefing for today — run npm run brief' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let body: { question?: string }
  try {
    body = await req.json() as { question: string }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }
  if (!body.question?.trim()) {
    return new Response(
      JSON.stringify({ error: 'question is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }
  if (body.question.length > 2000) {
    return new Response(
      JSON.stringify({ error: 'question is too long (max 2000 characters)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let analysis, simulation
  try { analysis   = readAnalysis()   } catch (e) { return new Response(JSON.stringify({ error: `analysis.json missing — run npm run analyze` }), { status: 503, headers: { 'Content-Type': 'application/json' } }) }
  try { simulation = readSimulation() } catch (e) { return new Response(JSON.stringify({ error: `simulation.json missing — run npm run simulate` }), { status: 503, headers: { 'Content-Type': 'application/json' } }) }
  const profile    = readProfile()
  const waves      = (() => { try { return readWaves() } catch { return null } })()
  const waveActions = (() => { try { return readWaveActions() } catch { return null } })()
  const macro      = (() => { try { return readMacro() } catch { return null } })()
  const thesis     = (() => { try { return readTheses() } catch { return null } })()

  const waveSignalsSummary = waveActions?.actions
    .filter(a => a.signal !== 'no-signal')
    .map(a => `${a.ticker}: ${a.signal.toUpperCase()} wave${a.currentWave} conf=${a.confidence}% R:R=${a.riskReward ?? '—'}x`)
    .join('\n') ?? ''

  const thesisSummary = thesis?.theses
    .map(t => `${t.ticker} (${t.type}, ${t.positionSize})`)
    .join(', ') ?? ''

  const systemPrompt = `You are an AI investment analyst assistant. Answer questions grounded in the data below.
${profile ? `\nInvestor profile:\n${profile}` : ''}

Today's briefing:
${briefing}

Macro regime: ${analysis.latestRegime.regime} (confidence: ${analysis.latestRegime.confidence})
${macro ? `Macro as of ${macro.asOf}: ${macro.marketAssets.map(a => `${a.ticker} ${a.changePct1d >= 0 ? '+' : ''}${a.changePct1d.toFixed(1)}%`).join(', ')}` : ''}

Simulation scenarios: ${JSON.stringify(simulation.scenarios.map(s => ({ type: s.scenarioType, prob: s.probability, title: s.title })))}
Portfolio positions: ${JSON.stringify(simulation.portfolio, null, 2)}
Recommended actions: ${JSON.stringify(simulation.actions, null, 2)}
${waveSignalsSummary ? `\nElliott Wave signals (as of ${waveActions?.asOf}):\n${waveSignalsSummary}` : ''}
${waves ? `\nWave analysis covers ${waves.assets.length} assets as of ${waves.asOf}` : ''}
${thesisSummary ? `\nActive theses: ${thesisSummary}` : ''}

Be concise and direct. Cite specific data. Use Markdown formatting.`

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: body.question }],
  })

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(new TextEncoder().encode(event.delta.text))
          }
        }
      } catch (err) {
        controller.error(err)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
