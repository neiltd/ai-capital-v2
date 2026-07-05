# Creator Studio — Design Spec
**Date:** 2026-05-21  
**Status:** Approved

---

## Overview

Creator Studio is a mobile-first Next.js web app that helps a TikTok creator produce daily 5–10 minute AI/world news content. The app opens each morning with an AI-picked topic, runs a casual chat to refine the story arc (including personal narrative angles), generates visual assets, and tracks TikTok growth — feeding performance data back to improve future topic picks.

**Target audience for the TikTok channel:** Investors and AI-curious people.  
**Content tone:** Casual chitchat with a friend — never stiff or formal.  
**Content mix:** AI/world news + life in LA + Thai-immigrant perspective + US workforce market.

---

## Architecture

Five core systems, data flows one direction:

```
world-intelligence-data-hub exports
  → Topic Engine (score + rank AI stories)
  → Daily topic pitch (auto-shown on app open)
  → Chat Agent (Claude API conversation)
  → Talking points + personal angles finalized
  → Visual Generator (chart / headline card / AI illustration)
  → Session Logger (archive)

TikTok performance data (API / manual / screenshot)
  → Growth Tracker
  → Feedback loop → adjusts Topic Engine scoring weights
```

---

## System 1: Topic Engine

**Purpose:** Every morning, reads `world-intelligence-data-hub` exports and surfaces the single best AI story for that day.

**Scoring factors:**
- Investor relevance (funding, valuation, market shift keywords)
- Freshness (published within last 24h weighted highest)
- Personal angle potential (jobs, immigration, US tech economy)
- Historical performance (topics similar to past high-performing videos ranked higher)

**Output:** A single top story with metadata: headline, source, summary, suggested personal angle, suggested visual type.

**Data source:** Reads directly from `../world-intelligence-data-hub/exports/` — no re-ingestion, no duplication.

---

## System 2: Chat Agent

**Purpose:** Conversational partner that helps refine the daily topic into a ready-to-record story arc.

**Persona context (always in system prompt):**
- Creator is Thai, lives in LA, came to the US as an adult
- Audience = investors + AI-curious people
- Tone = casual friend, not news anchor
- Content = 5–10 min TikTok talks

**Conversation flow:**
1. App opens → agent delivers topic pitch in casual voice
2. Creator chats freely — pushes back, redirects, adds their take
3. Agent suggests personal tie-ins (LA angle, immigrant perspective, workforce angle)
4. Agent locks in story arc: Hook → 3 Beats → Personal angle → CTA
5. Creator can request visuals at any point mid-conversation

**Model:** Claude Sonnet 4.6  
**Vision:** Enabled (used for screenshot parsing in Growth Tracker)

---

## System 3: Visual Generator

Three modes — agent picks automatically based on context, or creator requests explicitly:

| Type | Trigger | Implementation |
|---|---|---|
| Data chart | Funding numbers, market stats, growth trends | Recharts (client-side) + `html-to-image` for PNG export |
| Headline card | Breaking news, quotes, key facts | `@napi-rs/canvas` (server-side) — dark background, bold text, creator branding |
| AI illustration | Abstract concepts, mood, metaphors | DALL-E 3 via OpenAI API |

All visuals render inline in the chat and are downloadable as PNG. Charts render in-browser first then snapshot; headline cards and AI illustrations are generated server-side and streamed as PNG.

---

## System 4: Session Logger

Every completed daily session is stored with:
- Date
- Topic (headline, source, category)
- Final story arc (hook, 3 beats, personal angle, CTA)
- Visuals generated (type + file reference)
- Creator notes (optional freetext)
- Linked TikTok video ID (added after posting)

Sessions are browsable as a content archive in the app.

---

## System 5: Growth Tracker

**Data ingestion — three paths:**

1. **TikTok Display API (auto):** Daily cron syncs available metrics — views, followers, profile visits. Requires one-time OAuth login with your TikTok creator account.
2. **Manual input:** Quick form per video — title, views, likes, comments, shares
3. **Screenshot upload:** Creator snaps TikTok analytics screen → Claude Vision parses numbers → logged automatically

**Dashboard shows:**
- Follower growth curve (daily)
- Top performing videos by view count
- Engagement rate per video (likes + comments + shares / views)
- Topic type heatmap — which angle (AI news / personal story / workforce) gets most traction

**Feedback loop:**
Growth Tracker writes a `performance-weights.json` that Topic Engine reads each morning. Topics similar to historically high-performing ones get a score boost.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) |
| Styling | Tailwind CSS + shadcn/ui |
| AI Conversation | Claude API — Sonnet 4.6 |
| Image Generation | DALL-E 3 (OpenAI API) |
| Charts | Recharts |
| Database | SQLite + Prisma (dev) → Supabase (production) |
| TikTok Integration | TikTok Display API |
| Deployment | Vercel (free tier) |

---

## Project Structure

```
creator-studio/
├── app/
│   ├── page.tsx                  # Daily chat interface (main screen)
│   ├── dashboard/
│   │   └── page.tsx              # Growth tracker dashboard
│   ├── archive/
│   │   └── page.tsx              # Past sessions browser
│   └── api/
│       ├── topic/route.ts        # Morning topic pick
│       ├── chat/route.ts         # Claude conversation (streaming)
│       ├── visuals/
│       │   ├── chart/route.ts    # Recharts data chart
│       │   ├── card/route.ts     # Canvas headline card
│       │   └── illustration/route.ts  # DALL-E 3
│       ├── growth/
│       │   ├── sync/route.ts     # TikTok API cron
│       │   └── manual/route.ts   # Manual video stats input
│       └── upload/route.ts       # Screenshot vision parsing
├── lib/
│   ├── topic-engine.ts           # Scoring + ranking logic
│   ├── agent.ts                  # Claude conversation + persona
│   ├── visual-generator.ts       # Routes to correct visual type
│   └── growth-tracker.ts         # TikTok API + feedback loop
├── data/
│   └── hub.ts                    # Reads world-intelligence-data-hub exports
├── components/
│   ├── chat/                     # Chat UI components
│   ├── visuals/                  # Visual render + download
│   └── dashboard/                # Growth charts + heatmap
└── prisma/
    └── schema.prisma             # Sessions, videos, growth metrics
```

---

## Integration with Existing Projects

- **world-intelligence-data-hub:** `data/hub.ts` reads directly from `../world-intelligence-data-hub/exports/` — no API calls, no re-ingestion. Hub runs its own schedule independently.
- **investment-analyst-agents:** Optional future integration — briefings can be fed into topic scoring as an additional signal.

---

## Out of Scope (v1)

- Automated TikTok posting (requires TikTok Content Posting API — add in v2)
- Multi-platform support (Instagram Reels, YouTube Shorts)
- Team / collaboration features
- Paid tier / monetization tracking
