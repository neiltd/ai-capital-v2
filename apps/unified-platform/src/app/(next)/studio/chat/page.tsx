// /studio/chat — daily-topic AI chat.
//
// THEME UNIFICATION (2026-07): graphite tokens + shared primitives, same as
// every other screen. VISUAL redesign only — this is a live, working
// feature (real Claude calls); every behavior from the legacy ChatInterface
// is preserved in ChatThread.tsx (streaming, ```visual fence parsing,
// save-session).
//
// Design intents (design-redesign-2026-07/screens/studio-v2/chat):
// - The topic card reads as "the data the chat is about", consistent with
//   how every other screen frames its data (a SectionCard, not a chat-app
//   header bar).
// - Assistant messages sit flat on the surface (voice of the system, like
//   briefing prose elsewhere); only user messages get a bubble, so the
//   thread scans by shape, not color. No chat-app blue bubbles.

export const dynamic = 'force-dynamic'

import { loadStudioChat } from './data'
import { SectionCard, Label, AlertBanner } from '@/components/next/ui'
import { StudioNav } from '../studio-nav'
import { ChatThread } from './ChatThread'

export default async function StudioChatPage() {
  const c = await loadStudioChat()

  if (!c.topic) {
    return (
      <main className="mx-auto max-w-[860px] space-y-6 p-6">
        <header className="flex items-end justify-between">
          <h1 className="text-[20px] font-semibold text-ink">Studio · Today&apos;s topic</h1>
          <StudioNav current="chat" />
        </header>
        <AlertBanner
          level="warning"
          title="No world intelligence data"
          detail="pickDailyTopic() needs world-intel.json — run the world-intelligence-data-hub pipeline first."
        />
      </main>
    )
  }

  return (
    <main className="mx-auto flex h-[calc(100vh-40px)] max-w-[860px] flex-col gap-4 p-6">
      <header className="flex shrink-0 items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Studio · Today&apos;s topic</h1>
        <StudioNav current="chat" />
      </header>

      <SectionCard className="shrink-0">
        <div className="min-w-0">
          <Label>Today&apos;s topic</Label>
          <h2 className="mt-1 text-[16px] font-semibold leading-[22px] text-ink">{c.topic.title}</h2>
          <p className="mt-1.5 max-w-[640px] text-[13px] leading-5 text-ink-2">{c.topic.summary}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-ink-2">
              {c.topic.suggestedVisualType}
            </span>
            <span className="text-[12px] italic text-ink-3">{c.topic.suggestedAngle}</span>
          </div>
        </div>
      </SectionCard>

      <div className="min-h-0 flex-1 overflow-hidden rounded-card border border-hairline bg-surface">
        <ChatThread topic={c.topic} initialMessage={c.opening} />
      </div>
    </main>
  )
}
