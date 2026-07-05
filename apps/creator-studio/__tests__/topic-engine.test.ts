import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickDailyTopic } from '@/lib/topic-engine'
import * as hub from '@/data/hub'
import type { HubEvent } from '@/data/hub'

vi.mock('@/data/hub')
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn(() => false) }
})

const makeEvent = (overrides: Partial<HubEvent> = {}): HubEvent => ({
  eventId: 'id-1',
  title: 'OpenAI raises $10B in funding',
  summary: 'OpenAI massive investment from Microsoft and other investors',
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
  ...overrides,
})

describe('pickDailyTopic', () => {
  beforeEach(() => {
    vi.spyOn(hub, 'loadWorldIntelligence').mockReturnValue([
      makeEvent({ eventId: 'ai-1', title: 'OpenAI raises $10B in funding round' }),
      makeEvent({
        eventId: 'geo-1',
        title: 'Sanctions imposed on Lebanon officials',
        summary: 'US sanctions on Hezbollah',
        marketRelevance: 0.2,
        geopoliticalRelevance: 0.8,
        firstSeenAt: new Date(Date.now() - 20 * 3600000).toISOString(),
      }),
    ])
  })

  it('returns the highest-scoring story', () => {
    const topic = pickDailyTopic()
    expect(topic.eventId).toBe('ai-1')
  })

  it('includes suggestedAngle and suggestedVisualType', () => {
    const topic = pickDailyTopic()
    expect(topic.suggestedAngle).toBeTruthy()
    expect(['chart', 'card', 'illustration']).toContain(topic.suggestedVisualType)
  })

  it('suggests chart for investor-keyword stories', () => {
    const topic = pickDailyTopic()
    expect(topic.suggestedVisualType).toBe('chart')
  })
})
