# Admin Panel + Analytical Intelligence — Design Spec
**Date:** 2026-05-21
**Status:** Approved
**Scope:** Two repos — Data Hub (admin panel) + WorldMap (display extension)

---

## Overview

Upgrade the World Intelligence platform from raw news display to structured geopolitical analysis. The Data Hub gains a local React admin panel where the user submits news manually, Claude AI drafts a multi-framework analytical breakdown, the user edits and approves it, then it is published to WorldMap's import contract. WorldMap displays the analysis on event cards when clicking event markers on the map.

---

## 1. Architecture

```
Data Hub
  ├── intelligence/human/           (already built)
  │     store.ts / extractor.ts / economist.ts
  └── admin/
        server.ts                   Express backend — Claude API proxy + file I/O
        client/                     Vite + React SPA (localhost:3001/admin)
          NewsFeed.tsx              paste news + pick source
          AnalysisDraft.tsx         review + edit AI-generated analysis
          CountryBrief.tsx          rolling country intelligence brief editor
          PublishButton.tsx         writes to store + triggers export

WorldMap
  └── public/data/imports/
        events.json                 extended with optional analysis{} per event
        intelligence-briefs.json   NEW — ISO3 → country rolling brief

  └── src/
        layers/intelligence/
          EventsLayer.tsx           existing — event click triggers card
        components/Panel/
          AnalysisCard.tsx          NEW — collapsible analysis section in event popup
        data/schemas/imports.ts     extended with AnalysisSchema + BriefSchema
```

**Data flow:**
1. User opens `localhost:3001/admin`
2. Pastes raw news → picks source platform → hits "Analyse"
3. Express calls Claude API → returns structured analytical draft
4. User reads each section, edits inline, approves
5. "Publish" → saves to `intelligence/human/store.json` → export runs automatically
6. WorldMap reads updated `events.json` + `intelligence-briefs.json`
7. Analysis appears on event cards when clicking markers on the map

**Constraint:** WorldMap frontend never calls external APIs. Analysis data enters only via the import contract files in `public/data/imports/`.

---

## 2. Analytical Framework

### Event-level analysis

Attached to each news event. Claude drafts all fields; user edits before publishing.

| Field | Description |
|-------|-------------|
| `what_happened` | Plain factual summary, 2–3 sentences |
| `historical_context` | Precedents, treaties, past conflicts, colonial roots that explain why this is happening |
| `political_analysis` | Power dynamics, state interests, alliance calculations, regime incentives — realism / liberal / constructivist lenses |
| `social_analysis` | Identity, grievances, public opinion, class dynamics, ethnic/religious fault lines, protest mobilization |
| `actor_goals` | Array of actors, each with: `name`, `stated_goal`, `real_goal`, `red_lines` |
| `bloc_perspectives` | Array of blocs (see below) |
| `what_to_watch` | 3–5 concrete, time-bound signals to monitor |
| `confidence` | 0–1 score + `reasoning` string (what is unknown or uncertain) |

### Bloc perspectives (per event)

Each entry in `bloc_perspectives`:

| Field | Description |
|-------|-------------|
| `bloc` | Named bloc: `"US-led West"`, `"Russia-China"`, `"EU"`, `"Japan-South Korea"`, `"ASEAN"`, `"Gulf States"`, `"Global South"`, or other |
| `how_they_see_it` | Their narrative and interpretation of this event |
| `their_interest` | What they gain, lose, or fear |
| `internal_tension` | Where members of this bloc disagree with each other on this issue |

### Country-level rolling brief

One brief per country, synthesized from all accumulated events. Updated by the user via the admin panel.

| Field | Description |
|-------|-------------|
| `situation_overview` | Current state in 2–3 sentences |
| `key_dynamics` | Ongoing structural patterns driving events |
| `historical_roots` | Deep history shaping the present (10–100 year timeframe) |
| `actor_map` | Who has power, who wants power, who is losing it |
| `alignment_map` | See below |
| `watchlist` | Top 3–5 signals for this country right now |
| `last_reviewed` | ISO date of last human review |

### Alignment map (per country brief)

| Field | Description |
|-------|-------------|
| `primary_alignment` | Which bloc this country sits in and how firmly |
| `secondary_ties` | Hedging relationships — who else they deal with |
| `internal_factions` | Domestic groups that pull toward different blocs |
| `fault_lines` | Where this country's alignment is contested or fragile |

---

## 3. Admin Panel UI

Single-page app at `localhost:3001/admin`. Three views.

### View 1 — Submit News

- Large text area: paste raw news article or summary
- Source selector: `web | TikTok | YouTube | podcast | other`
- Optional URL field
- Country tag field (ISO3 or plain name, resolved server-side)
- **"Analyse"** button → POST to `/api/analyse` → Claude API → returns draft
- Loading state during Claude call (~5–10 seconds)

### View 2 — Review & Edit Draft

Editable sections in order:

```
What happened         [editable textarea]
Historical context    [editable textarea]
Political analysis    [editable textarea]
Social analysis       [editable textarea]
Actor goals           [editable table: name | stated goal | real goal | red lines]
Bloc perspectives     [editable cards, one per bloc]
                        each card: how they see it | their interest | internal tension
What to watch         [editable ordered list, 3–5 items]
Confidence            [0–1 slider + editable reasoning text]
```

- Each section has a **"Regenerate"** button — re-calls Claude for that section only
- **"Publish"** button at bottom → POST to `/api/publish` → store + export
- On publish success: confirmation message + link to view in WorldMap

### View 3 — Country Briefs

- List of all countries that have accumulated analysed events
- Click country → see rolling brief (all fields editable inline)
- **"Refresh brief"** → Claude re-synthesizes from all events for that country
- **"Publish brief"** → writes to `intelligence-briefs.json`

---

## 4. WorldMap Display

### Event card extension

When a user clicks an event marker, the existing event popup gains a collapsible **"Intelligence Analysis"** section below the current header (title, date, severity, type).

Section layout:
- `what_happened` — plain text
- `historical_context` — plain text
- `political_analysis` — plain text
- `social_analysis` — plain text
- **Actor Goals** — table: actor | stated goal | real goal | red lines
- **Bloc Perspectives** — one card per bloc: how they see it | their interest | internal tension
- **What to Watch** — numbered list
- Confidence badge (e.g. `0.82 — reasoning`)

If an event has no `analysis` object (auto-ingested, not yet reviewed in admin panel) — the section is hidden entirely. No empty states.

### Import contract extension

`events.json` — each event gains an optional `analysis` field (Zod `.optional()` — additive, no breaking change):

```typescript
const EventAnalysisSchema = z.object({
  what_happened:      z.string(),
  historical_context: z.string(),
  political_analysis: z.string(),
  social_analysis:    z.string(),
  actor_goals: z.array(z.object({
    name:        z.string(),
    stated_goal: z.string(),
    real_goal:   z.string(),
    red_lines:   z.string(),
  })),
  bloc_perspectives: z.array(z.object({
    bloc:             z.string(),
    how_they_see_it:  z.string(),
    their_interest:   z.string(),
    internal_tension: z.string(),
  })),
  what_to_watch: z.array(z.string()),
  confidence: z.object({
    score:     z.number().min(0).max(1),
    reasoning: z.string(),
  }),
});
```

`intelligence-briefs.json` — new file, map of ISO3 → brief:

```typescript
const CountryBriefSchema = z.object({
  iso3:                z.string(),
  situation_overview:  z.string(),
  key_dynamics:        z.string(),
  historical_roots:    z.string(),
  actor_map:           z.string(),
  alignment_map: z.object({
    primary_alignment:  z.string(),
    secondary_ties:     z.string(),
    internal_factions:  z.string(),
    fault_lines:        z.string(),
  }),
  watchlist:     z.array(z.string()),
  last_reviewed: z.string(),
});

const IntelligenceBriefSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  generatedAt:   z.string(),
  briefs:        z.array(CountryBriefSchema),
});
```

---

## 5. New Files

### Data Hub

| Path | Purpose |
|------|---------|
| `admin/server.ts` | Express backend: `/api/analyse`, `/api/publish`, `/api/brief/refresh`, `/api/brief/publish`, static serving |
| `admin/client/` | Vite + React SPA |
| `admin/client/NewsFeed.tsx` | News submission form |
| `admin/client/AnalysisDraft.tsx` | Review and edit draft |
| `admin/client/CountryBrief.tsx` | Country brief editor |
| `admin/client/PublishButton.tsx` | Publish action |
| `admin/vite.config.ts` | Vite config for client build |
| `intelligence/human/analyser.ts` | Claude API call: full analytical framework prompt (separate from extractor — extractor handles basic facts, analyser handles political/social/historical depth) |
| `intelligence/human/brief-synthesizer.ts` | Claude API call: synthesize country brief from all accumulated events for a country |

### Modified — Data Hub

| Path | Change |
|------|--------|
| `intelligence/exports/run-exports.ts` | Attach `analysis` field to exported events; write `intelligence-briefs.json` |
| `package.json` | Add `"admin": "tsx admin/server.ts"` script |

### WorldMap

| Path | Purpose |
|------|---------|
| `src/components/Panel/AnalysisCard.tsx` | Collapsible analysis section for event popup |
| `public/data/imports/intelligence-briefs.example.json` | Example file for local dev fallback |

### Modified — WorldMap

| Path | Change |
|------|--------|
| `src/data/schemas/imports.ts` | Add `EventAnalysisSchema` + `IntelligenceBriefSchema` |
| `src/lib/adapters/imports.ts` | Fetch + validate `intelligence-briefs.json` |
| `src/store/useIntelligenceStore.ts` | Store briefs in state |

---

## 6. What This Is NOT

- No breaking schema changes — `analysis` is optional on each event
- No external API calls from WorldMap frontend
- No investment reasoning inside WorldMap
- The admin panel is local-only — not deployed to GitHub Pages
- Country briefs are display-only in WorldMap — editing happens only in the admin panel
