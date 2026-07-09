// /studio/chat — daily-topic AI chat (studio-v2).
//
// THEME UNIFICATION (2026-07): graphite tokens + shared primitives, same as
// every other screen. Supersedes the legacy chat shell and the magenta
// (next)/studio theme. VISUAL redesign only — this is a live, working
// feature (real Claude calls); every behavior in the legacy ChatInterface
// is preserved (see chat/data.ts for the behavior contract).
//
// Layout (fixed-height column, thread scrolls, input pinned):
//   ┌ header: Studio · Today's topic                     sub-nav ──────────┐
//   ├ topic card: Label · title · summary · visual-type chip · angle · Save ┤
//   ├ thread (scrolls): assistant plain-left / user bubble-right /          ┤
//   │                   visual attachments as bordered cards                ┤
//   ├ input row: textarea + accent send ────────────────────────────────────┤
//   └────────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - The topic card is the day's brief, styled like any other SectionCard —
//   it reads as "the data the chat is about", consistent with how every
//   other screen frames its data.
// - Assistant messages sit flat on the page surface (it's the "voice of the
//   system", like briefing prose elsewhere); only USER messages get a
//   bubble (bg-surface-2, right-aligned) so the thread scans by shape, not
//   color. No chat-app blue bubbles — accent stays reserved for actions.
// - Empty thread state = just the opening assistant message; the true
//   failure state (no world-intel data) is an AlertBanner, same component
//   the investment screens use for missing envelopes.

export const dynamic = 'force-dynamic'

import { loadStudioChat } from './data'
import { SectionCard, Label, AlertBanner } from '@/components/next/ui'
import { ChatThread } from './ChatThread'

export default async function StudioChatPage() {
  const c = await loadStudioChat()
  // Real impl: topic = pickDailyTopic() (throws → warning below); opening =
  // blocking Claude call today — consider streaming it instead (README #6).

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

  // h-screen: adjust the offset if the app shell adds fixed chrome (legacy used calc(100vh - 4rem))
  return (
    <main className="mx-auto flex h-screen max-w-[860px] flex-col gap-4 p-6">
      <header className="flex shrink-0 items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Studio · Today&apos;s topic</h1>
        <StudioNav current="chat" />
      </header>

      {/* -------------------------------- topic card -------------------------------- */}
      <SectionCard className="shrink-0">
        <div className="flex items-start justify-between gap-4">
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
          {/* Save lives in ChatThread (it owns the visuals state) — this column
              just reserves the slot visually; see SaveButton there. */}
        </div>
      </SectionCard>

      {/* ------------------------------ thread + input ------------------------------ */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-card border border-hairline bg-surface">
        <ChatThread topic={c.topic} initialMessage={c.opening} />
      </div>
    </main>
  )
}

/* ------------------------ studio sub-nav (shared visual) ------------------------ */

function StudioNav({ current }: { current: 'dashboard' | 'archive' | 'chat' }) {
  const items = [
    { id: 'chat', label: "Today's topic", href: '/studio/chat' },
    { id: 'dashboard', label: 'Dashboard', href: '/studio/dashboard' },
    { id: 'archive', label: 'Archive', href: '/studio/archive' },
  ] as const
  return (
    <nav className="flex items-center gap-4 text-[12px]">
      {items.map((it) => (
        <a
          key={it.id}
          href={it.href}
          className={it.id === current ? 'font-semibold text-ink' : 'text-ink-3 hover:text-ink-2'}
        >
          {it.label}
        </a>
      ))}
    </nav>
  )
}
