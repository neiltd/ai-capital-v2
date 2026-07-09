'use client'

// Client chat thread — VISUAL mockup of the redesigned ChatInterface.
//
// The legacy component (src/components/studio/chat/ChatInterface.tsx) is the
// behavior source of truth; keep ALL of it when implementing:
//   - sendMessage(): POST /api/studio/chat, stream chunks into the last
//     assistant message (setStreaming around it)
//   - parseVisualRequests(): extract ```visual fenced JSON from assistant
//     text, POST /api/studio/visuals/:type, attach after the message; strip
//     the fence from the displayed text
//   - saveSession(): POST /api/studio/session { topic, visuals } → Saved ✓
//   - Enter sends, Shift+Enter newlines; auto-scroll to bottom on new message
//
// This mock seeds a sample thread (data.ts) and only appends the user turn
// locally — the fetch/stream plumbing is deliberately omitted so the file
// stays a design artifact.

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatVisual, DailyTopic } from './data'
import { SAMPLE_MESSAGES, SAMPLE_VISUALS } from './data'

export function ChatThread({ topic, initialMessage }: { topic: DailyTopic; initialMessage: string }) {
  // Real impl seeds: [{ role: 'assistant', content: initialMessage }]
  void initialMessage
  const [messages, setMessages] = useState<ChatMessage[]>(SAMPLE_MESSAGES)
  const [visuals] = useState<ChatVisual[]>(SAMPLE_VISUALS)
  const [input, setInput] = useState('')
  const [streaming] = useState(false) // set true around the stream in the real impl
  const [saved, setSaved] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function sendMessage() {
    if (!input.trim() || streaming) return
    setMessages((m) => [...m, { role: 'user', content: input }])
    setInput('')
    // real impl: fetch('/api/studio/chat') and stream the reply — see header
  }

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------- thread bar ------------------------------- */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
          Ideation thread · {topic.eventId}
        </span>
        <button
          type="button"
          onClick={() => setSaved(true)}
          disabled={saved}
          className={
            saved
              ? 'rounded-chip border border-transparent px-2.5 py-1 text-[12px] font-medium text-gain'
              : 'rounded-chip border border-hairline bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:text-ink'
          }
        >
          {saved ? 'Saved ✓' : 'Save session'}
        </button>
      </div>

      {/* -------------------------------- messages -------------------------------- */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="max-w-[75%] rounded-card bg-surface-2 px-3.5 py-2.5 text-[14px] leading-[21px] text-ink">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="max-w-[85%]">
                {/* assistant: flat on the surface, tagged not bubbled */}
                <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Studio agent</div>
                <div className="text-[14px] leading-[21px] text-ink-2">
                  {msg.content /* real impl strips ```visual fences before display */}
                </div>
              </div>
            )}
            {visuals
              .filter((v) => v.afterMessageIndex === i)
              .map((v, j) => (
                <VisualCard key={j} v={v} />
              ))}
          </div>
        ))}

        {/* streaming indicator — shown while the reply streams in */}
        {streaming && (
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* --------------------------------- input --------------------------------- */}
      <div className="flex shrink-0 items-end gap-2 border-t border-hairline px-4 py-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          }}
          placeholder="Develop the idea — ask for hooks, beats, or a visual…"
          rows={1}
          className="max-h-32 min-h-[42px] flex-1 resize-none rounded-card border border-hairline bg-surface-2 px-3 py-2.5 text-[14px] leading-[21px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={sendMessage}
          disabled={streaming || !input.trim()}
          className="rounded-card bg-accent px-3.5 py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
        >
          {streaming ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------ visual attachment ------------------------------ */
// Generated chart/card/illustration attached to an assistant turn. Real impl
// renders the chart config / image url (legacy VisualAttachment.tsx); the
// placeholder block below is the loading/mock treatment.

function VisualCard({ v }: { v: ChatVisual }) {
  return (
    <figure className="mt-3 max-w-[85%] overflow-hidden rounded-card border border-hairline">
      <div className="flex items-center justify-between border-b border-hairline bg-surface-2 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{v.type}</span>
        <button type="button" className="text-[11px] text-accent hover:underline">
          Download
        </button>
      </div>
      <div className="flex h-40 items-center justify-center bg-surface-2/50">
        {v.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.url} alt={v.label} className="max-h-full max-w-full" />
        ) : (
          <span className="text-[12px] text-ink-3">generated {v.type} renders here</span>
        )}
      </div>
      <figcaption className="px-3 py-2 text-[12px] text-ink-2">{v.label}</figcaption>
    </figure>
  )
}
