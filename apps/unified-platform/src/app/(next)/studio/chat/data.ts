// Loader for /studio/chat. This is a LIVE feature — visual redesign only,
// same behavior as the legacy page: pickDailyTopic() scores world-intel
// events (throws when world-intel.json is missing), then one blocking
// anthropic.messages.create() generates the opening line.
//
// Known perf note (not fixed here — see studio-v2/README.md #6): this
// blocks first paint on a full LLM round-trip. Rendering the topic card
// immediately and streaming the opening into the thread would be the
// single biggest perceived-quality win on this screen — kept as a follow-up
// rather than changing behavior in a visual-redesign pass.

import { anthropic, buildSystemPrompt } from '@/lib/studio/agent'
import { pickDailyTopic } from '@/lib/studio/topic-engine'
import type { ScoredStory } from '@/lib/studio/topic-engine'

export interface StudioChatVM {
  topic: ScoredStory | null
  opening: string
}

export async function loadStudioChat(): Promise<StudioChatVM> {
  let topic: ScoredStory
  try {
    topic = pickDailyTopic()
  } catch {
    return { topic: null, opening: '' }
  }

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [{ type: 'text', text: buildSystemPrompt(topic), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'morning' }],
  })
  const opening = res.content[0].type === 'text' ? res.content[0].text : "Morning! Let's talk about today's story."

  return { topic, opening }
}
