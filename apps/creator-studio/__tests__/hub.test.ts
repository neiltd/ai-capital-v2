import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadWorldIntelligence, HubEvent } from '@/data/hub'
import * as fs from 'fs'

vi.mock('fs')

describe('loadWorldIntelligence', () => {
  const mockEvent: HubEvent = {
    eventId: 'abc123',
    title: 'OpenAI raises $10B',
    summary: 'OpenAI announced massive funding round',
    eventType: 'economic_data_release',
    eventState: 'emerging',
    severity: 2,
    confidence: 0.9,
    marketRelevance: 0.9,
    geopoliticalRelevance: 0.3,
    firstSeenAt: new Date().toISOString(),
    latestSeenAt: new Date().toISOString(),
    countries: ['USA'],
    sourceIds: ['techcrunch'],
  }

  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ events: [mockEvent] })
    )
  })

  it('returns array of hub events', () => {
    const events = loadWorldIntelligence()
    expect(events).toHaveLength(1)
    expect(events[0].eventId).toBe('abc123')
  })

  it('throws if file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(() => loadWorldIntelligence()).toThrow('ENOENT')
  })
})
