'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageBubble } from './MessageBubble'
import { VisualAttachment } from './VisualAttachment'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ScoredStory } from '@/lib/topic-engine'
import type { ChatMessage } from '@/lib/agent'

interface Visual {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
  afterMessageIndex: number
}

interface ScriptSections {
  deepBrief: string
  talkingPoints: string
  thaiScript: string
}

type ScriptTab = 'brief' | 'points' | 'thai'

interface Props {
  topic: ScoredStory
}

function formatFreshness(latestSeenAt: string): { label: string; stale: boolean } {
  const ageMs = Date.now() - new Date(latestSeenAt).getTime()
  const ageHours = ageMs / 3_600_000
  if (!Number.isFinite(ageHours)) return { label: 'unknown age', stale: false }
  const ageDays = ageHours / 24
  if (ageHours < 2) return { label: 'just now', stale: false }
  if (ageHours < 24) return { label: `${Math.round(ageHours)}h ago`, stale: false }
  if (ageDays < 3) return { label: `${Math.round(ageDays)}d ago`, stale: false }
  return { label: `⚠ ${Math.round(ageDays)}d old — hub may be stale`, stale: true }
}

function parseScriptSections(text: string): ScriptSections | null {
  const briefMatch = text.match(/###\s*📚[^\n]*\n([\s\S]*?)(?=###\s*🎯|$)/)
  const pointsMatch = text.match(/###\s*🎯[^\n]*\n([\s\S]*?)(?=###\s*🇹🇭|$)/)
  const thaiMatch = text.match(/###\s*🇹🇭[^\n]*\n([\s\S]*)/)
  if (!briefMatch && !pointsMatch && !thaiMatch) return null
  return {
    deepBrief: briefMatch?.[1]?.trim() ?? '',
    talkingPoints: pointsMatch?.[1]?.trim() ?? '',
    thaiScript: thaiMatch?.[1]?.trim() ?? '',
  }
}

export function ChatInterface({ topic }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [visuals, setVisuals] = useState<Visual[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scriptSections, setScriptSections] = useState<ScriptSections | null>(null)
  const [activeTab, setActiveTab] = useState<ScriptTab>('thai')
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const openerFired = useRef(false)
  const [scriptMessageIndex, setScriptMessageIndex] = useState<number | null>(null)
  const freshness = formatFreshness(topic.latestSeenAt)

  // Auto-scroll only when already near bottom
  useEffect(() => {
    const el = chatRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetch opening message on mount
  useEffect(() => {
    if (openerFired.current) return
    openerFired.current = true
    fetchResponse([{ role: 'user', content: 'morning' }], [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Abort any in-flight request on unmount
  useEffect(() => () => { abortRef.current?.abort() }, [])

  async function parseVisualRequests(text: string, messageIndex: number) {
    const visualRegex = /```visual\n([\s\S]*?)```/g
    const matches: RegExpExecArray[] = []
    let match
    while ((match = visualRegex.exec(text)) !== null) matches.push(match)

    await Promise.all(matches.map(async (m) => {
      try {
        const req = JSON.parse(m[1])
        const res = await fetch(`/api/visuals/${req.type}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        })
        if (!res.ok) return
        if (req.type === 'illustration') {
          const { url } = await res.json()
          setVisuals(v => [...v, { type: 'illustration', url, label: req.label, afterMessageIndex: messageIndex }])
        } else if (req.type === 'chart') {
          const chartConfig = await res.json()
          setVisuals(v => [...v, { type: 'chart', chartConfig, label: req.label, afterMessageIndex: messageIndex }])
        } else {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          setVisuals(v => [...v, { type: req.type, url, label: req.label, afterMessageIndex: messageIndex }])
        }
      } catch { /* visual generation failures are non-fatal */ }
    }))
  }

  const fetchResponse = useCallback(async (history: ChatMessage[], currentMessages: ChatMessage[]) => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStreaming(true)
    setError(null)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, topic }),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(text || `HTTP ${res.status}`)
      }
      if (!res.body) throw new Error('Empty response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ''
      const allMessages = [...currentMessages, { role: 'assistant' as const, content: '' }]
      setMessages(allMessages)

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

      // Parse script sections from the completed message
      const sections = parseScriptSections(assistantText)
      if (sections) {
        setScriptSections(sections)
        setScriptMessageIndex(allMessages.length - 1)
        setActiveTab('thai') // jump to Thai script by default when script arrives
      }

      await parseVisualRequests(assistantText, allMessages.length - 1)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message || 'Something went wrong')
      setMessages(m => m.slice(0, -1)) // remove the empty assistant placeholder
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [topic]) // eslint-disable-line react-hooks/exhaustive-deps

  async function sendMessage() {
    if (!input.trim() || streaming) return
    const userMsg: ChatMessage = { role: 'user', content: input }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    await fetchResponse([...nextMessages], nextMessages)
  }

  function stopStreaming() {
    abortRef.current?.abort()
  }

  async function copyThaiScript() {
    if (!scriptSections?.thaiScript) return
    await navigator.clipboard.writeText(scriptSections.thaiScript)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function saveSession() {
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          visuals: visuals.map(v => ({ type: v.type, url: v.url, label: v.label })),
          chatHistory: messages,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(text || `HTTP ${res.status}`)
      }
      setSaved(true)
    } catch (err) {
      setError((err as Error).message || 'Failed to save session')
    }
  }

  const tabs: { id: ScriptTab; label: string }[] = [
    { id: 'brief', label: '📚 Deep Brief' },
    { id: 'points', label: '🎯 Talking Points' },
    { id: 'thai', label: '🇹🇭 Thai Script' },
  ]

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Left: Chat panel */}
      <div className="flex flex-col w-full lg:w-[420px] lg:border-r lg:border-zinc-800 shrink-0">
        {/* Topic header */}
        <div className="border-b border-zinc-800 px-4 py-3 shrink-0 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-0.5">Today&apos;s Content</p>
              <p className="text-sm font-semibold leading-tight">{topic.title}</p>
            </div>
            <Button size="sm" variant="outline" onClick={saveSession} disabled={saved} className="text-xs shrink-0">
              {saved ? 'Saved ✓' : 'Save session'}
            </Button>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">{topic.summary}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] bg-indigo-900/50 text-indigo-300 border border-indigo-800 rounded px-2 py-0.5">
              {topic.suggestedVisualType}
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded border ${freshness.stale ? 'bg-amber-900/40 text-amber-300 border-amber-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
              {freshness.label}
            </span>
          </div>
          <p className="text-xs text-zinc-500 italic">{topic.suggestedAngle}</p>
        </div>

        {/* Chat messages */}
        <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-4">
          {messages.map((msg, i) => {
            let content = msg.content.replace(/```visual[\s\S]*?```/g, '')
            if (i === scriptMessageIndex) {
              content = content.replace(/###\s*📚[\s\S]*/g, '[Script generated — see panel →]')
            }
            return (
            <div key={i}>
              <MessageBubble
                role={msg.role}
                content={content}
              />
              {visuals.filter(v => v.afterMessageIndex === i).map((v, j) => (
                <VisualAttachment key={j} {...v} />
              ))}
            </div>
            )
          })}
          {streaming && (
            <div className="flex justify-start mb-3">
              <div className="bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-zinc-400 animate-pulse">
                Writing...
              </div>
            </div>
          )}
          {error && (
            <div className="mx-4 mb-3 px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-800 rounded-lg">
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-zinc-800 px-4 py-3 flex gap-2 shrink-0">
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder="Chat about the topic..."
            className="resize-none bg-zinc-900 border-zinc-700 text-sm min-h-[44px] max-h-32"
            rows={1}
            disabled={streaming}
            enterKeyHint="send"
          />
          {streaming ? (
            <Button onClick={stopStreaming} variant="outline" className="border-zinc-700 text-zinc-400 hover:text-red-400">
              ■
            </Button>
          ) : (
            <Button onClick={sendMessage} disabled={!input.trim()} className="bg-indigo-600 hover:bg-indigo-700">
              →
            </Button>
          )}
        </div>
      </div>

      {/* Right: Script panel (hidden on mobile until script ready) */}
      {scriptSections && (
        <div className="hidden lg:flex flex-col flex-1 min-w-0">
          {/* Tabs */}
          <div className="border-b border-zinc-800 px-4 flex items-center gap-1 shrink-0 bg-zinc-950">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-indigo-500 text-indigo-300'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
            {activeTab === 'thai' && (
              <button
                onClick={copyThaiScript}
                className="ml-auto text-xs text-zinc-500 hover:text-zinc-200 px-3 py-3 transition-colors"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {activeTab === 'brief' && (
              <div className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {scriptSections.deepBrief}
              </div>
            )}
            {activeTab === 'points' && (
              <div className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {scriptSections.talkingPoints}
              </div>
            )}
            {activeTab === 'thai' && (
              <div className="text-base text-zinc-100 leading-loose font-medium whitespace-pre-wrap tracking-wide">
                {scriptSections.thaiScript}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile: script panel as bottom sheet when script ready */}
      {scriptSections && (
        <div className="lg:hidden fixed inset-x-0 bottom-0 max-h-[60vh] bg-zinc-900 border-t border-zinc-700 flex flex-col z-10">
          <div className="flex items-center gap-1 px-4 border-b border-zinc-800 shrink-0">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-indigo-500 text-indigo-300'
                    : 'border-transparent text-zinc-500'
                }`}
              >
                {tab.label}
              </button>
            ))}
            {activeTab === 'thai' && (
              <button onClick={copyThaiScript} className="ml-auto text-xs text-zinc-500 px-3 py-3">
                {copied ? '✓' : 'Copy'}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {activeTab === 'brief' && (
              <div className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {scriptSections.deepBrief}
              </div>
            )}
            {activeTab === 'points' && (
              <div className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {scriptSections.talkingPoints}
              </div>
            )}
            {activeTab === 'thai' && (
              <div className="text-sm text-zinc-100 leading-loose font-medium whitespace-pre-wrap">
                {scriptSections.thaiScript}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
