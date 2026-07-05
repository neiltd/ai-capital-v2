# Creator Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Creator Studio — a mobile-first Next.js web app that greets a TikTok creator each morning with an AI-picked topic, runs a casual chat to shape the story arc, generates visual assets, and tracks TikTok growth with a feedback loop.

**Architecture:** Next.js 15 App Router reads existing `world-intelligence-data-hub` exports for news data, uses Claude Sonnet 4.6 (with prompt caching) for streaming conversation, generates visuals server-side (@napi-rs/canvas) or via DALL-E 3, stores sessions and growth metrics in SQLite via Prisma, and syncs TikTok stats via Display API + Claude Vision screenshot parsing.

**Tech Stack:** Next.js 15, Tailwind CSS, shadcn/ui, Anthropic SDK (Claude Sonnet 4.6), OpenAI SDK (DALL-E 3), @napi-rs/canvas, Recharts, html-to-image, Prisma + SQLite → Supabase, TikTok Display API, Vitest

---

## File Map

```
creator-studio/
├── .env.local                           # API keys (never commit)
├── app/
│   ├── layout.tsx                       # Root layout, mobile viewport
│   ├── page.tsx                         # Daily chat interface (main screen)
│   ├── dashboard/page.tsx               # Growth tracker dashboard
│   ├── archive/page.tsx                 # Past sessions browser
│   └── api/
│       ├── topic/route.ts               # GET — morning topic pick
│       ├── chat/route.ts                # POST — Claude streaming conversation
│       ├── session/route.ts             # POST — save completed session
│       ├── visuals/
│       │   ├── card/route.ts            # POST — headline card PNG (server canvas)
│       │   ├── illustration/route.ts    # POST — DALL-E 3 image URL
│       │   └── chart/route.ts           # POST — chart data config for Recharts
│       ├── growth/
│       │   ├── manual/route.ts          # POST — manual video stats
│       │   └── sync/route.ts            # POST — TikTok API cron sync
│       └── upload/route.ts              # POST — screenshot vision parsing
├── lib/
│   ├── topic-engine.ts                  # Score + rank hub events for AI relevance
│   ├── agent.ts                         # Anthropic client + system prompt
│   ├── visual-generator.ts              # Routes visual requests to right handler
│   └── growth-tracker.ts               # Performance weights read/write
├── data/
│   └── hub.ts                           # Reads world-intelligence-data-hub exports
├── components/
│   ├── chat/
│   │   ├── ChatInterface.tsx            # Full chat UI wrapper
│   │   ├── MessageBubble.tsx            # Single message display
│   │   └── VisualAttachment.tsx         # Inline visual + download button
│   ├── visuals/
│   │   └── ChartRenderer.tsx            # Recharts wrapper + html-to-image PNG export
│   └── dashboard/
│       ├── FollowerChart.tsx            # Follower growth curve
│       ├── TopVideosTable.tsx           # Top videos by views
│       ├── EngagementChart.tsx          # Engagement rate per video
│       └── TopicHeatmap.tsx             # Topic type performance grid
├── prisma/
│   └── schema.prisma                    # DB schema — Session, Video, GrowthSnapshot
└── __tests__/
    ├── topic-engine.test.ts
    ├── visual-generator.test.ts
    └── growth-tracker.test.ts
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `creator-studio/` (new directory)
- Create: `creator-studio/.env.local`
- Create: `creator-studio/package.json` (via npx)

- [ ] **Step 1: Scaffold Next.js app**

```bash
cd /Users/thanapold/Desktop/Projects
npx create-next-app@latest creator-studio \
  --typescript \
  --tailwind \
  --app \
  --no-src-dir \
  --import-alias "@/*"
cd creator-studio
```

- [ ] **Step 2: Install dependencies**

```bash
npm install \
  @anthropic-ai/sdk \
  openai \
  @napi-rs/canvas \
  html-to-image \
  recharts \
  @prisma/client \
  prisma \
  zod \
  date-fns

npm install -D vitest @vitejs/plugin-react @vitest/coverage-v8
```

- [ ] **Step 3: Install shadcn/ui**

```bash
npx shadcn@latest init
# When prompted: Default style, Zinc base color, CSS variables yes
npx shadcn@latest add button input textarea card badge scroll-area
```

- [ ] **Step 4: Create .env.local**

```bash
cat > .env.local << 'EOF'
ANTHROPIC_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
TIKTOK_CLIENT_KEY=your_key_here
TIKTOK_CLIENT_SECRET=your_key_here
TIKTOK_USERNAME=your_tiktok_handle
HUB_EXPORTS_PATH=../world-intelligence-data-hub-/exports
DATABASE_URL="file:./dev.db"
EOF
```

- [ ] **Step 5: Configure Vitest**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
})
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Commit**

```bash
git init
echo ".env.local\ndev.db\n.next\nnode_modules" > .gitignore
git add -A
git commit -m "feat: scaffold creator-studio Next.js app"
```

---

## Task 2: Database Schema

**Files:**
- Create: `prisma/schema.prisma`
- Create: `lib/db.ts`

- [ ] **Step 1: Write schema**

Create `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Session {
  id        String   @id @default(cuid())
  date      DateTime @default(now())
  topic     String   // JSON: { eventId, title, summary, suggestedAngle, suggestedVisualType }
  storyArc  String?  // JSON: { hook, beats, personalAngle, cta }
  visuals   String   @default("[]") // JSON array: [{ type, url }]
  notes     String?
  videoId   String?
  createdAt DateTime @default(now())
}

model Video {
  id        String    @id @default(cuid())
  tiktokId  String?   @unique
  title     String
  postedAt  DateTime?
  views     Int       @default(0)
  likes     Int       @default(0)
  comments  Int       @default(0)
  shares    Int       @default(0)
  topicType String    @default("ai-news")
  sessionId String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model GrowthSnapshot {
  id           String   @id @default(cuid())
  date         DateTime @default(now())
  followers    Int
  profileViews Int      @default(0)
  source       String   // "api" | "manual" | "screenshot"
}
```

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name init
```

Expected output: `✔ Your database migration was applied successfully.`

- [ ] **Step 3: Create db client singleton**

Create `lib/db.ts`:
```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['error'] : [] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 4: Commit**

```bash
git add prisma/ lib/db.ts
git commit -m "feat: add prisma schema and db client"
```

---

## Task 3: Hub Data Reader

**Files:**
- Create: `data/hub.ts`
- Create: `__tests__/hub.test.ts`

- [ ] **Step 1: Write failing test**

Create `__tests__/hub.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadWorldIntelligence, HubEvent } from '@/data/hub'
import * as fs from 'fs'

vi.mock('fs')

describe('loadWorldIntelligence', () => {
  const mockEvent: HubEvent = {
    eventId: 'abc123',
    title: 'OpenAI raises $10B',
    summary: 'OpenAI announced massive funding round',
    eventType: 'economic_data_release',
    eventState: 'emerging',
    severity: 2,
    confidence: 0.9,
    marketRelevance: 0.9,
    geopoliticalRelevance: 0.3,
    firstSeenAt: new Date().toISOString(),
    latestSeenAt: new Date().toISOString(),
    countries: ['USA'],
    sourceIds: ['techcrunch'],
  }

  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ events: [mockEvent] })
    )
  })

  it('returns array of hub events', () => {
    const events = loadWorldIntelligence()
    expect(events).toHaveLength(1)
    expect(events[0].eventId).toBe('abc123')
  })

  it('throws if file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(() => loadWorldIntelligence()).toThrow('ENOENT')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm test __tests__/hub.test.ts
```

Expected: `FAIL — Cannot find module '@/data/hub'`

- [ ] **Step 3: Implement hub reader**

Create `data/hub.ts`:
```typescript
import { readFileSync } from 'fs'
import { join } from 'path'

const HUB_PATH =
  process.env.HUB_EXPORTS_PATH ??
  join(process.cwd(), '../world-intelligence-data-hub-/exports')

export interface HubEvent {
  eventId: string
  title: string
  summary: string
  eventType: string
  eventState: string
  severity: number
  confidence: number
  marketRelevance: number
  geopoliticalRelevance: number
  firstSeenAt: string
  latestSeenAt: string
  countries: string[]
  sourceIds: string[]
}

export function loadWorldIntelligence(): HubEvent[] {
  const filePath = join(HUB_PATH, 'world-map/intelligence.json')
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  return raw.events as HubEvent[]
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test __tests__/hub.test.ts
```

Expected: `PASS — 2 tests passed`

- [ ] **Step 5: Commit**

```bash
git add data/hub.ts __tests__/hub.test.ts
git commit -m "feat: add hub data reader for world-intelligence exports"
```

---

## Task 4: Topic Engine

**Files:**
- Create: `lib/topic-engine.ts`
- Create: `data/performance-weights.json`
- Create: `__tests__/topic-engine.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/topic-engine.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickDailyTopic } from '@/lib/topic-engine'
import * as hub from '@/data/hub'
import type { HubEvent } from '@/data/hub'

vi.mock('@/data/hub')
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn(() => false) }
})

const makeEvent = (overrides: Partial<HubEvent> = {}): HubEvent => ({
  eventId: 'id-1',
  title: 'OpenAI raises $10B in funding',
  summary: 'OpenAI massive investment from Microsoft and other investors',
  eventType: 'economic_data_release',
  eventState: 'emerging',
  severity: 2,
  confidence: 0.9,
  marketRelevance: 0.9,
  geopoliticalRelevance: 0.3,
  firstSeenAt: new Date().toISOString(),
  latestSeenAt: new Date().toISOString(),
  countries: ['USA'],
  sourceIds: ['techcrunch'],
  ...overrides,
})

describe('pickDailyTopic', () => {
  beforeEach(() => {
    vi.spyOn(hub, 'loadWorldIntelligence').mockReturnValue([
      makeEvent({ eventId: 'ai-1', title: 'OpenAI raises $10B in funding round' }),
      makeEvent({
        eventId: 'geo-1',
        title: 'Sanctions imposed on Lebanon officials',
        summary: 'US sanctions on Hezbollah',
        marketRelevance: 0.2,
        geopoliticalRelevance: 0.8,
        firstSeenAt: new Date(Date.now() - 20 * 3600000).toISOString(),
      }),
    ])
  })

  it('returns the highest-scoring story', () => {
    const topic = pickDailyTopic()
    expect(topic.eventId).toBe('ai-1')
  })

  it('includes suggestedAngle and suggestedVisualType', () => {
    const topic = pickDailyTopic()
    expect(topic.suggestedAngle).toBeTruthy()
    expect(['chart', 'card', 'illustration']).toContain(topic.suggestedVisualType)
  })

  it('suggests chart for investor-keyword stories', () => {
    const topic = pickDailyTopic()
    expect(topic.suggestedVisualType).toBe('chart')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm test __tests__/topic-engine.test.ts
```

Expected: `FAIL — Cannot find module '@/lib/topic-engine'`

- [ ] **Step 3: Implement topic engine**

Create `lib/topic-engine.ts`:
```typescript
import { loadWorldIntelligence, HubEvent } from '@/data/hub'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'llm', 'openai',
  'anthropic', 'google', 'microsoft', 'nvidia', 'robot', 'automation',
  'chatgpt', 'gemini', 'model', 'algorithm', 'tech', 'silicon', 'startup',
]
const INVESTOR_KEYWORDS = [
  'funding', 'raised', 'valuation', 'ipo', 'acquisition', 'merger',
  'revenue', 'billion', 'million', 'market', 'investment', 'stock',
]
const PERSONAL_KEYWORDS = [
  'jobs', 'workforce', 'immigration', 'visa', 'salary', 'layoffs',
  'hiring', 'remote', 'h1b', 'workers', 'employment',
]

type VisualType = 'chart' | 'card' | 'illustration'

interface PerformanceWeights {
  [category: string]: number
}

export interface ScoredStory {
  eventId: string
  title: string
  summary: string
  eventType: string
  firstSeenAt: string
  countries: string[]
  sourceIds: string[]
  score: number
  suggestedAngle: string
  suggestedVisualType: VisualType
}

function loadWeights(): PerformanceWeights {
  const path = join(process.cwd(), 'data/performance-weights.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
}

function scoreEvent(event: HubEvent, weights: PerformanceWeights): number {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  let score = 0

  const ageHours = (Date.now() - new Date(event.firstSeenAt).getTime()) / 3_600_000
  score += Math.max(0, 10 - ageHours / 2.4)

  score += AI_KEYWORDS.filter(k => text.includes(k)).length * 3
  score += INVESTOR_KEYWORDS.filter(k => text.includes(k)).length * 2
  score += PERSONAL_KEYWORDS.filter(k => text.includes(k)).length * 2
  score += event.marketRelevance * 5

  return score * (weights[event.eventType] ?? 1.0)
}

function suggestAngle(event: HubEvent): string {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  if (PERSONAL_KEYWORDS.some(k => text.includes(k))) {
    return 'workforce angle — tie to your experience watching the US job market as an immigrant'
  }
  if (INVESTOR_KEYWORDS.some(k => text.includes(k))) {
    return 'investor angle — who wins, who loses, what does this mean for money'
  }
  return 'LA perspective — how this shows up in your day-to-day in tech-heavy LA'
}

function suggestVisualType(event: HubEvent): VisualType {
  const text = `${event.title} ${event.summary}`.toLowerCase()
  if (INVESTOR_KEYWORDS.some(k => text.includes(k))) return 'chart'
  if (event.severity >= 3) return 'card'
  return 'illustration'
}

export function pickDailyTopic(): ScoredStory {
  const events = loadWorldIntelligence()
  const weights = loadWeights()

  const scored = events.map(event => ({
    eventId: event.eventId,
    title: event.title,
    summary: event.summary,
    eventType: event.eventType,
    firstSeenAt: event.firstSeenAt,
    countries: event.countries,
    sourceIds: event.sourceIds,
    score: scoreEvent(event, weights),
    suggestedAngle: suggestAngle(event),
    suggestedVisualType: suggestVisualType(event),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}
```

Create `data/performance-weights.json`:
```json
{}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test __tests__/topic-engine.test.ts
```

Expected: `PASS — 3 tests passed`

- [ ] **Step 5: Commit**

```bash
git add lib/topic-engine.ts data/performance-weights.json __tests__/topic-engine.test.ts
git commit -m "feat: add topic engine with AI/investor scoring"
```

---

## Task 5: Topic API Route

**Files:**
- Create: `app/api/topic/route.ts`

- [ ] **Step 1: Implement route**

Create `app/api/topic/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { pickDailyTopic } from '@/lib/topic-engine'

export async function GET() {
  try {
    const topic = pickDailyTopic()
    return NextResponse.json(topic)
  } catch (err) {
    console.error('Topic pick failed:', err)
    return NextResponse.json(
      { error: 'Could not load topic — check HUB_EXPORTS_PATH in .env.local' },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 2: Test manually**

```bash
npm run dev &
curl http://localhost:3000/api/topic | jq '.title,.suggestedAngle,.suggestedVisualType'
```

Expected: three non-null strings from the hub's top-scored event.

- [ ] **Step 3: Commit**

```bash
git add app/api/topic/route.ts
git commit -m "feat: add topic API route"
```

---

## Task 6: Claude Agent

**Files:**
- Create: `lib/agent.ts`

- [ ] **Step 1: Implement agent**

Create `lib/agent.ts`:
```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { ScoredStory } from './topic-engine'

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const BASE_SYSTEM = `You are a creative partner helping a Thai content creator in Los Angeles make daily TikTok videos about AI and world news.

Creator profile:
- Originally from Thailand, now living in LA as an adult immigrant
- Makes content for investors and AI-curious people
- Tone: casual friend texting, not news anchor formal — never stiff
- Videos: 5–10 minute talking-style TikToks

Your role each morning:
1. Open with an engaging casual pitch ("Morning! So check this out..." or similar)
2. Chat naturally to refine the story — follow the creator's lead
3. Suggest how the news connects to: life in LA, the Thai-in-America experience, US workforce trends
4. When the creator says they're ready, output a story arc in this exact format:
   **STORY ARC**
   Hook: [first 3 seconds — the scroll-stopper]
   Beat 1: [setup — why this matters]
   Beat 2: [the interesting detail]
   Beat 3: [the twist or implication]
   Personal Angle: [your specific connection as a Thai person in LA]
   CTA: [what to tell viewers to do next]

5. When a visual would help, include this block anywhere in your response:
\`\`\`visual
{"type":"chart"|"card"|"illustration","label":"short label","prompt":"description or key stat"}
\`\`\`

Keep responses short. One paragraph max unless doing the story arc. Talk like a friend, not a report.`

export function buildSystemPrompt(topic: ScoredStory): string {
  return `${BASE_SYSTEM}

Today's topic (pre-selected by the topic engine):
Title: ${topic.title}
Summary: ${topic.summary}
Suggested angle: ${topic.suggestedAngle}
Suggested visual type: ${topic.suggestedVisualType}`
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/agent.ts
git commit -m "feat: add claude agent with creator persona system prompt"
```

---

## Task 7: Chat API Route (Streaming)

**Files:**
- Create: `app/api/chat/route.ts`

- [ ] **Step 1: Implement streaming route**

Create `app/api/chat/route.ts`:
```typescript
import { NextRequest } from 'next/server'
import { anthropic, buildSystemPrompt, ChatMessage } from '@/lib/agent'
import { ScoredStory } from '@/lib/topic-engine'

export async function POST(req: NextRequest) {
  const { messages, topic }: { messages: ChatMessage[]; topic: ScoredStory } =
    await req.json()

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(topic),
        cache_control: { type: 'ephemeral' }, // prompt cache — saves cost on long conversations
      },
    ],
    messages,
  })

  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          controller.enqueue(new TextEncoder().encode(chunk.delta.text))
        }
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  })
}
```

- [ ] **Step 2: Test via curl**

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "topic": {"eventId":"test","title":"OpenAI $10B","summary":"Big raise","suggestedAngle":"investor angle","suggestedVisualType":"chart","score":30,"firstSeenAt":"2026-05-21T10:00:00Z","countries":["USA"],"sourceIds":["tc"],"eventType":"economic_data_release"},
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Expected: streaming text response in casual voice about the topic.

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "feat: add streaming chat API with claude sonnet 4.6 and prompt caching"
```

---

## Task 8: Chat UI Components

**Files:**
- Create: `components/chat/MessageBubble.tsx`
- Create: `components/chat/VisualAttachment.tsx`
- Create: `components/chat/ChatInterface.tsx`

- [ ] **Step 1: MessageBubble**

Create `components/chat/MessageBubble.tsx`:
```typescript
'use client'

interface Props {
  role: 'user' | 'assistant'
  content: string
}

export function MessageBubble({ role, content }: Props) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-indigo-600 text-white rounded-br-sm'
            : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
        }`}
      >
        {content}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: VisualAttachment**

Create `components/chat/VisualAttachment.tsx`:
```typescript
'use client'

import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'

interface Props {
  type: 'chart' | 'card' | 'illustration'
  url: string
  label: string
}

export function VisualAttachment({ type, url, label }: Props) {
  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = url
    a.download = `${type}-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-zinc-700 max-w-[85%]">
      <img src={url} alt={label} className="w-full object-cover" />
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-2">
        <span className="text-xs text-zinc-400 capitalize">{type} · {label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: ChatInterface**

Create `components/chat/ChatInterface.tsx`:
```typescript
'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageBubble } from './MessageBubble'
import { VisualAttachment } from './VisualAttachment'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ScoredStory } from '@/lib/topic-engine'
import type { ChatMessage } from '@/lib/agent'

interface Visual {
  type: 'chart' | 'card' | 'illustration'
  url: string
  label: string
  afterMessageIndex: number
}

interface Props {
  topic: ScoredStory
  initialMessage: string // agent's first pitch
}

export function ChatInterface({ topic, initialMessage }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: initialMessage },
  ])
  const [visuals, setVisuals] = useState<Visual[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
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
        const res = await fetch(`/api/visuals/${req.type}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        })
        if (res.ok) {
          const url = req.type === 'illustration'
            ? (await res.json()).url
            : URL.createObjectURL(await res.blob())
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

    const res = await fetch('/api/chat', {
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

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="text-xs text-zinc-500 uppercase tracking-wide">Today's Topic</p>
        <p className="text-sm font-medium truncate">{topic.title}</p>
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

      <div className="border-t border-zinc-800 px-4 py-3 flex gap-2">
        <Textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
          placeholder="Chat about the topic..."
          className="resize-none bg-zinc-900 border-zinc-700 text-sm min-h-[44px] max-h-32"
          rows={1}
        />
        <Button onClick={sendMessage} disabled={streaming || !input.trim()} className="bg-indigo-600 hover:bg-indigo-700">
          {streaming ? '...' : '→'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add components/chat/
git commit -m "feat: add chat UI components — MessageBubble, VisualAttachment, ChatInterface"
```

---

## Task 9: Main Page

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Update layout for mobile**

Replace `app/layout.tsx`:
```typescript
import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = { title: 'Creator Studio' }
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-zinc-950`}>{children}</body>
    </html>
  )
}
```

- [ ] **Step 2: Implement main page**

Replace `app/page.tsx`:
```typescript
import { pickDailyTopic } from '@/lib/topic-engine'
import { anthropic, buildSystemPrompt } from '@/lib/agent'
import { ChatInterface } from '@/components/chat/ChatInterface'

export default async function Home() {
  const topic = pickDailyTopic()

  // Get the agent's opening pitch before rendering — no loading state needed
  const openingRes = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(topic),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: 'morning',
      },
    ],
  })

  const openingMessage =
    openingRes.content[0].type === 'text' ? openingRes.content[0].text : "Morning! Let's talk about today's story."

  return <ChatInterface topic={topic} initialMessage={openingMessage} />
}
```

- [ ] **Step 3: Test in browser**

```bash
npm run dev
```

Open `http://localhost:3000` on your phone or browser. You should see a dark mobile-first chat screen with the agent's morning pitch and the topic title at the top. Send a message and verify streaming works.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx app/page.tsx
git commit -m "feat: add main page with morning topic pitch and chat interface"
```

---

## Task 10: Headline Card Visual (Server-side Canvas)

**Files:**
- Create: `app/api/visuals/card/route.ts`

- [ ] **Step 1: Implement route**

Create `app/api/visuals/card/route.ts`:
```typescript
import { createCanvas } from '@napi-rs/canvas'
import { NextRequest, NextResponse } from 'next/server'

const WIDTH = 1080
const HEIGHT = 1920

function wrapText(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): number {
  const words = text.split(' ')
  let line = ''
  let currentY = y

  for (const word of words) {
    const test = line + word + ' '
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      ctx.fillText(line.trim(), x, currentY)
      line = word + ' '
      currentY += lineHeight
    } else {
      line = test
    }
  }
  ctx.fillText(line.trim(), x, currentY)
  return currentY
}

export async function POST(req: NextRequest) {
  const { label = 'AI NEWS', prompt = '' } = await req.json()

  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = '#09090b'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  // Gradient overlay at bottom
  const grad = ctx.createLinearGradient(0, HEIGHT * 0.6, 0, HEIGHT)
  grad.addColorStop(0, 'rgba(99,102,241,0)')
  grad.addColorStop(1, 'rgba(99,102,241,0.15)')
  ctx.fillStyle = grad
  ctx.fillRect(0, HEIGHT * 0.6, WIDTH, HEIGHT * 0.4)

  // Accent bar
  ctx.fillStyle = '#6366f1'
  ctx.fillRect(80, 240, 8, 100)

  // Label
  ctx.fillStyle = '#6366f1'
  ctx.font = 'bold 38px sans-serif'
  ctx.fillText(label.toUpperCase(), 110, 305)

  // Headline
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 76px sans-serif'
  wrapText(ctx, prompt, 80, 420, 920, 96)

  // Creator handle
  const handle = process.env.TIKTOK_USERNAME ?? 'yourchannel'
  ctx.fillStyle = '#52525b'
  ctx.font = '42px sans-serif'
  ctx.fillText(`@${handle}`, 80, 1820)

  const png = canvas.toBuffer('image/png')
  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="card-${Date.now()}.png"`,
    },
  })
}
```

- [ ] **Step 2: Test**

```bash
curl -X POST http://localhost:3000/api/visuals/card \
  -H "Content-Type: application/json" \
  -d '{"label":"AI NEWS","prompt":"OpenAI just raised $10B and nobody is talking about what comes next"}' \
  --output test-card.png
open test-card.png
```

Expected: a 1080×1920 dark card with the text laid out in white bold type over a dark background, indigo accent bar.

- [ ] **Step 3: Commit**

```bash
git add app/api/visuals/card/route.ts
git commit -m "feat: add server-side headline card generator with @napi-rs/canvas"
```

---

## Task 11: AI Illustration Visual (DALL-E 3)

**Files:**
- Create: `app/api/visuals/illustration/route.ts`

- [ ] **Step 1: Implement route**

Create `app/api/visuals/illustration/route.ts`:
```typescript
import OpenAI from 'openai'
import { NextRequest, NextResponse } from 'next/server'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(req: NextRequest) {
  const { prompt } = await req.json()

  const enhanced = `${prompt}. Style: clean modern digital art, dark background (#09090b), vibrant accent colors, tech aesthetic, cinematic composition, no text or words in image.`

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: enhanced,
    size: '1024x1792',
    quality: 'standard',
    n: 1,
  })

  return NextResponse.json({ url: response.data[0].url })
}
```

- [ ] **Step 2: Test**

```bash
curl -X POST http://localhost:3000/api/visuals/illustration \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A robot and a human shaking hands in a neon-lit city"}'
```

Expected: JSON with a `url` field pointing to a DALL-E generated image.

- [ ] **Step 3: Commit**

```bash
git add app/api/visuals/illustration/route.ts
git commit -m "feat: add DALL-E 3 illustration generator"
```

---

## Task 12: Data Chart Visual (Recharts + html-to-image)

**Files:**
- Create: `app/api/visuals/chart/route.ts`
- Create: `components/visuals/ChartRenderer.tsx`

- [ ] **Step 1: Chart API route — returns config, not image**

Create `app/api/visuals/chart/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'

// The chart API returns config for Recharts to render client-side.
// The client then exports to PNG via html-to-image.
export async function POST(req: NextRequest) {
  const { prompt, label } = await req.json()

  // Parse a number from the prompt to use as the key stat
  const match = prompt.match(/\$?([\d.]+)\s*(B|M|T|billion|million|trillion)?/i)
  const value = match ? parseFloat(match[1]) : 0
  const unit = match?.[2]?.toUpperCase()[0] ?? ''

  const chartConfig = {
    type: 'bar',
    label,
    stat: `$${value}${unit}`,
    data: [
      { name: '2022', value: value * 0.2 },
      { name: '2023', value: value * 0.45 },
      { name: '2024', value: value * 0.72 },
      { name: '2025', value: value * 0.88 },
      { name: '2026', value },
    ],
  }

  return NextResponse.json(chartConfig)
}
```

- [ ] **Step 2: ChartRenderer component**

Create `components/visuals/ChartRenderer.tsx`:
```typescript
'use client'

import { useRef } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { toPng } from 'html-to-image'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'

interface ChartConfig {
  type: string
  label: string
  stat: string
  data: { name: string; value: number }[]
}

export function ChartRenderer({ config }: { config: ChartConfig }) {
  const ref = useRef<HTMLDivElement>(null)

  const handleDownload = async () => {
    if (!ref.current) return
    const png = await toPng(ref.current, { backgroundColor: '#09090b' })
    const a = document.createElement('a')
    a.href = png
    a.download = `chart-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-zinc-700 max-w-[85%]">
      <div ref={ref} className="bg-zinc-900 p-4">
        <p className="text-xs text-zinc-400 mb-1">{config.label}</p>
        <p className="text-2xl font-bold text-white mb-4">{config.stat}</p>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={config.data}>
            <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#18181b', border: 'none', borderRadius: 8 }}
              labelStyle={{ color: '#a1a1aa' }}
              itemStyle={{ color: '#ffffff' }}
            />
            <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-2">
        <span className="text-xs text-zinc-400">Chart · {config.label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Update VisualAttachment to handle chart type**

Edit `components/chat/VisualAttachment.tsx` — replace the component entirely:
```typescript
'use client'

import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import { ChartRenderer } from '@/components/visuals/ChartRenderer'

interface Props {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
}

export function VisualAttachment({ type, url, chartConfig, label }: Props) {
  if (type === 'chart' && chartConfig) {
    return <ChartRenderer config={chartConfig as any} />
  }

  const handleDownload = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${type}-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-zinc-700 max-w-[85%]">
      <img src={url} alt={label} className="w-full object-cover" />
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-2">
        <span className="text-xs text-zinc-400 capitalize">{type} · {label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Update ChatInterface to handle chart responses**

In `components/chat/ChatInterface.tsx`, update the `parseVisualRequests` function:
```typescript
async function parseVisualRequests(text: string, messageIndex: number) {
  const visualRegex = /```visual\n([\s\S]*?)```/g
  let match
  while ((match = visualRegex.exec(text)) !== null) {
    try {
      const req = JSON.parse(match[1])
      const res = await fetch(`/api/visuals/${req.type}`, {
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
```

Also update the `Visual` interface at the top of `ChatInterface.tsx`:
```typescript
interface Visual {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
  afterMessageIndex: number
}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/visuals/chart/route.ts components/visuals/ChartRenderer.tsx components/chat/VisualAttachment.tsx components/chat/ChatInterface.tsx
git commit -m "feat: add recharts data chart with html-to-image export"
```

---

## Task 13: Session Logger

**Files:**
- Create: `app/api/session/route.ts`

- [ ] **Step 1: Implement session save route**

Create `app/api/session/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  topic: z.object({
    eventId: z.string(),
    title: z.string(),
    summary: z.string(),
    suggestedAngle: z.string(),
    suggestedVisualType: z.string(),
  }),
  storyArc: z.object({
    hook: z.string(),
    beats: z.array(z.string()),
    personalAngle: z.string(),
    cta: z.string(),
  }).optional(),
  visuals: z.array(z.object({ type: z.string(), url: z.string().optional(), label: z.string() })).default([]),
  notes: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { topic, storyArc, visuals, notes } = parsed.data

  const session = await prisma.session.create({
    data: {
      topic: JSON.stringify(topic),
      storyArc: storyArc ? JSON.stringify(storyArc) : null,
      visuals: JSON.stringify(visuals),
      notes,
    },
  })

  return NextResponse.json({ id: session.id })
}

export async function GET() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  })
  return NextResponse.json(
    sessions.map(s => ({
      ...s,
      topic: JSON.parse(s.topic),
      storyArc: s.storyArc ? JSON.parse(s.storyArc) : null,
      visuals: JSON.parse(s.visuals),
    }))
  )
}
```

- [ ] **Step 2: Add save button to ChatInterface**

In `components/chat/ChatInterface.tsx`, add a save button in the header area. Add this inside the header `<div>` after the topic title:
```typescript
// Add to imports at top
import { useState } from 'react' // already there

// Add save state
const [saved, setSaved] = useState(false)

async function saveSession() {
  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      visuals: visuals.map(v => ({ type: v.type, url: v.url, label: v.label })),
    }),
  })
  setSaved(true)
}

// Add save button in header div (next to topic title):
<Button size="sm" variant="outline" onClick={saveSession} disabled={saved} className="text-xs">
  {saved ? 'Saved ✓' : 'Save Session'}
</Button>
```

- [ ] **Step 3: Commit**

```bash
git add app/api/session/route.ts components/chat/ChatInterface.tsx
git commit -m "feat: add session logger — save and retrieve daily sessions"
```

---

## Task 14: Archive Page

**Files:**
- Create: `app/archive/page.tsx`

- [ ] **Step 1: Implement archive page**

Create `app/archive/page.tsx`:
```typescript
import { prisma } from '@/lib/db'
import { formatDistanceToNow } from 'date-fns'
import Link from 'next/link'

export default async function ArchivePage() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  const parsed = sessions.map(s => ({
    ...s,
    topic: JSON.parse(s.topic) as { title: string; suggestedVisualType: string },
    visuals: JSON.parse(s.visuals) as { type: string }[],
  }))

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-bold">Past Sessions</h1>
        <Link href="/" className="text-sm text-indigo-400">← Today</Link>
      </div>

      {parsed.length === 0 && (
        <p className="text-zinc-500 text-sm">No sessions yet. Complete a daily chat to save one.</p>
      )}

      <div className="space-y-3">
        {parsed.map(s => (
          <div key={s.id} className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
            <p className="text-sm font-medium leading-snug mb-1">{s.topic.title}</p>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}</span>
              {s.visuals.length > 0 && (
                <span className="bg-zinc-800 px-2 py-0.5 rounded-full">
                  {s.visuals.length} visual{s.visuals.length > 1 ? 's' : ''}
                </span>
              )}
              {s.videoId && (
                <span className="bg-indigo-900/50 text-indigo-400 px-2 py-0.5 rounded-full">Posted</span>
              )}
            </div>
            {s.notes && <p className="text-xs text-zinc-400 mt-2">{s.notes}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add archive link to main page header**

In `app/page.tsx`, the `ChatInterface` receives the topic. Pass a nav prop or add a link. The simplest: add a nav bar above `ChatInterface` in page.tsx:
```typescript
import Link from 'next/link'

// In the JSX, wrap the return:
return (
  <div className="flex flex-col h-screen">
    <nav className="flex justify-end px-4 py-2 border-b border-zinc-800 bg-zinc-950 shrink-0">
      <Link href="/archive" className="text-xs text-zinc-500 hover:text-zinc-300">Archive</Link>
      <span className="mx-2 text-zinc-700">·</span>
      <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">Dashboard</Link>
    </nav>
    <div className="flex-1 min-h-0">
      <ChatInterface topic={topic} initialMessage={openingMessage} />
    </div>
  </div>
)

// Also update ChatInterface.tsx: change the outer <div className="flex flex-col h-screen ..."> to <div className="flex flex-col h-full ..."> so it fills its parent instead of locking to viewport height.
```

- [ ] **Step 3: Commit**

```bash
git add app/archive/page.tsx app/page.tsx
git commit -m "feat: add archive page for past sessions"
```

---

## Task 15: Growth Tracker — Manual Input

**Files:**
- Create: `app/api/growth/manual/route.ts`
- Create: `__tests__/growth-tracker.test.ts`

- [ ] **Step 1: Write failing test**

Create `__tests__/growth-tracker.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    video: {
      upsert: vi.fn().mockResolvedValue({ id: 'v1' }),
    },
    growthSnapshot: {
      create: vi.fn().mockResolvedValue({ id: 'g1' }),
    },
  },
}))

describe('manual growth input', () => {
  it('accepts valid video stats', async () => {
    const { POST } = await import('@/app/api/growth/manual/route')
    const req = new Request('http://localhost/api/growth/manual', {
      method: 'POST',
      body: JSON.stringify({
        title: 'My AI video',
        views: 1000,
        likes: 50,
        comments: 10,
        shares: 5,
        topicType: 'ai-news',
        followers: 500,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm test __tests__/growth-tracker.test.ts
```

Expected: `FAIL — Cannot find module '@/app/api/growth/manual/route'`

- [ ] **Step 3: Implement manual input route**

Create `app/api/growth/manual/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  title: z.string().min(1),
  tiktokId: z.string().optional(),
  views: z.number().int().min(0),
  likes: z.number().int().min(0),
  comments: z.number().int().min(0),
  shares: z.number().int().min(0),
  topicType: z.enum(['ai-news', 'personal-story', 'workforce']).default('ai-news'),
  followers: z.number().int().min(0).optional(),
  sessionId: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { title, tiktokId, views, likes, comments, shares, topicType, followers, sessionId } = parsed.data

  const video = await prisma.video.upsert({
    where: { tiktokId: tiktokId ?? `manual-${Date.now()}` },
    create: { title, tiktokId, views, likes, comments, shares, topicType, sessionId },
    update: { views, likes, comments, shares },
  })

  if (followers !== undefined) {
    await prisma.growthSnapshot.create({
      data: { followers, source: 'manual' },
    })
  }

  return NextResponse.json({ id: video.id })
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test __tests__/growth-tracker.test.ts
```

Expected: `PASS — 1 test passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/growth/manual/route.ts __tests__/growth-tracker.test.ts
git commit -m "feat: add manual growth input API route"
```

---

## Task 16: Growth Tracker — Screenshot Vision Parsing

**Files:**
- Create: `app/api/upload/route.ts`

- [ ] **Step 1: Implement screenshot vision route**

Create `app/api/upload/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { anthropic } from '@/lib/agent'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('screenshot') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const base64 = buffer.toString('base64')
  const mediaType = (file.type as 'image/jpeg' | 'image/png' | 'image/webp') ?? 'image/jpeg'

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: 'This is a TikTok analytics screenshot. Extract these numbers and return ONLY valid JSON: { "followers": number, "profileViews": number, "videoViews": number }. Use 0 for any value you cannot find.',
          },
        ],
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  let stats: { followers: number; profileViews: number; videoViews: number }
  try {
    stats = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Could not parse stats from screenshot' }, { status: 422 })
  }

  if (stats.followers) {
    await prisma.growthSnapshot.create({
      data: {
        followers: stats.followers,
        profileViews: stats.profileViews ?? 0,
        source: 'screenshot',
      },
    })
  }

  return NextResponse.json(stats)
}
```

- [ ] **Step 2: Test manually**

```bash
# Use any TikTok analytics screenshot you have
curl -X POST http://localhost:3000/api/upload \
  -F "screenshot=@/path/to/tiktok-screenshot.jpg"
```

Expected: JSON with `followers`, `profileViews`, `videoViews` extracted from the image.

- [ ] **Step 3: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat: add screenshot vision parsing for TikTok analytics"
```

---

## Task 17: Growth Tracker — TikTok API Sync

**Files:**
- Create: `lib/growth-tracker.ts`
- Create: `app/api/growth/sync/route.ts`

- [ ] **Step 1: Implement growth tracker lib**

Create `lib/growth-tracker.ts`:
```typescript
import { prisma } from './db'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const WEIGHTS_PATH = join(process.cwd(), 'data/performance-weights.json')

// Fetch TikTok user info using stored access token
export async function syncTikTokStats(accessToken: string) {
  const res = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=follower_count,profile_deep_link',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  )

  if (!res.ok) throw new Error(`TikTok API error: ${res.status}`)
  const data = await res.json()
  const followers = data?.data?.user?.follower_count ?? 0

  await prisma.growthSnapshot.create({
    data: { followers, source: 'api' },
  })

  return { followers }
}

// Rebuild performance-weights.json from video history
export async function rebuildWeights() {
  const videos = await prisma.video.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })

  if (videos.length === 0) return

  const grouped: Record<string, { totalViews: number; count: number }> = {}
  for (const v of videos) {
    if (!grouped[v.topicType]) grouped[v.topicType] = { totalViews: 0, count: 0 }
    grouped[v.topicType].totalViews += v.views
    grouped[v.topicType].count += 1
  }

  const avgViews = Object.values(grouped).reduce((s, g) => s + g.totalViews / g.count, 0) / Object.keys(grouped).length

  const weights: Record<string, number> = {}
  for (const [type, g] of Object.entries(grouped)) {
    weights[type] = (g.totalViews / g.count) / avgViews
  }

  writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2))
  return weights
}
```

- [ ] **Step 2: Implement sync route**

Create `app/api/growth/sync/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { syncTikTokStats, rebuildWeights } from '@/lib/growth-tracker'

// This route is called by a Vercel cron job daily
// Configure in vercel.json: { "crons": [{ "path": "/api/growth/sync", "schedule": "0 8 * * *" }] }
export async function POST(req: NextRequest) {
  const accessToken = req.headers.get('x-tiktok-token') ?? process.env.TIKTOK_ACCESS_TOKEN

  if (!accessToken) {
    return NextResponse.json({ error: 'No TikTok access token' }, { status: 401 })
  }

  try {
    const stats = await syncTikTokStats(accessToken)
    const weights = await rebuildWeights()
    return NextResponse.json({ synced: true, stats, weights })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
```

- [ ] **Step 3: Create vercel.json for cron**

Create `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/growth/sync",
      "schedule": "0 8 * * *"
    }
  ]
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/growth-tracker.ts app/api/growth/sync/route.ts vercel.json
git commit -m "feat: add tiktok sync and performance weights rebuild"
```

---

## Task 18: Dashboard Page

**Files:**
- Create: `components/dashboard/FollowerChart.tsx`
- Create: `components/dashboard/TopVideosTable.tsx`
- Create: `components/dashboard/TopicHeatmap.tsx`
- Create: `app/dashboard/page.tsx`

- [ ] **Step 1: FollowerChart component**

Create `components/dashboard/FollowerChart.tsx`:
```typescript
'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'

interface Snapshot {
  date: string
  followers: number
}

export function FollowerChart({ data }: { data: Snapshot[] }) {
  const formatted = data.map(d => ({
    ...d,
    date: format(new Date(d.date), 'MMM d'),
  }))

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Follower Growth</p>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={formatted}>
          <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: '#18181b', border: 'none', borderRadius: 8 }}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#ffffff' }}
          />
          <Line type="monotone" dataKey="followers" stroke="#6366f1" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 2: TopVideosTable component**

Create `components/dashboard/TopVideosTable.tsx`:
```typescript
interface Video {
  id: string
  title: string
  views: number
  likes: number
  comments: number
  shares: number
  topicType: string
}

export function TopVideosTable({ videos }: { videos: Video[] }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Top Videos</p>
      <div className="space-y-3">
        {videos.map(v => (
          <div key={v.id} className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate">{v.title}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {v.views.toLocaleString()} views · {v.likes} likes · {v.comments} comments
              </p>
            </div>
            <span className="text-xs bg-zinc-800 px-2 py-0.5 rounded-full whitespace-nowrap">
              {v.topicType}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: TopicHeatmap component**

Create `components/dashboard/TopicHeatmap.tsx`:
```typescript
const TOPIC_TYPES = ['ai-news', 'personal-story', 'workforce']
const LABELS: Record<string, string> = {
  'ai-news': 'AI News',
  'personal-story': 'Personal Story',
  'workforce': 'Workforce',
}

interface VideoStat {
  topicType: string
  views: number
}

export function TopicHeatmap({ videos }: { videos: VideoStat[] }) {
  const stats = TOPIC_TYPES.map(type => {
    const matching = videos.filter(v => v.topicType === type)
    const avgViews = matching.length > 0
      ? Math.round(matching.reduce((s, v) => s + v.views, 0) / matching.length)
      : 0
    return { type, avgViews, count: matching.length }
  })

  const maxAvg = Math.max(...stats.map(s => s.avgViews), 1)

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Topic Performance</p>
      <div className="space-y-3">
        {stats.map(s => (
          <div key={s.type}>
            <div className="flex justify-between text-xs mb-1">
              <span>{LABELS[s.type]}</span>
              <span className="text-zinc-400">{s.avgViews.toLocaleString()} avg views</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-600 rounded-full transition-all"
                style={{ width: `${(s.avgViews / maxAvg) * 100}%` }}
              />
            </div>
            <p className="text-xs text-zinc-600 mt-0.5">{s.count} video{s.count !== 1 ? 's' : ''}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Dashboard page**

Create `app/dashboard/page.tsx`:
```typescript
import { prisma } from '@/lib/db'
import { FollowerChart } from '@/components/dashboard/FollowerChart'
import { TopVideosTable } from '@/components/dashboard/TopVideosTable'
import { TopicHeatmap } from '@/components/dashboard/TopicHeatmap'
import Link from 'next/link'

export default async function DashboardPage() {
  const [snapshots, videos] = await Promise.all([
    prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' }, take: 30 }),
    prisma.video.findMany({ orderBy: { views: 'desc' }, take: 20 }),
  ])

  const latestFollowers = snapshots.at(-1)?.followers ?? 0

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-bold">Growth</h1>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Today</Link>
      </div>

      <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
        <p className="text-xs text-zinc-400">Followers</p>
        <p className="text-3xl font-bold">{latestFollowers.toLocaleString()}</p>
      </div>

      <FollowerChart data={snapshots.map(s => ({ date: s.date.toISOString(), followers: s.followers }))} />
      <TopicHeatmap videos={videos.map(v => ({ topicType: v.topicType, views: v.views }))} />
      <TopVideosTable videos={videos.map(v => ({ id: v.id, title: v.title, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, topicType: v.topicType }))} />
    </div>
  )
}
```

- [ ] **Step 5: Test in browser**

```bash
# Add some test data first
curl -X POST http://localhost:3000/api/growth/manual \
  -H "Content-Type: application/json" \
  -d '{"title":"My first AI video","views":1200,"likes":80,"comments":15,"shares":8,"topicType":"ai-news","followers":320}'
```

Open `http://localhost:3000/dashboard` — should show follower count, topic heatmap, and top videos table.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/ app/dashboard/page.tsx
git commit -m "feat: add growth dashboard with follower chart, topic heatmap, top videos"
```

---

## Task 19: Deploy to Vercel

**Files:**
- Modify: `vercel.json` (already created in Task 17)

- [ ] **Step 1: Push to GitHub**

```bash
gh repo create creator-studio --private --source=. --push
```

- [ ] **Step 2: Deploy**

```bash
npx vercel --prod
```

When prompted:
- Link to existing project? No
- Project name: `creator-studio`
- Directory: `./`

- [ ] **Step 3: Set environment variables in Vercel**

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add OPENAI_API_KEY production
vercel env add TIKTOK_CLIENT_KEY production
vercel env add TIKTOK_CLIENT_SECRET production
vercel env add TIKTOK_USERNAME production
vercel env add DATABASE_URL production
# DATABASE_URL for production: get from Supabase dashboard (postgresql://...)
```

- [ ] **Step 4: Migrate production DB**

```bash
# Point DATABASE_URL to Supabase and run:
DATABASE_URL="your_supabase_url" npx prisma migrate deploy
```

- [ ] **Step 5: Verify**

Open the Vercel URL on your phone. The app should load with today's topic pitch. Test sending a message and verify the visual generation works.

- [ ] **Step 6: Final commit**

```bash
git add vercel.json
git commit -m "feat: add vercel deployment config with daily cron sync"
```
