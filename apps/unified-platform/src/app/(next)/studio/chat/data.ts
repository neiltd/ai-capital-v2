// Loader for /studio/chat.
//
// THIS LOADER MUST NOT CALL ANTHROPIC. It used to: `page.tsx` sets
// `force-dynamic`, so every authenticated GET of this page made one blocking,
// billable `anthropic.messages.create()` with no rate limit — the only
// `messages.create` site in the app without one, and the only one on a GET.
// Every other caller (api/studio/chat, api/studio/visuals/illustration,
// api/thesis-proposals) is a rate-limited POST.
//
// The contract now:
//     GET / render          -> no Anthropic request
//     explicit user action  -> Anthropic request
//
// Picking the topic stays here: `pickDailyTopic()` reads a local JSON export
// and costs nothing. The opening line moves behind a deliberate click, which
// routes through the EXISTING rate-limited POST /api/studio/chat rather than a
// new path — so the spend inherits a limiter that already exists.
//
// (The old perf note about blocking first paint on an LLM round-trip resolves
// itself as a side effect: the page now paints the topic card immediately.)

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
  // No opening is generated here. An empty string tells ChatThread to render
  // the start affordance instead of an assistant turn.
  return { topic, opening: '' }
}
