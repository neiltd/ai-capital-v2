# Archive & Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `/archive` and `/dashboard` pages, plus the DB and API plumbing they need.

**Architecture:** Next.js server components query Prisma directly for reads; two lightweight API routes handle manual data entry (POST) from client components. The archive page lists past sessions; the dashboard shows video performance and follower growth with a manual entry form for each.

**Tech Stack:** Next.js 16 App Router, Prisma + SQLite, Recharts (already used in `ChartRenderer`), Zod (already used in session route), Tailwind + shadcn components.

---

### Task 1: DB Migration

**Files:**
- No new files — runs CLI commands to push the Prisma schema to the SQLite DB and generate the Prisma client.

- [ ] **Step 1: Generate Prisma client and push schema**

```bash
cd /Users/thanapold/Desktop/Projects/creator-studio
npx prisma generate
npx prisma db push
```

Expected output ends with: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 2: Verify DB file exists**

```bash
ls -lh /Users/thanapold/Desktop/Projects/creator-studio/*.db
```

Expected: a `ruvector.db` (already exists) — also confirm `DATABASE_URL` is set in `.env.local`. If `.env.local` doesn't exist, create it with:

```
DATABASE_URL="file:./ruvector.db"
ANTHROPIC_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
TIKTOK_USERNAME=yourchannel
```

- [ ] **Step 3: Commit**

```bash
git add prisma/
git commit -m "chore: run prisma db push — sync schema to sqlite"
```

---

### Task 2: `POST /api/videos` and `POST /api/growth`

**Files:**
- Create: `app/api/videos/route.ts`
- Create: `app/api/growth/route.ts`

These routes handle manual data entry from the dashboard form.

- [ ] **Step 1: Write failing test for videos route**

Create `__tests__/api-videos.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { POST } from '@/app/api/videos/route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    video: {
      create: vi.fn().mockResolvedValue({ id: 'v1', title: 'Test video', views: 1000, likes: 50, comments: 10, shares: 5, topicType: 'ai-news', tiktokId: null, sessionId: null, postedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }),
    },
  },
}))

describe('POST /api/videos', () => {
  it('creates a video record and returns it', async () => {
    const req = new NextRequest('http://localhost/api/videos', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test video', views: 1000, likes: 50, comments: 10, shares: 5 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('v1')
  })

  it('rejects missing title with 400', async () => {
    const req = new NextRequest('http://localhost/api/videos', {
      method: 'POST',
      body: JSON.stringify({ views: 1000 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/thanapold/Desktop/Projects/creator-studio
npm test -- __tests__/api-videos.test.ts
```

Expected: FAIL — `app/api/videos/route.ts` does not exist.

- [ ] **Step 3: Create `app/api/videos/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  title: z.string().min(1),
  tiktokId: z.string().optional(),
  postedAt: z.string().optional(),
  views: z.number().int().default(0),
  likes: z.number().int().default(0),
  comments: z.number().int().default(0),
  shares: z.number().int().default(0),
  topicType: z.string().default('ai-news'),
  sessionId: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const video = await prisma.video.create({
    data: {
      ...parsed.data,
      postedAt: parsed.data.postedAt ? new Date(parsed.data.postedAt) : null,
    },
  })
  return NextResponse.json(video)
}

export async function GET() {
  const videos = await prisma.video.findMany({ orderBy: { postedAt: 'desc' } })
  return NextResponse.json(videos)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- __tests__/api-videos.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Write failing test for growth route**

Create `__tests__/api-growth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { POST } from '@/app/api/growth/route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    growthSnapshot: {
      create: vi.fn().mockResolvedValue({ id: 'g1', followers: 500, profileViews: 200, source: 'manual', date: new Date(), createdAt: new Date() }),
    },
  },
}))

describe('POST /api/growth', () => {
  it('creates a growth snapshot and returns it', async () => {
    const req = new NextRequest('http://localhost/api/growth', {
      method: 'POST',
      body: JSON.stringify({ followers: 500, profileViews: 200 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.followers).toBe(500)
  })

  it('rejects missing followers with 400', async () => {
    const req = new NextRequest('http://localhost/api/growth', {
      method: 'POST',
      body: JSON.stringify({ profileViews: 200 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npm test -- __tests__/api-growth.test.ts
```

Expected: FAIL — `app/api/growth/route.ts` does not exist.

- [ ] **Step 7: Create `app/api/growth/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const schema = z.object({
  followers: z.number().int(),
  profileViews: z.number().int().default(0),
  source: z.enum(['manual', 'api', 'screenshot']).default('manual'),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const snapshot = await prisma.growthSnapshot.create({ data: parsed.data })
  return NextResponse.json(snapshot)
}

export async function GET() {
  const snapshots = await prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' } })
  return NextResponse.json(snapshots)
}
```

- [ ] **Step 8: Run all tests**

```bash
npm test
```

Expected: All pass (existing + new).

- [ ] **Step 9: Commit**

```bash
git add app/api/videos/ app/api/growth/ __tests__/api-videos.test.ts __tests__/api-growth.test.ts
git commit -m "feat: add videos and growth snapshot API routes"
```

---

### Task 3: Archive Page

**Files:**
- Create: `app/archive/page.tsx`

Server component — queries sessions directly via Prisma, no client JS needed.

- [ ] **Step 1: Create `app/archive/page.tsx`**

```tsx
import { prisma } from '@/lib/db'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'

export const dynamic = 'force-dynamic'

export default async function ArchivePage() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const parsed = sessions.map(s => ({
    ...s,
    topic: JSON.parse(s.topic) as { title: string; suggestedAngle: string },
    storyArc: s.storyArc ? JSON.parse(s.storyArc) as { hook: string; beats: string[]; personalAngle: string; cta: string } : null,
    visuals: JSON.parse(s.visuals) as { type: string; label: string }[],
  }))

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-lg font-semibold">Archive</h1>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Back</Link>
      </div>

      {parsed.length === 0 && (
        <p className="text-sm text-zinc-500">No sessions saved yet. Chat with your topic and hit Save.</p>
      )}

      <ul className="space-y-4">
        {parsed.map(s => (
          <li key={s.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium leading-snug">{s.topic.title}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.topic.suggestedAngle}</p>
              </div>
              <span className="text-xs text-zinc-600 shrink-0">
                {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
              </span>
            </div>

            {s.storyArc && (
              <div className="mt-3 border-t border-zinc-800 pt-3 space-y-1">
                <p className="text-xs text-indigo-400 font-medium">Hook</p>
                <p className="text-xs text-zinc-300">{s.storyArc.hook}</p>
              </div>
            )}

            {s.visuals.length > 0 && (
              <div className="mt-3 flex gap-2 flex-wrap">
                {s.visuals.map((v, i) => (
                  <span key={i} className="text-[10px] bg-zinc-800 text-zinc-400 rounded px-2 py-0.5 capitalize">
                    {v.type} · {v.label}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Start dev server and verify the archive page loads**

```bash
cd /Users/thanapold/Desktop/Projects/creator-studio
npm run dev
```

Visit `http://localhost:3000/archive`. Expected: renders with "No sessions saved yet" empty state (since DB is fresh). No errors in terminal.

- [ ] **Step 3: Commit**

```bash
git add app/archive/page.tsx
git commit -m "feat: add archive page showing saved sessions"
```

---

### Task 4: Dashboard Page

**Files:**
- Create: `app/dashboard/page.tsx` — server component shell, fetches videos + growth data
- Create: `components/dashboard/VideoForm.tsx` — client component, POST to `/api/videos`
- Create: `components/dashboard/GrowthForm.tsx` — client component, POST to `/api/growth`
- Create: `components/dashboard/GrowthChart.tsx` — client component, Recharts line chart

- [ ] **Step 1: Create `components/dashboard/VideoForm.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function VideoForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ title: '', views: '', likes: '', comments: '', shares: '', tiktokId: '' })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title,
        tiktokId: form.tiktokId || undefined,
        views: Number(form.views) || 0,
        likes: Number(form.likes) || 0,
        comments: Number(form.comments) || 0,
        shares: Number(form.shares) || 0,
      }),
    })
    setLoading(false)
    setOpen(false)
    setForm({ title: '', views: '', likes: '', comments: '', shares: '', tiktokId: '' })
    onSaved()
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        + Add Video
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-400">Add video stats</p>
      <Input placeholder="Title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required className="bg-zinc-800 border-zinc-700 text-sm" />
      <Input placeholder="TikTok ID (optional)" value={form.tiktokId} onChange={e => setForm(f => ({ ...f, tiktokId: e.target.value }))} className="bg-zinc-800 border-zinc-700 text-sm" />
      <div className="grid grid-cols-4 gap-2">
        {(['views', 'likes', 'comments', 'shares'] as const).map(k => (
          <Input key={k} placeholder={k} type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} className="bg-zinc-800 border-zinc-700 text-sm" />
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={loading} size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-xs">
          {loading ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-xs">
          Cancel
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Create `components/dashboard/GrowthForm.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function GrowthForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [followers, setFollowers] = useState('')
  const [profileViews, setProfileViews] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/growth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followers: Number(followers), profileViews: Number(profileViews) || 0 }),
    })
    setLoading(false)
    setOpen(false)
    setFollowers('')
    setProfileViews('')
    onSaved()
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        + Log Followers
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-400">Log today's follower count</p>
      <Input placeholder="Followers" type="number" value={followers} onChange={e => setFollowers(e.target.value)} required className="bg-zinc-800 border-zinc-700 text-sm" />
      <Input placeholder="Profile views (optional)" type="number" value={profileViews} onChange={e => setProfileViews(e.target.value)} className="bg-zinc-800 border-zinc-700 text-sm" />
      <div className="flex gap-2">
        <Button type="submit" disabled={loading} size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-xs">
          {loading ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-xs">
          Cancel
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 3: Create `components/dashboard/GrowthChart.tsx`**

```tsx
'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'

interface Snapshot {
  date: string
  followers: number
}

export function GrowthChart({ data }: { data: Snapshot[] }) {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-zinc-600">
        Log at least 2 follower counts to see the chart.
      </div>
    )
  }

  const chartData = data.map(s => ({
    date: format(new Date(s.date), 'MMM d'),
    followers: s.followers,
  }))

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData}>
        <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={{ background: '#18181b', border: 'none', borderRadius: 8 }}
          labelStyle={{ color: '#a1a1aa' }}
          itemStyle={{ color: '#ffffff' }}
        />
        <Line type="monotone" dataKey="followers" stroke="#6366f1" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
```

- [ ] **Step 4: Create `app/dashboard/page.tsx`**

```tsx
import { prisma } from '@/lib/db'
import Link from 'next/link'
import { VideoForm } from '@/components/dashboard/VideoForm'
import { GrowthForm } from '@/components/dashboard/GrowthForm'
import { GrowthChart } from '@/components/dashboard/GrowthChart'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const [videos, snapshots] = await Promise.all([
    prisma.video.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' } }),
  ])

  const totalViews = videos.reduce((sum, v) => sum + v.views, 0)
  const totalLikes = videos.reduce((sum, v) => sum + v.likes, 0)
  const latestFollowers = snapshots.at(-1)?.followers ?? 0

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 max-w-2xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Back</Link>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Followers', value: latestFollowers.toLocaleString() },
          { label: 'Total Views', value: totalViews.toLocaleString() },
          { label: 'Total Likes', value: totalLikes.toLocaleString() },
        ].map(stat => (
          <div key={stat.label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs text-zinc-500">{stat.label}</p>
            <p className="text-2xl font-bold mt-1">{stat.value || '—'}</p>
          </div>
        ))}
      </div>

      {/* Growth chart */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">Follower Growth</h2>
          <GrowthForm onSaved={() => {}} />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <GrowthChart data={snapshots.map(s => ({ date: s.date.toString(), followers: s.followers }))} />
        </div>
      </section>

      {/* Videos */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">Videos</h2>
          <VideoForm onSaved={() => {}} />
        </div>

        {videos.length === 0 && (
          <p className="text-sm text-zinc-500">No videos logged yet. Add one above.</p>
        )}

        <ul className="space-y-3">
          {videos.map(v => (
            <li key={v.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-medium leading-snug">{v.title}</p>
              <div className="flex gap-4 mt-2 text-xs text-zinc-400">
                <span>{v.views.toLocaleString()} views</span>
                <span>{v.likes.toLocaleString()} likes</span>
                <span>{v.comments.toLocaleString()} comments</span>
                <span>{v.shares.toLocaleString()} shares</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 5: Start dev server and verify dashboard loads**

```bash
npm run dev
```

Visit `http://localhost:3000/dashboard`. Expected: renders with all zeroes/empty states, no errors. The `+ Add Video` and `+ Log Followers` buttons open their forms.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/ components/dashboard/ app/api/videos/ app/api/growth/
git commit -m "feat: add dashboard with video stats and follower growth tracking"
```

---

## Self-Review

**Spec coverage:**
- DB migration — Task 1 ✅
- `/api/session` — already built, not in scope ✅
- `/api/videos` POST + GET — Task 2 ✅
- `/api/growth` POST + GET — Task 2 ✅
- `/archive` page — Task 3 ✅
- `/dashboard` page with summary stats, growth chart, video list — Task 4 ✅
- Manual entry forms (VideoForm, GrowthForm) — Task 4 ✅

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `GrowthChart` receives `{ date: string; followers: number }[]` — matches what `DashboardPage` passes ✅
- `VideoForm` / `GrowthForm` call the exact API routes defined in Task 2 ✅
- `ChartConfig` in `ChartRenderer` matches what `/api/visuals/chart` returns ✅
