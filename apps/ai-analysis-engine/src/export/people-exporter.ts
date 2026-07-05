// src/export/people-exporter.ts
import { writeFileSync } from 'fs'
import type { PeopleEvent } from '../analysis/people-analyzer.js'

export interface PeopleEventsJSON {
  schemaVersion?: string
  exportedAt:   string
  windowDays:   number
  tickers:      string[]
  events:       PeopleEvent[]
}

export function exportPeopleEvents(
  events: PeopleEvent[],
  options: { windowDays: number; tickers: string[]; outputPath: string },
): PeopleEventsJSON {
  const payload: PeopleEventsJSON = {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    windowDays: options.windowDays,
    tickers:    options.tickers,
    events,
  }
  writeFileSync(options.outputPath, JSON.stringify(payload, null, 2), 'utf-8')
  return payload
}
