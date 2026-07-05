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

export function loadWorldIntelligence(): HubEvent[] {
  const filePath = join(HUB_PATH, 'world-map/intelligence.json')
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  if (!raw?.events || !Array.isArray(raw.events)) {
    throw new Error(`Invalid hub export at ${filePath}: missing events array`)
  }
  return raw.events as HubEvent[]
}
