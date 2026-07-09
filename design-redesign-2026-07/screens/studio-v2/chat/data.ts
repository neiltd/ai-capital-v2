// Loader contract for /studio/chat — daily-topic AI chat.
//
// THIS IS A LIVE FEATURE. The mockup only respecifies the visuals; keep the
// existing behavior exactly (see src/components/studio/chat/ChatInterface.tsx
// and src/app/(legacy)/studio/chat/page.tsx):
//
//   topic          ← pickDailyTopic() from @/lib/studio/topic-engine —
//                    scores world-intel events; NOT from the DB. Throws when
//                    world-intel.json is missing → warning state below.
//   opening        ← one blocking anthropic.messages.create() in the server
//                    component (claude-sonnet-4-6, cached system prompt).
//                    Perf note for the engineer: this holds up first paint by
//                    a full LLM round-trip — consider rendering the topic
//                    header immediately and streaming the opening into the
//                    thread instead (README gap #6).
//   send           ← POST /api/studio/chat, streamed body chunks appended to
//                    the last assistant message.
//   visuals        ← assistant replies may embed ```visual fenced JSON;
//                    strip from display, POST /api/studio/visuals/:type,
//                    attach result after the requesting message.
//   save           ← POST /api/studio/session with { topic, visuals } →
//                    Session row. storyArc/notes are NOT sent today
//                    (README gap #2); the transcript itself is never
//                    persisted (README gap #1).

export interface DailyTopic {
  eventId: string
  title: string
  summary: string
  suggestedAngle: string
  suggestedVisualType: 'chart' | 'card' | 'illustration' | string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatVisual {
  type: 'chart' | 'card' | 'illustration' | string
  label: string
  url?: string
  afterMessageIndex: number
}

export interface StudioChatVM {
  topic: DailyTopic | null // null = world-intel data missing (warning state)
  opening: string
}

/** Flip to preview the no-world-intel-data warning state. */
export const SHOW_NO_TOPIC = false

export async function loadStudioChat(): Promise<StudioChatVM> {
  if (SHOW_NO_TOPIC) return { topic: null, opening: '' }
  return {
    topic: {
      eventId: 'gdelt-2026-07-06-0914',
      title: 'US federal AI contract awards hit a monthly record',
      summary:
        'USASpending data shows federal AI contract obligations reached a monthly record in June, led by defense and homeland-security awards to a small cluster of vendors.',
      suggestedAngle: 'The government is quietly picking AI winners — my monitor caught it before the news did',
      suggestedVisualType: 'chart',
    },
    opening:
      "Morning! Big one today — June federal AI contract awards just set a monthly record, and my government-flow monitor flagged it before any outlet wrote it up. That's a great personal hook: your own pipeline scooping the news. Want to open on the record number, or on the 'my bot saw this first' angle?",
  }
}

/* Sample thread state for the mockup — demonstrates every message treatment:
   opening, user turn, assistant turn with an attached visual, and (toggled
   in ChatThread) the streaming indicator. */
export const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    role: 'assistant',
    content:
      "Morning! Big one today — June federal AI contract awards just set a monthly record, and my government-flow monitor flagged it before any outlet wrote it up. That's a great personal hook: your own pipeline scooping the news. Want to open on the record number, or on the 'my bot saw this first' angle?",
  },
  { role: 'user', content: "Bot-saw-it-first angle. Can you sketch a hook and show the award trend as a chart?" },
  {
    role: 'assistant',
    content:
      'Hook: "My AI found out where the government is spending on AI — before the news did." Then cut straight to the chart while you narrate the June spike. Here\'s the trend visual —',
  },
]

export const SAMPLE_VISUALS: ChatVisual[] = [
  { type: 'chart', label: 'Federal AI contract obligations, monthly, 2025–2026', afterMessageIndex: 2 },
]
