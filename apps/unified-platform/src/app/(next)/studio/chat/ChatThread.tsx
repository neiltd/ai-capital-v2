'use client'

// Real chat thread — behavior ported from src/components/studio/chat/
// ChatInterface.tsx (the source of truth), restyled to the graphite theme.
// Every real behavior is kept: streamed replies, ```visual fence parsing →
// POST /api/studio/visuals/:type → attach after the requesting message
// (fence stripped from display), save-session, Enter sends / Shift+Enter
// newlines, auto-scroll.
//
// Fixed one gap in the design mockup during implementation: it only
// rendered `url`-based visuals; real chart visuals come back as
// `chartConfig` (rendered via the existing ChartRenderer), not a url — see
// VisualAttachment below.

import { useEffect, useRef, useState } from 'react'
import type { ScoredStory } from '@/lib/studio/topic-engine'
import type { ChatMessage } from '@/lib/studio/agent'
import { ChartRenderer } from '@/components/studio/visuals/ChartRenderer'

interface Visual {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
  afterMessageIndex: number
}

export function ChatThread({ topic, initialMessage }: { topic: ScoredStory; initialMessage: string }) {
  // An empty initialMessage means the server did NOT generate an opening —
  // deliberately, so that loading this page costs nothing. The thread starts
  // empty and the user opens it explicitly. See data.ts.
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialMessage ? [{ role: 'assistant', content: initialMessage }] : [],
  )
  const [visuals, setVisuals] = useState<Visual[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function parseVisualRequests(text: string, messageIndex: number) {
    const visualRegex = /```visual\n([\s\S]*?)```/g
    let match
    while ((match = visualRegex.exec(text)) !== null) {
      try {
        const req = JSON.parse(match[1])
        const res = await fetch(`/api/studio/visuals/${req.type}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        })
        if (!res.ok) continue

        if (req.type === 'illustration') {
          const { url } = await res.json()
          setVisuals((v) => [...v, { type: 'illustration', url, label: req.label, afterMessageIndex: messageIndex }])
        } else if (req.type === 'chart') {
          const chartConfig = await res.json()
          setVisuals((v) => [...v, { type: 'chart', chartConfig, label: req.label, afterMessageIndex: messageIndex }])
        } else {
          const url = URL.createObjectURL(await res.blob())
          setVisuals((v) => [...v, { type: req.type, url, label: req.label, afterMessageIndex: messageIndex }])
        }
      } catch {
        // malformed ```visual fence — skip, don't break the rest of the reply
      }
    }
  }

  /**
   * The explicit user action that is allowed to spend.
   *
   * Routes through the same rate-limited POST /api/studio/chat as every other
   * turn, so there is no second, unlimited path to the model.
   */
  async function startConversation() {
    if (streaming || messages.length > 0) return
    setStreaming(true)
    try {
      const opening: ChatMessage[] = [{ role: 'user', content: 'morning' }]
      const res = await fetch('/api/studio/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: opening, topic }),
      })

      // Check the status BEFORE reading the body. Without this, a 429 — which a
      // user reaches by clicking six times, since the route allows 5/min —
      // streams the error JSON straight into the thread, so
      // `{"error":"Rate limit exceeded"}` renders as the agent's opening line.
      if (!res.ok || !res.body) {
        setError(res.status === 429
          ? 'Rate limited — wait a moment and try again.'
          : 'Could not start the conversation. Try again.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ''
      setMessages([{ role: 'assistant', content: '' }])
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        assistantText += decoder.decode(value)
        setMessages([{ role: 'assistant', content: assistantText }])
      }
    } catch {
      // A mid-stream failure rejects read(). The route returns 200 headers
      // before the model errors (messages.stream() resolves first), so its own
      // try/catch cannot cover this.
      setError('The connection dropped. Try again.')
      setMessages([])
    } finally {
      // MUST be finally: without it a mid-stream failure leaves the button
      // disabled on "Starting…" while messages.length > 0 has already removed
      // the start affordance — unrecoverable without a page reload. This path
      // is one-shot, so getting stuck here is worse than in sendMessage.
      setStreaming(false)
    }
  }

  async function sendMessage() {
    if (!input.trim() || streaming) return
    const userMsg: ChatMessage = { role: 'user', content: input }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setStreaming(true)

    const res = await fetch('/api/studio/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: nextMessages, topic }),
    })

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let assistantText = ''
    setMessages((m) => [...m, { role: 'assistant', content: '' }])

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      assistantText += decoder.decode(value)
      setMessages((m) => {
        const updated = [...m]
        updated[updated.length - 1] = { role: 'assistant', content: assistantText }
        return updated
      })
    }

    setStreaming(false)
    await parseVisualRequests(assistantText, nextMessages.length)
  }

  async function saveSession() {
    await fetch('/api/studio/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        visuals: visuals.map((v) => ({ type: v.type, url: v.url, label: v.label })),
      }),
    })
    setSaved(true)
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
          onClick={saveSession}
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
        {/* The deliberate action. Loading this page generates nothing; the
            opening line costs a model call, so a person asks for it. */}
        {messages.length === 0 && (
          <div className="flex flex-col items-start gap-2 py-6">
            <p className="text-[13px] leading-[20px] text-ink-2">
              Ready when you are — the opening line is generated on request, so simply
              opening this page doesn&apos;t call the model.
            </p>
            {error && (
              <p className="text-[13px] leading-[20px] text-loss">{error}</p>
            )}
            <button
              type="button"
              onClick={() => { setError(''); void startConversation() }}
              disabled={streaming}
              className="rounded-chip border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
            >
              {streaming ? 'Starting…' : 'Start the conversation'}
            </button>
          </div>
        )}
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
                <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Studio agent</div>
                <div className="text-[14px] leading-[21px] text-ink-2">
                  {msg.content.replace(/```visual[\s\S]*?```/g, '')}
                </div>
              </div>
            )}
            {visuals.filter((v) => v.afterMessageIndex === i).map((v, j) => (
              <VisualCard key={j} v={v} />
            ))}
          </div>
        ))}

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
// Chart visuals render via the real ChartRenderer (chartConfig, no url);
// illustration/card visuals render the downloadable image (url).

function VisualCard({ v }: { v: Visual }) {
  if (v.type === 'chart' && v.chartConfig) {
    return (
      <figure className="mt-3 max-w-[85%] overflow-hidden rounded-card border border-hairline">
        <div className="border-b border-hairline bg-surface-2 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">chart</span>
        </div>
        <div className="bg-surface-2/50 p-3">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <ChartRenderer config={v.chartConfig as any} />
        </div>
        <figcaption className="px-3 py-2 text-[12px] text-ink-2">{v.label}</figcaption>
      </figure>
    )
  }

  return (
    <figure className="mt-3 max-w-[85%] overflow-hidden rounded-card border border-hairline">
      <div className="flex items-center justify-between border-b border-hairline bg-surface-2 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{v.type}</span>
        {v.url && (
          <a href={v.url} download={`${v.type}-${Date.now()}.png`} className="text-[11px] text-accent hover:underline">
            Download
          </a>
        )}
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
