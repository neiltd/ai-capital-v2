import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { WaveAsset, WavePivot, TradeAction, TradeSignal } from '../types.js'

export function roundConfidence(c: number): number {
  return Math.round(c / 5) * 5
}

export function computeSignal(
  currentWave: string | null,
  waveDirection: 'up' | 'down' | null,
  confidence: number,
): TradeSignal {
  if (!currentWave || confidence < 50) return 'no-signal'
  const wave = currentWave.toString()
  if (wave === '3' || wave === '5') {
    if (waveDirection === 'up')   return 'buy'
    if (waveDirection === 'down') return 'sell'
  }
  if (['2', '4', 'A', 'B', 'C'].includes(wave)) return 'watch'
  return 'no-signal'
}

export function computePrices(
  currentWave: string,
  waveDirection: 'up' | 'down' | null,
  close: number,
  pivots: WavePivot[],
): { entryZone: { low: number; high: number } | null; stopLoss: number | null; target: number | null; riskReward: number | null } {
  const pivot = (label: string) => pivots.find(p => p.label === label)?.price ?? null
  const entryZone = { low: close * 0.98, high: close * 1.02 }

  let stopLoss: number | null = null
  let target: number | null = null

  if (currentWave === '3' && waveDirection === 'up') {
    const w0 = pivot('0'), w1 = pivot('1'), w2 = pivot('2')
    if (w2 !== null) stopLoss = w2
    if (w0 !== null && w1 !== null && w2 !== null) target = w2 + (w1 - w0) * 1.618
  } else if (currentWave === '5' && waveDirection === 'up') {
    const w0 = pivot('0'), w1 = pivot('1'), w4 = pivot('4')
    if (w4 !== null) stopLoss = w4
    if (w0 !== null && w1 !== null && w4 !== null) target = w4 + (w1 - w0) * 1.618
  } else if (currentWave === '3' && waveDirection === 'down') {
    const w0 = pivot('0'), w1 = pivot('1'), w2 = pivot('2')
    if (w2 !== null) stopLoss = w2
    if (w0 !== null && w1 !== null && w2 !== null) target = w2 - (w0 - w1) * 1.618
  } else if (currentWave === '5' && waveDirection === 'down') {
    const w0 = pivot('0'), w1 = pivot('1'), w4 = pivot('4')
    if (w4 !== null) stopLoss = w4
    if (w0 !== null && w1 !== null && w4 !== null) target = w4 - (w0 - w1) * 1.618
  }

  if (stopLoss === null || target === null) {
    return { entryZone, stopLoss, target, riskReward: null }
  }

  const entryMid = (entryZone.low + entryZone.high) / 2
  const rr = Math.abs(target - entryMid) / Math.abs(entryMid - stopLoss)
  const riskReward = rr > 0 ? Number(rr.toFixed(2)) : null

  return { entryZone, stopLoss, target, riskReward }
}

type NarrativeCache = Record<string, string>

function loadNarrativeCache(cachePath: string): NarrativeCache {
  try {
    if (!existsSync(cachePath)) return {}
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch { return {} }
}

function saveNarrativeCache(cachePath: string, cache: NarrativeCache): void {
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache, null, 2))
}

async function generateNarrative(
  asset: WaveAsset,
  action: Omit<TradeAction, 'narrative'>,
  client: Anthropic,
): Promise<string> {
  const pivotLines = asset.wavePivots
    .map(p => `Wave ${p.label}: $${p.price} (${p.date})`)
    .join(', ')

  const prompt = `You are a technical analyst. Write a 3-sentence trade rationale for this Elliott Wave setup.
Focus on: (1) what wave structure is forming, (2) why the entry zone makes sense, (3) what invalidates the trade. Be specific with price levels. No fluff.

Ticker: ${action.ticker}
Current wave: ${action.currentWave} (${action.waveDirection})
Entry zone: $${action.entryZone?.low.toFixed(0)} – $${action.entryZone?.high.toFixed(0)}
Stop loss: $${action.stopLoss?.toFixed(0) ?? 'N/A'}
Target: $${action.target?.toFixed(0) ?? 'N/A'}
R:R: ${action.riskReward ?? 'N/A'}x
Confidence: ${action.confidence}%
Wave pivots: ${pivotLines}`

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = res.content.find(b => b.type === 'text')
    return block && block.type === 'text' ? block.text : 'Elliott Wave structure in progress.'
  } catch {
    return 'Elliott Wave structure in progress.'
  }
}

export async function generateActions(assets: WaveAsset[], cachePath: string): Promise<TradeAction[]> {
  const client = new Anthropic()
  const cache = loadNarrativeCache(cachePath)
  const results: TradeAction[] = []
  let cacheUpdated = false

  for (const a of assets) {
    const close = a.candles[a.candles.length - 1]?.close ?? 0
    const signal = computeSignal(a.currentWave, a.waveDirection, a.confidence)
    const prices = (signal !== 'no-signal' && a.currentWave)
      ? computePrices(a.currentWave, a.waveDirection, close, a.wavePivots)
      : { entryZone: null, stopLoss: null, target: null, riskReward: null }

    const narrativeKey = `${a.ticker}:${a.currentWave ?? 'null'}:${roundConfidence(a.confidence)}`
    let narrative = ''

    if (signal === 'buy' || signal === 'sell') {
      if (cache[narrativeKey]) {
        narrative = cache[narrativeKey]
      } else {
        const partial: Omit<TradeAction, 'narrative'> = {
          ticker: a.ticker, label: a.label,
          currentWave: a.currentWave ?? null, waveDirection: a.waveDirection ?? null,
          confidence: a.confidence, signal, narrativeKey,
          generatedAt: new Date().toISOString(),
          ...prices,
        }
        narrative = await generateNarrative(a, partial, client)
        cache[narrativeKey] = narrative
        cacheUpdated = true
      }
    }

    results.push({
      ticker: a.ticker, label: a.label,
      currentWave: a.currentWave ?? null, waveDirection: a.waveDirection ?? null,
      confidence: a.confidence, signal, narrativeKey,
      generatedAt: new Date().toISOString(),
      narrative,
      ...prices,
    })
  }

  if (cacheUpdated) saveNarrativeCache(cachePath, cache)
  return results
}
