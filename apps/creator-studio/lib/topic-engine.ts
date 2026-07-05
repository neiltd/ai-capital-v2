import { loadWorldIntelligence, HubEvent } from '@/data/hub'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'llm', 'openai',
  'anthropic', 'google', 'microsoft', 'nvidia', 'robot', 'automation',
  'chatgpt', 'gemini', 'model', 'algorithm', 'tech', 'silicon', 'startup',
]
const INVESTOR_KEYWORDS = [
  'funding', 'raised', 'valuation', 'ipo', 'acquisition', 'merger',
  'revenue', 'billion', 'million', 'market', 'investment', 'stock',
]
const PERSONAL_KEYWORDS = [
  'jobs', 'workforce', 'immigration', 'visa', 'salary', 'layoffs',
  'hiring', 'remote', 'h1b', 'workers', 'employment',
]

type VisualType = 'chart' | 'card' | 'illustration'

interface PerformanceWeights {
  [category: string]: number
}

export interface ScoredStory {
  eventId: string
  title: string
  summary: string
  eventType: string
  firstSeenAt: string
  latestSeenAt: string
  countries: string[]
  sourceIds: string[]
  score: number
  suggestedAngle: string
  suggestedVisualType: VisualType
}

function loadWeights(): PerformanceWeights {
  const path = join(process.cwd(), 'data/performance-weights.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
}

function scoreEvent(event: HubEvent, weights: PerformanceWeights): number {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  let score = 0

  const ageHours = Math.max(0, (Date.now() - new Date(event.latestSeenAt || event.firstSeenAt).getTime()) / 3_600_000)
  score += 20 * Math.pow(0.5, ageHours / 36) // exponential half-life: 20 pts → halves every 36h

  score += AI_KEYWORDS.filter(k => text.includes(k)).length * 3
  score += INVESTOR_KEYWORDS.filter(k => text.includes(k)).length * 2
  score += PERSONAL_KEYWORDS.filter(k => text.includes(k)).length * 2
  score += event.marketRelevance * 5

  return score * (weights[event.eventType] ?? 1.0)
}

function suggestAngle(event: HubEvent): string {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  if (PERSONAL_KEYWORDS.some(k => text.includes(k))) {
    return 'workforce angle — tie to your experience watching the US job market as an immigrant'
  }
  if (INVESTOR_KEYWORDS.some(k => text.includes(k))) {
    return 'investor angle — who wins, who loses, what does this mean for money'
  }
  return 'LA perspective — how this shows up in your day-to-day in tech-heavy LA'
}

function suggestVisualType(event: HubEvent): VisualType {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  if (INVESTOR_KEYWORDS.some(k => text.includes(k))) return 'chart'
  if (event.severity >= 3) return 'card'
  return 'illustration'
}

export function pickDailyTopic(): ScoredStory {
  const events = loadWorldIntelligence()
  const weights = loadWeights()

  const scored = events.map(event => ({
    eventId: event.eventId,
    title: event.title,
    summary: event.summary,
    eventType: event.eventType,
    firstSeenAt: event.firstSeenAt,
    latestSeenAt: event.latestSeenAt || event.firstSeenAt,
    countries: event.countries,
    sourceIds: event.sourceIds,
    score: scoreEvent(event, weights),
    suggestedAngle: suggestAngle(event),
    suggestedVisualType: suggestVisualType(event),
  }))

  if (scored.length === 0) throw new Error('No hub events available — check HUB_EXPORTS_PATH')
  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}
