'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageBubble } from './MessageBubble'
import { VisualAttachment } from './VisualAttachment'
import { Button } from '@/components/studio/ui/button'
import { Textarea } from '@/components/studio/ui/textarea'
import type { ScoredStory } from '@/lib/studio/topic-engine'
import type { ChatMessage } from '@/lib/studio/agent'

interface Visual {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
  afterMessageIndex: number
}

interface Props {
  topic: ScoredStory
  initialMessage: string
}

export function ChatInterface({ topic, initialMessage }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: initialMessage },
  ])
  const [visuals, setVisuals] = useState<Visual[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [saved, setSaved] = useState(false)
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
          setVisuals(v => [...v, { type: 'illustration', url, label: req.label, afterMessageIndex: messageIndex }])
        } else if (req.type === 'chart') {
          const chartConfig = await res.json()
          setVisuals(v => [...v, { type: 'chart', chartConfig, label: req.label, afterMessageIndex: messageIndex }])
        } else {
          const url = URL.createObjectURL(await res.blob())
          setVisuals(v => [...v, { type: req.type, url, label: req.label, afterMessageIndex: messageIndex }])
        }
      } catch {}
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
    setMessages(m => [...m, { role: 'assistant', content: '' }])

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      assistantText += decoder.decode(value)
      setMessages(m => {
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
        visuals: visuals.map(v => ({ type: v.type, url: v.url, label: v.label })),
      }),
    })
    setSaved(true)
  }

  return (
    <div className="flex flex-col h-full bg-bg-card text-text-primary">
      <div className="border-b border-border-subtle px-4 py-3 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-text-inactive uppercase tracking-[0.12em]">Today's Topic</p>
          <p className="text-sm font-medium truncate text-text-primary">{topic.title}</p>
        </div>
        <Button size="sm" variant="outline" onClick={saveSession} disabled={saved} className="text-xs ml-3 shrink-0">
          {saved ? 'Saved ✓' : 'Save'}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((msg, i) => (
          <div key={i}>
            <MessageBubble role={msg.role} content={msg.content.replace(/```visual[\s\S]*?```/g, '')} />
            {visuals.filter(v => v.afterMessageIndex === i).map((v, j) => (
              <VisualAttachment key={j} {...v} />
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border-subtle px-4 py-3 flex gap-2 shrink-0">
        <Textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
          placeholder="Chat about the topic..."
          className="resize-none bg-bg-elevated border-border-default text-text-primary placeholder:text-text-inactive text-sm min-h-[44px] max-h-32"
          rows={1}
        />
        <Button onClick={sendMessage} disabled={streaming || !input.trim()} className="bg-accent-primary hover:bg-accent-primary/90 text-white">
          {streaming ? '...' : '→'}
        </Button>
      </div>
    </div>
  )
}
