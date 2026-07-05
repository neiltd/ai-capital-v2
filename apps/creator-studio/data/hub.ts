import { readFileSync } from 'fs'
import { join } from 'path'

const HUB_PATH =
  process.env.HUB_EXPORTS_PATH ??
  join(process.cwd(), '../world-intelligence-data-hub-/exports')

export interface HubEvent {
  eventId: string
  title: string
  summary: string
  eventType: string
  eventState: string
  severity: number
  confidence: number
  marketRelevance: number
  geopoliticalRelevance: number
  firstSeenAt: string
  latestSeenAt: string
  countries: string[]
  sourceIds: string[]
}

const parsedFreshnessDays = Number(process.env.HUB_FRESHNESS_DAYS ?? 7)
const FRESHNESS_DAYS =
  Number.isFinite(parsedFreshnessDays) && parsedFreshnessDays > 0 ? parsedFreshnessDays : 7

export function loadWorldIntelligence(): HubEvent[] {
  const filePath = join(HUB_PATH, 'world-map/intelligence.json')
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  if (!raw?.events || !Array.isArray(raw.events)) {
    throw new Error(`Invalid hub export at ${filePath}: missing events array`)
  }
  const all = raw.events as HubEvent[]
  const cutoff = Date.now() - FRESHNESS_DAYS * 86_400_000
  const fresh = all.filter(e => {
    const ts = new Date(e.latestSeenAt || e.firstSeenAt).getTime()
    return Number.isFinite(ts) && ts >= cutoff
  })
  // fallback: if nothing is within the window, return top-10 by most recent latestSeenAt
  if (fresh.length === 0) {
    return [...all]
      .sort((a, b) =>
        new Date(b.latestSeenAt || b.firstSeenAt).getTime() -
        new Date(a.latestSeenAt || a.firstSeenAt).getTime()
      )
      .slice(0, 10)
  }
  return fresh
}
