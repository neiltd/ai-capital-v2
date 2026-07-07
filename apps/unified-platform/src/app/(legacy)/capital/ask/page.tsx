'use client'

import { useEffect, useRef, useState } from 'react'
import { ChatMessage } from '@/components/capital/ChatMessage'
import { PageHeader } from '@/components/capital/ui/PageHeader'

interface Message {
  role: 'user' | 'analyst'
  content: string
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [currentAnswer, setCurrentAnswer] = useState('')
  const [briefingMissing, setBriefingMissing] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/briefing')
      .then(r => r.json())
      .then(d => { if (d.missing) setBriefingMissing(true) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentAnswer])

  async function sendMessage() {
    const q = input.trim()
    if (!q || streaming) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setStreaming(true)
    setCurrentAnswer('')

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })

      if (!res.ok) {
        const err = await res.json() as { error: string }
        setMessages(prev => [...prev, { role: 'analyst', content: `Error: ${err.error}` }])
        setStreaming(false)
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let answer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        answer += decoder.decode(value, { stream: true })
        setCurrentAnswer(answer)
      }

      setMessages(prev => [...prev, { role: 'analyst', content: answer }])
      setCurrentAnswer('')

      fetch('/api/archive-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, answer }),
      }).catch(() => {})
    } catch {
      setMessages(prev => [...prev, { role: 'analyst', content: 'Connection error. Is the server running?' }])
    } finally {
      setStreaming(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const suggestions = [
    'Summarize the base scenario',
    'What changed in macro this week?',
    'Show me the highest conviction signals',
    'Which thesis assumptions are weakening?',
  ]

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] max-w-4xl">
      <div className="flex-shrink-0">
        <PageHeader
          title="Ask the Analyst"
          subtitle="Conversational interface over today's briefing, portfolio, and macro context"
        />
      </div>

      {briefingMissing && (
        <div className="flex-shrink-0 mb-4 flex items-start gap-3 bg-amber-signal/[0.06] border border-amber-signal/25 rounded-xl px-4 py-3 text-[12px] text-amber-signal">
          <span className="text-[14px] leading-none mt-0.5">⚠</span>
          <span>
            Ask requires today&apos;s briefing — run{' '}
            <code className="font-mono bg-bg-elevated border border-border-subtle rounded px-1.5 py-0.5 text-[11px]">npm run brief</code> first.
          </span>
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-1">
        {messages.length === 0 && !streaming && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent-primary to-accent-violet flex items-center justify-center text-[18px] font-bold text-white shadow-glow-indigo mb-4">
              ?
            </div>
            <div className="text-[13px] text-text-primary font-medium mb-1">
              Ask anything about the current investment context
            </div>
            <div className="text-[12px] text-text-muted mb-6 max-w-md">
              Try one of these prompts, or type your own question below.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  disabled={briefingMissing}
                  className="text-left bg-bg-card hover:bg-bg-card-hover border border-border-subtle hover:border-border-default rounded-lg px-3 py-2 text-[12px] text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} />
        ))}
        {streaming && currentAnswer && (
          <ChatMessage role="analyst" content={currentAnswer} streaming />
        )}
        {streaming && !currentAnswer && (
          <div className="flex justify-start">
            <div className="bg-bg-card border border-border-subtle rounded-xl px-4 py-3">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-indigo-active rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 flex gap-2 p-1.5 bg-bg-card border border-border-subtle rounded-xl shadow-card focus-within:border-accent-primary/50 focus-within:shadow-glow-indigo transition-all">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming || briefingMissing}
          placeholder={briefingMissing ? 'Run npm run brief first' : "Ask about today's briefing..."}
          className="flex-1 bg-transparent px-3 py-2 text-[13px] text-text-primary placeholder-text-faint focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={sendMessage}
          disabled={streaming || briefingMissing || !input.trim()}
          className="bg-gradient-to-br from-accent-primary to-accent-violet text-white rounded-lg px-4 py-2 text-[12px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-glow-indigo"
        >
          Send
        </button>
      </div>
    </div>
  )
}
