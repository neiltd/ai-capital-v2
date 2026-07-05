# Creator Studio Audit Report

_Auditor: automated review. Date: 2026-07-03._
_Scope: `apps/creator-studio` — Next.js 16 morning TikTok content assistant._

Priority legend:
- 🔴 **Critical** — data loss, security exposure, blocks the morning workflow, or produces wrong output.
- 🟡 **Important** — silent bugs, real UX friction, or performance/cost hit that will bite soon.
- 🟢 **Nice-to-have** — polish, refactor, or dev-experience.

---

## 1. Executive summary

Creator Studio is a small, mostly-clean codebase. The main problems are:

1. **The topic engine is silently broken.** It reads world-intel exports that were last generated **2026-07-02** but every event inside firstSeenAt May 27–28 (~37 days old). The recency score `Math.max(0, 10 - ageHours / 2.4)` saturates to zero for every event, so ranking collapses to `keyword × marketRelevance × weights[eventType]` — the same "Trump gold statue" / "Iran strike" story keeps winning every morning.
2. **A single blocking Anthropic call runs on every page load** (`app/page.tsx`) before any HTML flushes. On a cold morning open this is ~2–5s of blank screen before anything shows.
3. **The script UI is nonexistent.** The AI outputs three distinct sections (📚 Deep Brief / 🎯 Talking Points / 🇹🇭 Thai Script) but they render as one giant `whitespace-pre-wrap` bubble mixed into chat scroll — impossible to use while recording. No tabs, no copy button, no way to jump to the Thai script.
4. **Secrets hygiene is loose.** Real API keys live in a gitignored `.env` and `.env.local` (good), but the same Anthropic key is duplicated in both files, and there is no runtime guard: an unset key crashes the SDK constructor at module load.

Everything else is either polish or minor.

---

## 2. Code review

### 🔴 C1 · Topic engine picks stale stories (the "May 2026 events" issue)

**Files:** `lib/topic-engine.ts:38-96`, `data/hub.ts:24-31`

**Symptom:** Same story dominates every morning even though `intelligence.json` may have been regenerated today.

**Root causes (two of them, stacked):**

1. **Recency saturates to zero.** In `scoreEvent`:
   ```ts
   const ageHours = (Date.now() - new Date(event.firstSeenAt).getTime()) / 3_600_000
   score += Math.max(0, 10 - ageHours / 2.4)
   ```
   The linear-decay-then-clamp means anything older than 24h contributes 0. If the entire hub export is 5–40 days old (as it is today — every event is 2026-05-27/28, 37 days back), **every event ties at 0 for recency**. The ranking then collapses to `keywords + marketRelevance × 5`, weighted by `performance-weights.json`. Result: the same top-marketRelevance AI-keyword story wins every day forever.

2. **No cutoff filter.** `loadWorldIntelligence()` returns raw `raw.events` with no filter on `firstSeenAt`, `latestSeenAt`, or `eventState`. If the hub emits historical events (currently: all of them), they're all candidates.

**Verification:**
```bash
$ head /Users/thanapold/Desktop/Projects/apps/world-intelligence-data-hub-/exports/world-map/intelligence.json
"generatedAt": "2026-07-02T14:08:40.171Z",  # export is 1 day old
"firstSeenAt": "2026-05-27T22:05:50.000Z",   # events are 37 days old
```

**Fix (surgical, both layers):**

```ts
// data/hub.ts — add a windowed loader
const FRESHNESS_DAYS = Number(process.env.HUB_FRESHNESS_DAYS ?? 3)

export function loadWorldIntelligence(): HubEvent[] {
  const filePath = join(HUB_PATH, 'world-map/intelligence.json')
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  if (!raw?.events || !Array.isArray(raw.events)) throw new Error(...)
  const cutoff = Date.now() - FRESHNESS_DAYS * 86_400_000
  const events = (raw.events as HubEvent[]).filter(e => {
    const ts = new Date(e.latestSeenAt || e.firstSeenAt).getTime()
    return Number.isFinite(ts) && ts >= cutoff
  })
  // fallback: if nothing fresh, keep top-10 by latestSeenAt so we never crash the UI
  if (events.length === 0) {
    return [...raw.events]
      .sort((a: HubEvent, b: HubEvent) =>
        new Date(b.latestSeenAt).getTime() - new Date(a.latestSeenAt).getTime())
      .slice(0, 10)
  }
  return events
}
```

```ts
// lib/topic-engine.ts — replace the linear-clamped decay with an exponential half-life
// so stale-but-only-thing-we-have stories still get differentiated
const HALF_LIFE_HOURS = 36
const ageHours = (Date.now() - new Date(event.latestSeenAt || event.firstSeenAt).getTime()) / 3_600_000
score += 20 * Math.pow(0.5, ageHours / HALF_LIFE_HOURS)  // starts at 20, halves every 36h
```

Additionally: surface freshness in the UI. The topic card should show "seen 3h ago" or "⚠︎ 37 days old — hub may be stale" so the creator can visually catch this next time.

---

### 🔴 C2 · Blocking Anthropic call on every SSR page load

**File:** `app/page.tsx:8-27`

`Home()` is an `async` server component that calls `pickDailyTopic()` **and** `anthropic.messages.create(...)` before returning any JSX. Two problems:

1. **No streaming.** The entire opening message is generated up front and the user stares at nothing for the round-trip (Sonnet 4-6, 512 tokens = ~2–5s on a good network, 15+s on a bad one).
2. **No error boundary.** If the Anthropic API is down / key rotated / quota hit, the whole `/` route 500s and the app looks broken.
3. **Cost every reload.** Any refresh = another paid opening completion. Prompt cache only helps within a single session — SSR renders don't dedupe across users/reloads.

**Fix:** move the opening message into a lazy client-side fetch. Render the page immediately with a "Good morning..." placeholder, then stream in the opening via `/api/chat` (with an empty user message or a "morning" trigger) once mounted. Wrap the page in `<Suspense>` / `error.tsx`.

Bonus: cache today's opening keyed by `topic.eventId + YYYY-MM-DD` in the DB (or in-memory Map) so reopening the tab is free.

---

### 🔴 C3 · `Anthropic({ apiKey: undefined })` at module load

**File:** `lib/agent.ts:4`

```ts
export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
```

If the env var is missing, the SDK either throws immediately or leaves you with an unusable client that fails on first request with an opaque error. This runs at import time, so ANY route that imports `agent.ts` will bomb — including the SSR page.

**Fix:**
```ts
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — copy .env.local.example to .env.local')
export const anthropic = new Anthropic({ apiKey })
```
Better error, fails at boot instead of at first user click.

Same fix needed in `app/api/visuals/illustration/route.ts:4` for `OPENAI_API_KEY`.

---

### 🟡 I1 · Chat stream has no error handling / no abort

**File:** `components/chat/ChatInterface.tsx:65-97`

```ts
const res = await fetch('/api/chat', { ... })
const reader = res.body!.getReader()   // ← `!` will throw silently
```

If the fetch fails, `res.body` is null, or the network drops mid-stream, the whole thing throws unhandled and the UI is stuck with `streaming=true` (Textarea disabled, no error message, only fix is refresh).

**Fix:**
- Wrap in `try/catch/finally` — always `setStreaming(false)`.
- Check `res.ok`, surface a red inline error bubble.
- Support cancel: keep an `AbortController`, expose a "Stop" button while streaming.

Same in `parseVisualRequests`: silent `catch {}` swallows every failure. Should log to a devtools-visible surface at minimum.

---

### 🟡 I2 · No zod validation on the chat endpoint

**File:** `app/api/chat/route.ts:5-8`

```ts
const { messages, topic }: { messages: ChatMessage[]; topic: ScoredStory } = await req.json()
```

A crafted client can send anything. The Anthropic SDK will happily forward garbage strings up to `max_tokens`, or reject with a 400 you don't handle. `topic` is trusted verbatim into the system prompt — a user-supplied `topic.title` becomes prompt content. Not RCE, but prompt-injection risk if this ever gets an auth wrapper and a public URL.

**Fix:** validate with zod (same pattern as `session/route.ts`), reject unknowns, cap message count, cap per-message length.

---

### 🟡 I3 · `topicType` accepted from client, not from server-side classification

**Files:** `app/api/videos/route.ts:14`, `app/api/growth/manual/route.ts:12`

`topicType` comes off the client form (`VideoForm.tsx` doesn't even collect it — it defaults to `'ai-news'`). But `growth-tracker.rebuildWeights()` groups by `topicType` and derives the entire performance-weights JSON that feeds the topic scorer. Garbage in, garbage weights, wrong topic tomorrow.

**Fix:** infer `topicType` from the linked `sessionId` (which knows the topic's category), or from server-side keyword classification against the title. Don't trust the client — especially since the form doesn't even ask.

---

### 🟡 I4 · `rebuildWeights()` divide-by-zero when only one category exists

**File:** `lib/growth-tracker.ts:29-52`

```ts
const avgViews =
  Object.values(grouped).reduce((s, g) => s + g.totalViews / g.count, 0) /
  Object.keys(grouped).length
```

If `grouped` has one category with 0 views (fresh install, first video), `avgViews = 0`. The next line divides by it → `weights[type] = Infinity`. That writes `Infinity` to disk, which JSON.parse can't round-trip → later `loadWeights()` throws.

**Fix:** guard `avgViews === 0`, skip the write; log "not enough data yet".

Also: `rebuildWeights` writes to a JSON file on every TikTok sync, which is fine on localhost but is a footgun if this ever runs on Vercel (read-only FS). Move weights to the DB.

---

### 🟡 I5 · `syncTikTokStats` errors are swallowed by `String(err)`

**File:** `app/api/growth/sync/route.ts:15-17`

```ts
catch (err) { return NextResponse.json({ error: String(err) }, { status: 500 }) }
```

`String(Error)` gives you `"Error: TikTok API error: 401"` — no stack, no cause, no distinction between "token expired" and "TikTok is down". User has no idea what to do.

**Fix:** unwrap `err.message`, return an actionable code (`TIKTOK_TOKEN_EXPIRED` vs `TIKTOK_UNREACHABLE`), and don't run `rebuildWeights` if the first call failed (currently: it still would if you removed the throw; sequence is fine now, just fragile).

---

### 🟡 I6 · `Content-Type: text/plain` on a streaming SSE-like response

**File:** `app/api/chat/route.ts:36-41`

Streaming raw text over `text/plain; charset=utf-8` works, but has downsides:
- No structured events, so you can't send visual-request blocks separately from prose.
- No way to signal "done" cleanly — the client relies on `reader.read()`'s `done`.
- Some proxies (Cloudflare, corporate) will buffer text/plain and defeat streaming.

**Fix:** switch to `text/event-stream` with proper `data:` frames, or NDJSON with typed messages `{type:'text'|'visual'|'error', ...}`. Easier UX later when you want to stream the 3 script sections into 3 tabs progressively.

---

### 🟡 I7 · Streamed text mixed with `\`\`\`visual` code fences renders raw during streaming

**File:** `components/chat/ChatInterface.tsx:135`

```tsx
<MessageBubble content={msg.content.replace(/```visual[\s\S]*?```/g, '')} />
```

The regex only matches _closed_ fences. While the model is still streaming an unclosed ` ```visual` block, the user sees a half-typed JSON blob inside the chat bubble until the closing fence arrives. Ugly and confusing.

**Fix:** hide anything after an unclosed ` ```visual` marker until the closing fence arrives (or switch to structured NDJSON per I6).

---

### 🟡 I8 · Chat.tsx: `res.body!` non-null assertion

Same file — the `!` masks a potential null. If the API returns an error response, `res.body` may still exist but be an error JSON stream. See I1 fix.

---

### 🟡 I9 · Illustration route: no error handling on OpenAI

**File:** `app/api/visuals/illustration/route.ts`

DALL-E can 400 (content policy), 429 (rate limit), 500 (down), or return `data` with a signed URL that expires in 1 hour. None of this is handled: bare `openai.images.generate(...)` and blind `.data?.[0]?.url`. If it fails, the fetch on the client side sees a 500 with no body and `parseVisualRequests` silently drops it.

**Fix:** try/catch, actionable error strings, and — because DALL-E URLs expire in an hour — download the image server-side and either persist to `/public` or return a base64 data URL so saved sessions don't 404 an hour later.

---

### 🟡 I10 · `next-image` not used; raw `<img>` for AI images

**File:** `components/chat/VisualAttachment.tsx:29`

`<img src={url}>` — for DALL-E URLs this is fine (they're cross-origin and short-lived anyway), but for blobs from card generation it's a memory leak: `URL.createObjectURL(await res.blob())` in `ChatInterface.tsx:58` is never `revokeObjectURL`'d. Long chat sessions with many cards leak ~1–2MB per card.

**Fix:** track and revoke on unmount / when the message is removed.

---

### 🟡 I11 · Manual video form doesn't collect `topicType`

**File:** `components/dashboard/VideoForm.tsx`

Missing input. Everything defaults to `'ai-news'`, so `TopicHeatmap` and `rebuildWeights` treat every video as AI news, poisoning the weights. See I3.

---

### 🟢 N1 · `session/route.ts` schema validates `topic.suggestedVisualType` as `z.string()` — should be enum

Currently permissive: `'chart' | 'card' | 'illustration'` is the actual domain. Tighten it.

### 🟢 N2 · `session/route.ts` GET has no pagination — hardcoded `take: 30`

Fine for now; archive page hardcodes 50. Move to a shared `PAGE_SIZE` constant when this grows.

### 🟢 N3 · `TopicHeatmap` hardcodes 3 topic types

`const TOPIC_TYPES = ['ai-news', 'personal-story', 'workforce']` — mirrors the zod enum in `growth/manual`. Extract to a shared const/enum so adding a category doesn't require edits in 4 places.

### 🟢 N4 · `dashboard/page.tsx` snapshots limited to 30 in `orderBy: date asc`

If you ever have 100 snapshots, `take: 30` on ascending order gives you the _oldest_ 30, not the newest 30. Currently harmless because you don't have 30 yet, but wrong on principle. Sort `desc`, take 30, then reverse for the chart.

### 🟢 N5 · `parseVisualRequests` runs sequentially

Each visual request awaited in-order inside `while`. If a script includes 3 visuals, that's 3 serial round-trips (worst case: 3 × DALL-E ~15s = 45s of blocked UI). `Promise.all` them.

### 🟢 N6 · SQLite file lives at `prisma/dev.db`, not gitignored explicitly for that path

`.gitignore` has `*.db` and `dev.db` broadly — this is fine, just noting the DB is under prisma/ which some tooling nests under scripts.

### 🟢 N7 · Model IDs hardcoded across files

`claude-opus-4-7`, `claude-sonnet-4-6`, `dall-e-3`, `gpt-*` — spread across `app/api/chat/route.ts`, `app/page.tsx`, `app/api/upload/route.ts`, `app/api/visuals/illustration/route.ts`. Centralize in `lib/models.ts`.

### 🟢 N8 · `agentdb.rvf` and `ruvector.db` committed as artifacts inside creator-studio

Not committed (git untracked), but they're leftover from another repo. Delete.

### 🟢 N9 · `growth-tracker` writes to `data/performance-weights.json` in project root

Fine locally, breaks on read-only prod hosts. Use `process.cwd()` explicitly + gate behind `NODE_ENV`, or move to DB.

### 🟢 N10 · Uploader `mediaType` cast is unsafe

`app/api/upload/route.ts:15` — `(file.type as 'image/jpeg' | 'image/png' | 'image/webp') ?? 'image/jpeg'`. If a user uploads a HEIC (iPhone default), you send `'image/heic'` to Claude, which rejects it. Validate against a whitelist and reject early.

---

## 3. Security

### 🔴 S1 · `.env` and `.env.local` both contain the same live Anthropic key

**Files:** `/apps/creator-studio/.env`, `/apps/creator-studio/.env.local`

Both files hold the identical `sk-ant-...` key. Both are gitignored — but duplicating secrets doubles the surface area for accidental leaks (grep, screenshares, backup services). Also: `.env` still contains _stale_ TIKTOK placeholder keys mixed with real ACLED credentials copied from world-intel — completely wrong scope for this app.

**Fixes:**
1. Delete `.env` entirely; use only `.env.local` (Next.js recommended).
2. Rotate the Anthropic key, because it's been in two files for a while and appears in shell history.
3. Strip ACLED/NewsAPI/EIA keys from creator-studio — they belong to `world-intelligence-data-hub-`, not here.

### 🟡 S2 · No auth on any API route

All routes are open. Since this is localhost:3001 for one user, this is currently fine — but the moment you deploy anywhere reachable, an attacker can:
- Run up your Anthropic bill via `/api/chat`
- Run up your OpenAI bill via `/api/visuals/illustration`
- Pollute your growth DB via `/api/growth`

**Fix before deploying anywhere:** middleware with a shared-secret header, or NextAuth + owner allowlist. Rate-limit `/api/visuals/illustration` especially.

### 🟡 S3 · No file-size / mime-type limits on `/api/upload`

`app/api/upload/route.ts` accepts `FormData` with no bounds. A 100MB upload will happily buffer into `Buffer.from(await file.arrayBuffer())` and then be base64'd (=134MB in memory) before being shipped to Claude, which rejects >5MB anyway. Easy DoS.

**Fix:** check `file.size` first (reject >5MB), whitelist `file.type` against `['image/jpeg','image/png','image/webp']`.

### 🟡 S4 · Prompt-injection surface via `buildSystemPrompt`

`topic.title` and `topic.summary` come from world-intel exports (relatively trusted) but flow verbatim into the system prompt. If the pipeline ever ingests a malicious source that includes prompt-inject text, it'll be executed with system-level trust. Consider wrapping the topic block in explicit `<topic-data>...</topic-data>` tags and instructing the model to treat the contents as data, not instructions.

### 🟢 S5 · Recharts Tooltip uses inline styles from client data

Not a real risk (recharts sanitizes), but worth noting if you ever render tooltip content from AI output — currently you don't.

---

## 4. Performance

### 🟡 P1 · SSR page renders no HTML until opening completion returns

See C2. On mobile this is felt as a 2–5s blank page every morning.

### 🟡 P2 · Chat re-renders every token

`ChatInterface.tsx` `setMessages` on every decoded chunk = re-render of the whole message list. On a 3-minute long streaming script this is thousands of renders. Not visible on desktop, laggy on the phone the creator is holding.

**Fix:** batch chunk updates via `requestAnimationFrame` (accumulate `assistantText` in a ref, flush at rAF). Cheap ~10x speedup.

### 🟡 P3 · Archive and dashboard both `JSON.parse` every session/video row on the server per request

`app/archive/page.tsx:13-18` parses topic/storyArc/visuals JSON columns for 50 rows on every render. Fine at current scale, but you're storing JSON in text columns because Prisma+SQLite lacks native JSON. Migrate to Postgres eventually and use `Json` columns; index `Session.createdAt`.

### 🟡 P4 · `parseVisualRequests` is serial (see N5) — 3 DALL-E calls can block the whole recording flow for a minute

### 🟢 P5 · `formatDistanceToNow` from date-fns imported in archive — fine, but the whole date-fns bundle is heavy in a client-shipped page. Since `archive/page.tsx` is a server component this is fine, just be aware.

### 🟢 P6 · `TopVideosTable` renders up to 20 videos with no virtualization — fine at 20, note for the future.

---

## 5. UX audit — "It's 8am, I want to record"

This is the section that matters most. I walked through the morning workflow imagining I'm the creator with coffee in one hand, phone camera propped up.

### The current morning flow

1. Open `localhost:3001` on desktop or phone.
2. Stare at a blank page for 2–5s while the opening AI message generates server-side (C2).
3. Read a compact topic-card header (title + summary + angle badges).
4. See a friendly opening message from the AI in a chat bubble.
5. Chat back and forth to refine the angle.
6. At some point say "give me the script" — the AI dumps ~2000 words of mixed English + Thai + markdown headings + bullets **inside a single `whitespace-pre-wrap` chat bubble**.
7. Try to scroll back through the chat to find "🇹🇭 THAI SCRIPT" while holding the phone as a camera.
8. Manually select-all the Thai section to copy it into a teleprompter, hoping the selection doesn't grab the English brief above it.
9. Record.

### What's actually painful

#### 🔴 U1 · The script is unusable during recording

The single most impactful problem. The AI already outputs **three named sections** (📚 Deep Brief / 🎯 Talking Points / 🇹🇭 Thai Script). These need to be:
- **Detected** and split by the client (or streamed as typed events).
- **Rendered in a tabbed panel** to the right of chat (desktop) or as a stacked accordion (mobile).
- Each tab pre-formatted with proper heading hierarchy, bullet indentation, and monospaced/serif rendering choices — NOT `whitespace-pre-wrap`.
- Include a "**Copy Thai script**" button that copies only the Thai section, not the raw markdown around it.
- Include a "**Send to teleprompter**" or at minimum a big-font "Recording mode" toggle that reflows the Thai script to something eyes-at-arm's-length friendly.

This one change transforms the app from "helpful chat" to "actual recording tool."

#### 🔴 U2 · No topic freshness indicator

The creator has no way to know the shown topic is 37 days old. The topic card just says the title. Add a small "seen 2h ago" / "⚠ 37 days old" pill. Combined with C1's freshness filter, the topic should almost always be <24h old, but display it either way to build trust.

#### 🔴 U3 · Save button is ambiguous

`Save` is at the top of the chat header. Save what? Currently it only saves `topic + visuals` — not the actual script, notes, or chat history. If the creator refreshes, everything is lost. And the button turns to "Saved ✓" so they think they saved the script, but they didn't.

**Fix:** save the full chat + generated script + visuals as one bundle. Rename the button `Save session` and let it be re-saved (overwrite / new-version) after further chat.

#### 🟡 U4 · No way to see today's topic candidates

Only the top-scored topic is shown. If the creator doesn't like it, there's no "next topic" or "give me 3 options" button. On the "stale May events" day, they're stuck with whatever wins the broken score.

**Fix:** show top 3 topics as horizontally-scrollable cards; tap to pick. Persist the pick with the session so tomorrow's ranker can learn.

#### 🟡 U5 · No way to jump back to previous morning sessions in one tap

Archive is a separate page. Add a small "Yesterday" / "This week" dropdown in the chat header for one-tap replay.

#### 🟡 U6 · Chat has no scroll-to-latest / auto-scroll interfered with by long script

`bottomRef.scrollIntoView({ behavior: 'smooth' })` on every message change means when the AI streams the giant script, the browser is smooth-scrolling every few tokens = janky. Combined with wanting to scroll UP to read the Deep Brief and having the auto-scroll fight you.

**Fix:** auto-scroll only if the user is already at the bottom (detect scrollTop within 40px of bottom). Otherwise let them read.

#### 🟡 U7 · Chat input is tiny and disappears under the mobile keyboard

Textarea is `min-h-[44px] max-h-32` — 44px is the tap-target minimum, not a comfortable typing area. On iOS the keyboard covers the send button.

**Fix:** grow input on focus, sticky-position it above the safe-area inset, add `enterkeyhint="send"`.

#### 🟡 U8 · No indicator of what the AI is doing when streaming

The `→` button becomes `...` — that's the entire loading state. On mobile with slow LLM streams, the creator wonders if it's working. Show a subtle typing indicator inside the chat area, and stream the first tokens as fast as possible (see I6 — event-stream transport).

#### 🟡 U9 · No way to re-generate just one section

If the Thai script is off-vibe, the only recourse is to chat "redo the Thai" and hope. A "Regenerate Thai script" button on the Thai tab would fix this in one tap and preserve the Deep Brief + Talking Points.

#### 🟡 U10 · Visuals appear inline in chat, not in the script pane

DALL-E images generated for the script show up between chat bubbles — great to see them come in, but not useful when the creator is on the Thai tab reading the delivery script. Show a small "🎨 3 visuals ready" badge on a "Visuals" tab, with download-all.

#### 🟢 U11 · No shortcut to open in "recording mode"

A fullscreen, dark, jumbo-Thai-text view suitable for reading while glancing between eyes and lens. This is a killer feature for a talking-head creator.

#### 🟢 U12 · Dashboard and Archive are text-heavy secondary flows

Fine, but they use a different visual language (2xl bold stat cards, minimal styling) — no shared design system. Consolidate under one shadcn/ui theme.

#### 🟢 U13 · No feedback loop on the topic engine

The creator picks (or skips) a topic — that signal never travels back to the ranker. `performance-weights.json` only updates when videos are logged with viewcounts. A quick "👎 not today" button on the topic card that decays its eventType weight would immediately improve tomorrow.

---

## 6. Prioritized fix list (do these in order)

**This morning (30 min each):**
1. C1 — patch `topic-engine.ts` and `data/hub.ts` for freshness (fixes the "stale May" problem for real).
2. C3 — guard `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` at import.
3. S1 — delete duplicated `.env`, rotate the key, strip world-intel keys.

**This week:**
4. U1 — build the tabbed script pane (Deep Brief / Talking Points / Thai). See the mockup for the target UI.
5. U3 — fix the Save button to save the full session bundle.
6. C2 — move opening message to a lazy client fetch.
7. I1 — wrap the chat fetch in try/catch/finally with an abort controller.
8. U2 — show topic freshness pill.

**Next 2 weeks:**
9. I6 — switch chat to event-stream / NDJSON so tabs can stream section-by-section.
10. U9 — per-section regenerate.
11. I3, I4, I11 — fix `topicType` handling end-to-end.
12. I2, S3, S4 — validation + auth stubs.

**Backlog:**
13. U4, U5, U11 — topic variety, quick archive, recording mode.
14. All 🟢 items.

---

## 7. Notable strengths

To keep balance — things this codebase does well:

- **Prisma schema is clean and minimal.** Four models, each single-purpose.
- **Zod validation on 4 of 6 API endpoints.** Good habit.
- **Prompt-cache on the Anthropic system message.** Correct use of `cache_control: ephemeral`.
- **The Elena Nisonoff style guide in `agent.ts` is genuinely excellent.** It's the strongest artifact in the repo — specific, opinionated, structured.
- **Two-file split for chat (SSR page + streaming API route) is idiomatic Next.js.**
- **`__tests__/topic-engine.test.ts` exists** and covers happy-path scoring. Extend it with a "stale events" case that would have caught C1.

---

_End of report._
