# Admin Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local React admin panel to the Data Hub that accepts manually submitted news, generates AI-powered geopolitical analysis (political science / social science / history frameworks), lets the user edit the draft, and publishes it to WorldMap's import contract files.

**Architecture:** Express backend on port 3001 handles Claude API calls and file I/O. Vite+React SPA (served from `admin/dist/` in production; from port 5174 in dev with proxy to Express) provides the editing UI. Shared types live in `admin/types.ts` — no Node.js imports, safe for both server and browser. Three new modules in `intelligence/human/`: `analysis-store.ts` (CRUD), `analyser.ts` (Claude deep analysis), `brief-synthesizer.ts` (Claude country brief). The export runner is extended to write `intelligence-briefs.json` and include human intel events with analysis in the v2 events file.

**Tech Stack:** TypeScript/ESM, tsx, Express 4, React 19, Vite 6, @anthropic-ai/sdk (already installed), existing lib/paths.ts / lib/logger.ts patterns.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `package.json` | Add express, react, react-dom deps; vite, @vitejs/plugin-react, @types/* devDeps; add admin scripts |
| Modify | `lib/paths.ts` | Add `intelligence.human.analysisStore`, `intelligence.human.briefs`, `admin.root`, `admin.dist` |
| Create | `admin/types.ts` | Shared types: HumanIntelRecord, EventAnalysis, CountryBrief, ActorGoal, BlocPerspective, AlignmentMap |
| Create | `intelligence/human/analysis-store.ts` | CRUD for EventAnalysis[] and CountryBrief[] stored as JSON |
| Create | `intelligence/human/analyser.ts` | Claude API: deep geopolitical analysis using polisci/social science/history frameworks |
| Create | `intelligence/human/brief-synthesizer.ts` | Claude API: synthesize rolling country brief from accumulated events |
| Create | `admin/server.ts` | Express backend: /api/analyse, /api/publish, /api/brief/refresh, /api/brief/publish, /api/briefs, /api/records, static serving |
| Create | `admin/vite.config.ts` | Vite config: root=admin/client, outDir=admin/dist, proxy /api → port 3001 |
| Create | `admin/client/index.html` | HTML shell |
| Create | `admin/client/tsconfig.json` | Browser-targeting tsconfig for the React client |
| Create | `admin/client/styles.css` | Dark Bloomberg-style stylesheet |
| Create | `admin/client/main.tsx` | React root mount |
| Create | `admin/client/App.tsx` | Tab nav + shared state (pendingRecord, pendingAnalysis) |
| Create | `admin/client/Submit.tsx` | View 1: news submission form |
| Create | `admin/client/Draft.tsx` | View 2: editable analysis draft with per-section regen |
| Create | `admin/client/Briefs.tsx` | View 3: country brief synthesiser and editor |
| Modify | `intelligence/exports/worldmap-v2-exporter.ts` | Extend V2ImportedEvent with coordinateQuality + optional analysis; add buildV2HumanEventEntry() |
| Modify | `intelligence/exports/run-exports.ts` | Load analyses + briefs; merge human events into v2 file; write intelligence-briefs.json |

---

## Task 1: Install dependencies and add npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-
npm install express react react-dom
```

Expected: `express`, `react`, `react-dom` appear in `dependencies` in package.json.

- [ ] **Step 2: Install dev dependencies**

```bash
npm install --save-dev vite @vitejs/plugin-react @types/express @types/react @types/react-dom
```

Expected: all packages appear in `devDependencies`.

- [ ] **Step 3: Add admin scripts to package.json**

Open `package.json`. Inside `"scripts"`, add after `"human-intel"`:

```json
    "admin:api": "tsx admin/server.ts",
    "admin:build": "vite build --config admin/vite.config.ts",
    "admin:client": "vite --config admin/vite.config.ts",
    "admin": "npm run admin:build && npm run admin:api"
```

- [ ] **Step 4: Verify packages installed**

```bash
npx tsx --no-warnings -e "import express from 'express'; console.log('express OK')"
```

Expected: `express OK`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add express, react, vite deps for admin panel"
```

---

## Task 2: Add admin and analysis paths to lib/paths.ts

**Files:**
- Modify: `lib/paths.ts`

- [ ] **Step 1: Extend the intelligence.human block and add admin block**

Open `lib/paths.ts`. Replace the existing `human:` block and closing `},` of `intelligence:` with:

```typescript
    human: {
      root:          join(ROOT, 'intelligence', 'human'),
      store:         join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox:         join(ROOT, 'intelligence', 'human', 'inbox.md'),
      analysisStore: join(ROOT, 'intelligence', 'human', 'analysis-store.json'),
      briefs:        join(ROOT, 'intelligence', 'human', 'briefs.json'),
    },
  },

  admin: {
    root: join(ROOT, 'admin'),
    dist: join(ROOT, 'admin', 'dist'),
  },
```

The full file after edit ends with:

```typescript
  intelligence: {
    root:             join(ROOT, 'intelligence'),
    sources:          join(ROOT, 'intelligence', 'sources'),
    sourceHealth:     join(ROOT, 'intelligence', 'sources', 'source-health.json'),
    fingerprintIndex: join(ROOT, 'intelligence', 'sources', 'fingerprint-index.json'),
    rawArticles:      join(ROOT, 'intelligence', 'raw', 'articles'),
    outputArticles:   join(ROOT, 'intelligence', 'outputs', 'articles'),
    outputEvents:     join(ROOT, 'intelligence', 'outputs', 'events'),
    articleEventMap:  join(ROOT, 'intelligence', 'outputs', 'events', 'article-event-map.json'),
    metrics:          join(ROOT, 'intelligence', 'metrics'),
    outputs:          join(ROOT, 'intelligence', 'outputs'),
    memory:           join(ROOT, 'intelligence', 'memory'),
    human: {
      root:          join(ROOT, 'intelligence', 'human'),
      store:         join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox:         join(ROOT, 'intelligence', 'human', 'inbox.md'),
      analysisStore: join(ROOT, 'intelligence', 'human', 'analysis-store.json'),
      briefs:        join(ROOT, 'intelligence', 'human', 'briefs.json'),
    },
  },

  admin: {
    root: join(ROOT, 'admin'),
    dist: join(ROOT, 'admin', 'dist'),
  },
} as const;
```

- [ ] **Step 2: Verify**

```bash
npx tsx --no-warnings -e "import { PATHS } from './lib/paths.ts'; console.log(PATHS.intelligence.human.analysisStore); console.log(PATHS.admin.dist)"
```

Expected: prints both paths without error.

- [ ] **Step 3: Commit**

```bash
git add lib/paths.ts
git commit -m "feat: add admin and analysis paths to PATHS constant"
```

---

## Task 3: Create shared types (admin/types.ts)

**Files:**
- Create: `admin/types.ts`

- [ ] **Step 1: Create admin/ directory and types file**

```bash
mkdir -p /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-/admin
```

Create `admin/types.ts`:

```typescript
// Shared types between Express server and React client.
// No Node.js imports — safe in both server and browser contexts.

export type SourcePlatform = 'tiktok' | 'youtube' | 'podcast' | 'web' | 'other';
export type SourceTopic    = 'geopolitical' | 'economic' | 'technology' | 'social' | 'energy' | 'other';
export type SourceTier     = 'unverified' | 'social' | 'news' | 'primary';

export interface AdminHumanIntelRecord {
  id:              string;
  submitted_at:    string;
  source_platform: SourcePlatform;
  source_url?:     string;
  raw_text:        string;
  extracted: {
    title:      string;
    topic:      SourceTopic;
    countries:  string[];
    actors:     string[];
    event_type: string | null;
    confidence: number;
    tags:       string[];
  };
  credibility: {
    source_tier:      SourceTier;
    bias_flags:       string[];
    cross_references: string[];
    assessment:       string;
  };
  follow_up_requests:       string[];
  economist_quick_analysis: string;
  exported:                 boolean;
}

export interface ActorGoal {
  name:        string;
  stated_goal: string;
  real_goal:   string;
  red_lines:   string;
}

export interface BlocPerspective {
  bloc:             string;
  how_they_see_it:  string;
  their_interest:   string;
  internal_tension: string;
}

export interface EventAnalysis {
  event_id:           string;
  what_happened:      string;
  historical_context: string;
  political_analysis: string;
  social_analysis:    string;
  actor_goals:        ActorGoal[];
  bloc_perspectives:  BlocPerspective[];
  what_to_watch:      string[];
  confidence: {
    score:     number;
    reasoning: string;
  };
  created_at:  string;
  last_edited: string;
  reviewed:    boolean;
}

export interface AlignmentMap {
  primary_alignment:  string;
  secondary_ties:     string;
  internal_factions:  string;
  fault_lines:        string;
}

export interface CountryBrief {
  iso3:               string;
  situation_overview: string;
  key_dynamics:       string;
  historical_roots:   string;
  actor_map:          string;
  alignment_map:      AlignmentMap;
  watchlist:          string[];
  last_reviewed:      string;
  last_synthesized:   string;
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsx --no-warnings -e "import type { EventAnalysis } from './admin/types.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add admin/types.ts
git commit -m "feat: add shared admin types (EventAnalysis, CountryBrief, BlocPerspective)"
```

---

## Task 4: Create analysis-store.ts (CRUD for analyses and briefs)

**Files:**
- Create: `intelligence/human/analysis-store.ts`

- [ ] **Step 1: Create the file**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { PATHS } from '../../lib/paths.ts';
import type { EventAnalysis, CountryBrief } from '../../admin/types.ts';

// ── Analysis store (event_id → EventAnalysis) ─────────────────────────────────

export function loadAnalysisStore(): EventAnalysis[] {
  if (!existsSync(PATHS.intelligence.human.analysisStore)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.analysisStore, 'utf-8')) as EventAnalysis[];
  } catch {
    return [];
  }
}

function saveAnalysisStore(analyses: EventAnalysis[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.analysisStore, JSON.stringify(analyses, null, 2));
}

export function getAnalysisById(eventId: string): EventAnalysis | undefined {
  return loadAnalysisStore().find(a => a.event_id === eventId);
}

export function upsertAnalysis(analysis: EventAnalysis): void {
  const store = loadAnalysisStore();
  const idx = store.findIndex(a => a.event_id === analysis.event_id);
  if (idx >= 0) {
    store[idx] = analysis;
  } else {
    store.push(analysis);
  }
  saveAnalysisStore(store);
}

// ── Briefs store (iso3 → CountryBrief) ───────────────────────────────────────

export function loadBriefs(): CountryBrief[] {
  if (!existsSync(PATHS.intelligence.human.briefs)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.briefs, 'utf-8')) as CountryBrief[];
  } catch {
    return [];
  }
}

function saveBriefs(briefs: CountryBrief[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.briefs, JSON.stringify(briefs, null, 2));
}

export function getBriefByIso3(iso3: string): CountryBrief | undefined {
  return loadBriefs().find(b => b.iso3 === iso3);
}

export function upsertBrief(brief: CountryBrief): void {
  const briefs = loadBriefs();
  const idx = briefs.findIndex(b => b.iso3 === brief.iso3);
  if (idx >= 0) {
    briefs[idx] = brief;
  } else {
    briefs.push(brief);
  }
  saveBriefs(briefs);
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsx --no-warnings -e "import { loadAnalysisStore, loadBriefs } from './intelligence/human/analysis-store.ts'; console.log(loadAnalysisStore().length, loadBriefs().length)"
```

Expected: `0 0`

- [ ] **Step 3: Commit**

```bash
git add intelligence/human/analysis-store.ts
git commit -m "feat: add analysis-store CRUD for EventAnalysis and CountryBrief"
```

---

## Task 5: Build analyser.ts (Claude deep geopolitical analysis)

**Files:**
- Create: `intelligence/human/analyser.ts`

- [ ] **Step 1: Create the file**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }  from 'path';
import { PATHS } from '../../lib/paths.ts';
import type { HumanIntelRecord } from './store.ts';
import type { EventAnalysis, ActorGoal, BlocPerspective } from '../../admin/types.ts';

const client = new Anthropic();

function loadExportContext(): string {
  const wiPath = join(PATHS.exports.worldMap, 'intelligence.json');
  if (!existsSync(wiPath)) return 'No existing intelligence data.';
  try {
    const wi = JSON.parse(readFileSync(wiPath, 'utf-8')) as Record<string, unknown>;
    const storylines = ((wi['storylines'] as Array<Record<string, unknown>>) ?? [])
      .slice(0, 8)
      .map(s => `  [${s['storylineId']}] "${s['title']}" — ${s['storylineState']}`)
      .join('\n');
    return `Active storylines:\n${storylines || '  (none)'}`;
  } catch {
    return 'Export context unavailable.';
  }
}

const SYSTEM_PROMPT = `You are a senior geopolitical analyst with expertise in:
- Political science: realism, liberalism, constructivism, power transition theory, democratic peace theory
- Social science: social movement theory, identity politics, ethnic conflict, collective action problems
- Historical analysis: path dependency, imperial legacies, post-colonial dynamics, long-run institutional change

Produce a structured deep analysis of the submitted intelligence event.
Respond ONLY with valid JSON. No markdown fences. No text outside the JSON object.

JSON schema (follow exactly):
{
  "what_happened": "2-3 sentence factual summary — who did what, where, when",
  "historical_context": "Specific historical roots: name treaties, conflicts, empires, turning points that explain why this is happening now. Go back 10-100 years.",
  "political_analysis": "Power dynamics: which actors gain or lose power, what regime interests are served, how alliance structures are implicated. Apply at least two of: realist (power/security), liberal (institutions/trade), constructivist (identity/norms) lenses.",
  "social_analysis": "Social forces: identity dynamics, popular grievances, class interests, ethnic/religious fault lines, mobilization patterns and their structural roots.",
  "actor_goals": [
    {
      "name": "actor or state name",
      "stated_goal": "what they publicly say they want",
      "real_goal": "what their behavior and incentives reveal they actually want",
      "red_lines": "what they will not accept — their escalation triggers"
    }
  ],
  "bloc_perspectives": [
    {
      "bloc": "bloc name",
      "how_they_see_it": "their narrative and interpretation of this event",
      "their_interest": "what they gain, lose, or fear from this development",
      "internal_tension": "where members of this bloc disagree on this issue"
    }
  ],
  "what_to_watch": [
    "specific, concrete signal — include timeframe when possible"
  ],
  "confidence": {
    "score": 0.0,
    "reasoning": "what is unknown or uncertain that limits this analysis"
  }
}

For bloc_perspectives, always consider these blocs and include all that are materially affected:
- US-led West (NATO / Five Eyes)
- Russia-China axis
- EU (when position differs from US-led West)
- Japan-South Korea
- ASEAN
- Gulf States
- Global South / Non-Aligned

Minimum 3 blocs. Omit blocs not meaningfully affected.

For what_to_watch — be specific and time-bound:
BAD: "Watch the situation" 
GOOD: "Whether Saudi Arabia calls an emergency OPEC meeting within 48 hours of the Iranian announcement"

Confidence scoring:
0.9+ = well-documented, multiple corroborating sources, clear actor incentives
0.7-0.9 = solid evidence, some uncertainty about intentions or timing
0.5-0.7 = plausible but limited evidence, significant uncertainty
< 0.5 = speculative — include only with explicit reasoning`;

type ParsedAnalysis = {
  what_happened:      string;
  historical_context: string;
  political_analysis: string;
  social_analysis:    string;
  actor_goals:        ActorGoal[];
  bloc_perspectives:  BlocPerspective[];
  what_to_watch:      string[];
  confidence:         { score: number; reasoning: string };
};

export async function analyseEvent(record: HumanIntelRecord): Promise<EventAnalysis> {
  const context = loadExportContext();
  const now = new Date().toISOString();

  const userMessage = [
    `Source: ${record.source_platform}`,
    record.source_url ? `URL: ${record.source_url}` : null,
    `Countries: ${record.extracted.countries.join(', ')}`,
    `Topic: ${record.extracted.topic}`,
    `Initial extraction: ${record.extracted.title}`,
    '',
    'Raw submitted text:',
    '---',
    record.raw_text,
    '---',
    '',
    'Current intelligence context for cross-referencing:',
    context,
  ].filter((l): l is string => l !== null).join('\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');
  const parsed = JSON.parse(block.text) as ParsedAnalysis;

  return {
    event_id:           record.id,
    what_happened:      parsed.what_happened,
    historical_context: parsed.historical_context,
    political_analysis: parsed.political_analysis,
    social_analysis:    parsed.social_analysis,
    actor_goals:        parsed.actor_goals,
    bloc_perspectives:  parsed.bloc_perspectives,
    what_to_watch:      parsed.what_to_watch,
    confidence:         parsed.confidence,
    created_at:         now,
    last_edited:        now,
    reviewed:           false,
  };
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsx --no-warnings -e "import './intelligence/human/analyser.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add intelligence/human/analyser.ts
git commit -m "feat: add Claude analyser with political science / social science / history framework"
```

---

## Task 6: Build brief-synthesizer.ts (Claude country brief)

**Files:**
- Create: `intelligence/human/brief-synthesizer.ts`

- [ ] **Step 1: Create the file**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { loadHumanStore } from './store.ts';
import { loadAnalysisStore } from './analysis-store.ts';
import type { CountryBrief, AlignmentMap } from '../../admin/types.ts';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a senior geopolitical analyst writing a country intelligence brief.

Given recent intelligence events for a country, synthesize a concise rolling brief.
Respond ONLY with valid JSON. No markdown fences. No text outside the JSON object.

JSON schema (follow exactly):
{
  "situation_overview": "Current state in 2-3 sentences — what is happening right now",
  "key_dynamics": "The structural patterns driving events — the underlying logic, not just events themselves",
  "historical_roots": "Deep history shaping the present. Name specific empires, treaties, conflicts, leaders, turning points over 10-100 years.",
  "actor_map": "Who holds power (government, military, economic elites, civil society, opposition). Who is rising? Who is falling? Key intra-elite conflicts.",
  "alignment_map": {
    "primary_alignment": "which geopolitical bloc this country sits in and how firmly committed",
    "secondary_ties": "hedging relationships — other blocs or patrons maintained and why",
    "internal_factions": "domestic political groups that pull toward different external patrons",
    "fault_lines": "where alignment is contested, fragile, or actively shifting"
  },
  "watchlist": [
    "specific signal 1 to monitor",
    "specific signal 2 to monitor",
    "specific signal 3 to monitor"
  ]
}`;

type ParsedBrief = {
  situation_overview: string;
  key_dynamics:       string;
  historical_roots:   string;
  actor_map:          string;
  alignment_map:      AlignmentMap;
  watchlist:          string[];
};

export async function synthesiseBrief(iso3: string): Promise<CountryBrief> {
  const allRecords  = loadHumanStore();
  const allAnalyses = loadAnalysisStore();
  const analysisMap = new Map(allAnalyses.map(a => [a.event_id, a]));

  const countryRecords = allRecords.filter(r =>
    r.extracted.countries.includes(iso3)
  );

  if (countryRecords.length === 0) {
    throw new Error(`No intel records found for ${iso3} — submit some news events first`);
  }

  const eventSummaries = countryRecords.map(r => {
    const analysis = analysisMap.get(r.id);
    return [
      `Event: ${r.extracted.title}`,
      `Date: ${r.submitted_at.slice(0, 10)}`,
      `Topic: ${r.extracted.topic}`,
      analysis
        ? `Analysis: ${analysis.what_happened}`
        : `Raw: ${r.raw_text.slice(0, 200)}`,
    ].join('\n');
  }).join('\n\n---\n\n');

  const now = new Date().toISOString();

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: `Country ISO3: ${iso3}\nEvents to synthesize: ${countryRecords.length}\n\n${eventSummaries}`,
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');
  const parsed = JSON.parse(block.text) as ParsedBrief;

  return {
    iso3,
    situation_overview: parsed.situation_overview,
    key_dynamics:       parsed.key_dynamics,
    historical_roots:   parsed.historical_roots,
    actor_map:          parsed.actor_map,
    alignment_map:      parsed.alignment_map,
    watchlist:          parsed.watchlist,
    last_reviewed:      now.slice(0, 10),
    last_synthesized:   now,
  };
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsx --no-warnings -e "import './intelligence/human/brief-synthesizer.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add intelligence/human/brief-synthesizer.ts
git commit -m "feat: add brief-synthesizer (Claude country rolling brief)"
```

---

## Task 7: Build admin/server.ts (Express backend)

**Files:**
- Create: `admin/server.ts`

- [ ] **Step 1: Create the file**

```typescript
import express, { type Request, type Response } from 'express';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import { existsSync }     from 'fs';
import { extractHumanIntel }   from '../intelligence/human/extractor.ts';
import { analyseEvent }        from '../intelligence/human/analyser.ts';
import { synthesiseBrief }     from '../intelligence/human/brief-synthesizer.ts';
import { appendHumanRecord, loadHumanStore } from '../intelligence/human/store.ts';
import {
  loadAnalysisStore,
  upsertAnalysis,
  loadBriefs,
  upsertBrief,
} from '../intelligence/human/analysis-store.ts';
import { runExports }  from '../intelligence/exports/run-exports.ts';
import type { EventAnalysis, CountryBrief, AdminHumanIntelRecord } from './types.ts';
import type { HumanIntelRecord } from '../intelligence/human/store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' }));

// ── API ───────────────────────────────────────────────────────────────────────

app.post('/api/analyse', async (req: Request, res: Response) => {
  try {
    const { rawText, sourcePlatform, sourceUrl } = req.body as {
      rawText:        string;
      sourcePlatform: HumanIntelRecord['source_platform'];
      sourceUrl?:     string;
    };
    if (!rawText?.trim() || !sourcePlatform) {
      res.status(400).json({ error: 'rawText and sourcePlatform are required' });
      return;
    }
    const record   = await extractHumanIntel({ rawText, sourcePlatform, sourceUrl });
    const analysis = await analyseEvent(record);
    res.json({ record, analysis });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/publish', async (req: Request, res: Response) => {
  try {
    const { record, analysis } = req.body as {
      record:   AdminHumanIntelRecord;
      analysis: EventAnalysis;
    };
    appendHumanRecord(record as unknown as HumanIntelRecord);
    upsertAnalysis(analysis);
    const today = new Date().toISOString().slice(0, 10);
    try { runExports(today); } catch { /* non-fatal — export may fail if no pipeline events */ }
    res.json({ success: true, id: record.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/brief/refresh', async (req: Request, res: Response) => {
  try {
    const { iso3 } = req.body as { iso3: string };
    if (!iso3?.trim()) { res.status(400).json({ error: 'iso3 is required' }); return; }
    const brief = await synthesiseBrief(iso3.trim().toUpperCase());
    res.json({ brief });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/brief/publish', async (req: Request, res: Response) => {
  try {
    const { brief } = req.body as { brief: CountryBrief };
    upsertBrief(brief);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/briefs', (_req: Request, res: Response) => {
  res.json({ briefs: loadBriefs() });
});

app.get('/api/records', (_req: Request, res: Response) => {
  const records  = loadHumanStore();
  const analyses = loadAnalysisStore();
  const aMap     = new Map(analyses.map(a => [a.event_id, a]));
  res.json({ records: records.map(r => ({ ...r, analysis: aMap.get(r.id) })) });
});

// ── Static (production build) ─────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(join(distPath, 'index.html'));
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.send(
      '<body style="background:#0a0c10;color:#c9d1d9;font-family:monospace;padding:2rem">' +
      '<p>Build the client first:</p><code>npm run admin:build</code><br><br>' +
      '<p>Or run dev mode in two terminals:</p>' +
      '<code>npm run admin:api</code> (this server)<br>' +
      '<code>npm run admin:client</code> (Vite dev server on :5174)</p></body>'
    );
  });
}

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\nAdmin panel → http://localhost:${PORT}`);
  console.log('API ready. Run `npm run admin:build` to serve the UI, or open :5174 in dev mode.\n');
});
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsx --no-warnings -e "import './admin/server.ts'" 2>&1 | head -5
```

Expected: server starts and prints the port message. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add admin/server.ts
git commit -m "feat: add Express admin API server"
```

---

## Task 8: Scaffold React client

**Files:**
- Create: `admin/vite.config.ts`
- Create: `admin/client/index.html`
- Create: `admin/client/tsconfig.json`
- Create: `admin/client/styles.css`
- Create: `admin/client/main.tsx`
- Create: `admin/client/App.tsx`

- [ ] **Step 1: Create admin/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root:    join(__dirname, 'client'),
  build: {
    outDir:     join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
```

- [ ] **Step 2: Create admin/client/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>World Intelligence — Admin</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 3: Create admin/client/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["."]
}
```

- [ ] **Step 4: Create admin/client/styles.css**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0a0c10; color: #c9d1d9; min-height: 100vh; }
.app { display: flex; flex-direction: column; min-height: 100vh; }
.nav { display: flex; gap: 1px; background: #161b22; border-bottom: 1px solid #21262d; padding: 0 1.5rem; }
.nav button { padding: 0.75rem 1.25rem; background: none; border: none; color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.875rem; }
.nav button.active { color: #58a6ff; border-bottom-color: #58a6ff; }
.nav button:hover:not(.active):not(:disabled) { color: #c9d1d9; }
.nav button:disabled { opacity: 0.35; cursor: not-allowed; }
.main { padding: 1.5rem; max-width: 960px; margin: 0 auto; width: 100%; }
.card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 1.25rem; margin-bottom: 1rem; }
.field { margin-bottom: 1rem; }
label { display: block; font-size: 0.75rem; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem; }
textarea, input[type=text], input[type=number], select { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-family: inherit; resize: vertical; }
textarea:focus, input:focus, select:focus { outline: none; border-color: #58a6ff; }
.btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1.25rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.875rem; font-weight: 600; transition: background 0.1s; }
.btn-primary { background: #238636; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #2ea043; }
.btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
.btn-secondary:hover:not(:disabled) { background: #30363d; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.error   { color: #f85149; font-size: 0.875rem; margin-top: 0.5rem; }
.success { color: #3fb950; font-size: 0.875rem; margin-top: 0.5rem; }
.loading { color: #8b949e; font-style: italic; font-size: 0.875rem; }
.section-title { font-size: 0.8rem; font-weight: 700; color: #58a6ff; text-transform: uppercase; letter-spacing: 0.06em; }
table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
th { text-align: left; color: #8b949e; font-weight: 600; padding: 0.4rem 0.5rem; border-bottom: 1px solid #21262d; }
td { padding: 0.35rem 0.4rem; vertical-align: top; }
td textarea, td input { width: 100%; min-width: 80px; }
.bloc-card { background: #0d1117; border: 1px solid #21262d; border-radius: 4px; padding: 1rem; margin-bottom: 0.75rem; }
.watch-item { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 0.5rem; }
.watch-item span { color: #8b949e; min-width: 1.5rem; font-size: 0.875rem; padding-top: 0.35rem; }
.watch-item input { flex: 1; }
```

- [ ] **Step 5: Create admin/client/main.tsx**

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 6: Create admin/client/App.tsx**

```tsx
import React, { useState } from 'react'
import Submit from './Submit'
import Draft  from './Draft'
import Briefs from './Briefs'
import type { EventAnalysis, AdminHumanIntelRecord } from '../types'

type View = 'submit' | 'draft' | 'briefs'

export default function App() {
  const [view,            setView]            = useState<View>('submit')
  const [pendingRecord,   setPendingRecord]   = useState<AdminHumanIntelRecord | null>(null)
  const [pendingAnalysis, setPendingAnalysis] = useState<EventAnalysis | null>(null)

  function handleAnalyseSuccess(record: AdminHumanIntelRecord, analysis: EventAnalysis) {
    setPendingRecord(record)
    setPendingAnalysis(analysis)
    setView('draft')
  }

  function handlePublishDone() {
    setPendingRecord(null)
    setPendingAnalysis(null)
    setView('submit')
  }

  return (
    <div className="app">
      <nav className="nav">
        <button className={view === 'submit' ? 'active' : ''} onClick={() => setView('submit')}>
          Submit News
        </button>
        <button
          className={view === 'draft' ? 'active' : ''}
          onClick={() => setView('draft')}
          disabled={!pendingRecord}
        >
          Review Draft
        </button>
        <button className={view === 'briefs' ? 'active' : ''} onClick={() => setView('briefs')}>
          Country Briefs
        </button>
      </nav>
      <main className="main">
        {view === 'submit' && <Submit onSuccess={handleAnalyseSuccess} />}
        {view === 'draft' && pendingRecord && pendingAnalysis && (
          <Draft
            initialRecord={pendingRecord}
            initialAnalysis={pendingAnalysis}
            onPublish={handlePublishDone}
          />
        )}
        {view === 'briefs' && <Briefs />}
      </main>
    </div>
  )
}
```

- [ ] **Step 7: Verify Vite can resolve the config**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-
npx vite --config admin/vite.config.ts --version 2>&1 | head -3
```

Expected: prints the Vite version without errors.

- [ ] **Step 8: Commit**

```bash
git add admin/vite.config.ts admin/client/
git commit -m "feat: scaffold React client (Vite, tsconfig, styles, App)"
```

---

## Task 9: Build Submit view

**Files:**
- Create: `admin/client/Submit.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState } from 'react'
import type { EventAnalysis, AdminHumanIntelRecord, SourcePlatform } from '../types'

interface Props {
  onSuccess: (record: AdminHumanIntelRecord, analysis: EventAnalysis) => void
}

export default function Submit({ onSuccess }: Props) {
  const [rawText,        setRawText]        = useState('')
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>('web')
  const [sourceUrl,      setSourceUrl]      = useState('')
  const [loading,        setLoading]        = useState(false)
  const [error,          setError]          = useState('')

  async function handleAnalyse() {
    if (!rawText.trim()) { setError('Paste some news content first'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/analyse', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rawText, sourcePlatform, sourceUrl: sourceUrl.trim() || undefined }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      const data = await res.json() as { record: AdminHumanIntelRecord; analysis: EventAnalysis }
      onSuccess(data.record, data.analysis)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>Submit Intelligence</h2>
      <div className="card">
        <div className="field">
          <label>Source Platform</label>
          <select value={sourcePlatform} onChange={e => setSourcePlatform(e.target.value as SourcePlatform)}>
            <option value="web">Web / News Article</option>
            <option value="youtube">YouTube</option>
            <option value="tiktok">TikTok</option>
            <option value="podcast">Podcast</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label>Source URL (optional)</label>
          <input type="text" placeholder="https://..." value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>News Content — paste article, transcript, or write your summary</label>
          <textarea
            rows={14}
            placeholder="Paste a news article, video transcript, or write your own summary of what you observed..."
            value={rawText}
            onChange={e => setRawText(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" onClick={handleAnalyse} disabled={loading || !rawText.trim()}>
          {loading ? '⟳ Analysing...' : '→ Analyse'}
        </button>
        {loading && (
          <p className="loading" style={{ marginTop: '0.75rem' }}>
            Claude is running geopolitical analysis... (~15–30 seconds)
          </p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript is happy (no browser needed)**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-/admin/client
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (or only errors from files not yet created — Submit.tsx itself should be clean).

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-
git add admin/client/Submit.tsx
git commit -m "feat: add Submit view (news input form)"
```

---

## Task 10: Build Draft view (analysis editor)

**Files:**
- Create: `admin/client/Draft.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState } from 'react'
import type { EventAnalysis, AdminHumanIntelRecord, ActorGoal, BlocPerspective } from '../types'

interface Props {
  initialRecord:   AdminHumanIntelRecord
  initialAnalysis: EventAnalysis
  onPublish:       () => void
}

export default function Draft({ initialRecord, initialAnalysis, onPublish }: Props) {
  const [analysis, setAnalysis] = useState<EventAnalysis>(initialAnalysis)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState('')

  function upd<K extends keyof EventAnalysis>(key: K, value: EventAnalysis[K]) {
    setAnalysis(prev => ({ ...prev, [key]: value, last_edited: new Date().toISOString() }))
  }

  function updActor(i: number, f: keyof ActorGoal, v: string) {
    const g = [...analysis.actor_goals]; g[i] = { ...g[i], [f]: v }; upd('actor_goals', g)
  }
  function addActor()       { upd('actor_goals', [...analysis.actor_goals, { name: '', stated_goal: '', real_goal: '', red_lines: '' }]) }
  function removeActor(i: number) { upd('actor_goals', analysis.actor_goals.filter((_, j) => j !== i)) }

  function updBloc(i: number, f: keyof BlocPerspective, v: string) {
    const b = [...analysis.bloc_perspectives]; b[i] = { ...b[i], [f]: v }; upd('bloc_perspectives', b)
  }
  function addBloc()       { upd('bloc_perspectives', [...analysis.bloc_perspectives, { bloc: '', how_they_see_it: '', their_interest: '', internal_tension: '' }]) }
  function removeBloc(i: number) { upd('bloc_perspectives', analysis.bloc_perspectives.filter((_, j) => j !== i)) }

  function updWatch(i: number, v: string) {
    const w = [...analysis.what_to_watch]; w[i] = v; upd('what_to_watch', w)
  }
  function addWatch()        { upd('what_to_watch', [...analysis.what_to_watch, '']) }
  function removeWatch(i: number) { upd('what_to_watch', analysis.what_to_watch.filter((_, j) => j !== i)) }

  async function regen(field: string) {
    try {
      const res = await fetch('/api/analyse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: initialRecord.raw_text, sourcePlatform: initialRecord.source_platform, sourceUrl: initialRecord.source_url }),
      })
      if (!res.ok) return
      const data = await res.json() as { analysis: EventAnalysis }
      if (field in data.analysis) upd(field as keyof EventAnalysis, data.analysis[field as keyof EventAnalysis])
    } catch { /* silent fail */ }
  }

  async function handlePublish() {
    setLoading(true); setError('')
    try {
      const final = { ...analysis, reviewed: true, last_edited: new Date().toISOString() }
      const res = await fetch('/api/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: initialRecord, analysis: final }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      setSuccess('Published and exported to WorldMap.')
      setTimeout(onPublish, 1500)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const regenBtn = (field: string) => (
    <button className="btn btn-secondary" style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }} onClick={() => regen(field)}>↺</button>
  )

  const textSection = (title: string, field: keyof EventAnalysis, rows: number) => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span className="section-title">{title}</span>
        {regenBtn(field as string)}
      </div>
      <textarea rows={rows} value={analysis[field] as string} onChange={e => upd(field, e.target.value)} />
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h2 className="section-title">{initialRecord.extracted.title}</h2>
          <p style={{ color: '#8b949e', fontSize: '0.8rem', marginTop: '0.3rem' }}>
            {initialRecord.extracted.countries.join(', ')} · {initialRecord.source_platform}
          </p>
        </div>
        <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
          {loading ? '⟳ Publishing...' : '↑ Publish to WorldMap'}
        </button>
      </div>
      {error   && <p className="error"   style={{ marginBottom: '1rem' }}>{error}</p>}
      {success && <p className="success" style={{ marginBottom: '1rem' }}>{success}</p>}

      {textSection('What Happened',       'what_happened',      3)}
      {textSection('Historical Context',  'historical_context', 5)}
      {textSection('Political Analysis',  'political_analysis', 5)}
      {textSection('Social Analysis',     'social_analysis',    5)}

      {/* Actor Goals */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">Actor Goals</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addActor}>+ Actor</button>
        </div>
        <table>
          <thead><tr><th>Actor</th><th>Stated Goal</th><th>Real Goal</th><th>Red Lines</th><th></th></tr></thead>
          <tbody>
            {analysis.actor_goals.map((g, i) => (
              <tr key={i}>
                <td><input type="text" value={g.name}        onChange={e => updActor(i, 'name',        e.target.value)} placeholder="Name" /></td>
                <td><textarea rows={2} value={g.stated_goal} onChange={e => updActor(i, 'stated_goal', e.target.value)} /></td>
                <td><textarea rows={2} value={g.real_goal}   onChange={e => updActor(i, 'real_goal',   e.target.value)} /></td>
                <td><textarea rows={2} value={g.red_lines}   onChange={e => updActor(i, 'red_lines',   e.target.value)} /></td>
                <td><button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeActor(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bloc Perspectives */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">Bloc Perspectives</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addBloc}>+ Bloc</button>
        </div>
        {analysis.bloc_perspectives.map((b, i) => (
          <div key={i} className="bloc-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <input
                type="text" value={b.bloc}
                onChange={e => updBloc(i, 'bloc', e.target.value)}
                placeholder="Bloc name (e.g. US-led West)"
                style={{ fontWeight: 700, color: '#e3b341', background: 'none', border: 'none', borderBottom: '1px solid #30363d', borderRadius: 0, padding: '0 0 0.2rem 0', fontSize: '0.875rem', width: 'auto' }}
              />
              <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeBloc(i)}>✕</button>
            </div>
            {(['how_they_see_it', 'their_interest', 'internal_tension'] as const).map(f => (
              <div key={f} className="field" style={{ marginBottom: '0.5rem' }}>
                <label>{f.replace(/_/g, ' ')}</label>
                <textarea rows={2} value={b[f]} onChange={e => updBloc(i, f, e.target.value)} />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* What to Watch */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">What to Watch</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addWatch}>+ Signal</button>
        </div>
        {analysis.what_to_watch.map((item, i) => (
          <div key={i} className="watch-item">
            <span>{i + 1}.</span>
            <input type="text" value={item} onChange={e => updWatch(i, e.target.value)} placeholder="Specific signal to monitor..." />
            <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem', minWidth: 28 }} onClick={() => removeWatch(i)}>✕</button>
          </div>
        ))}
      </div>

      {/* Confidence */}
      <div className="card">
        <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Confidence</span>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div>
            <label>Score (0–1)</label>
            <input
              type="number" min={0} max={1} step={0.05}
              value={analysis.confidence.score}
              onChange={e => upd('confidence', { ...analysis.confidence, score: parseFloat(e.target.value) })}
              style={{ width: 80 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Reasoning — what is uncertain</label>
            <textarea rows={2} value={analysis.confidence.reasoning} onChange={e => upd('confidence', { ...analysis.confidence, reasoning: e.target.value })} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', paddingBottom: '2rem' }}>
        <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
          {loading ? '⟳ Publishing...' : '↑ Publish to WorldMap'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add admin/client/Draft.tsx
git commit -m "feat: add Draft view (editable analysis editor)"
```

---

## Task 11: Build Briefs view (country brief editor)

**Files:**
- Create: `admin/client/Briefs.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect } from 'react'
import type { CountryBrief } from '../types'

export default function Briefs() {
  const [briefs,    setBriefs]   = useState<CountryBrief[]>([])
  const [selected,  setSelected] = useState<CountryBrief | null>(null)
  const [iso3Input, setIso3]     = useState('')
  const [loading,   setLoading]  = useState(false)
  const [error,     setError]    = useState('')
  const [success,   setSuccess]  = useState('')

  useEffect(() => {
    fetch('/api/briefs')
      .then(r => r.json() as Promise<{ briefs: CountryBrief[] }>)
      .then(d => setBriefs(d.briefs))
      .catch(() => {})
  }, [])

  async function handleRefresh() {
    const iso3 = iso3Input.trim().toUpperCase()
    if (!iso3) { setError('Enter a 3-letter ISO country code'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/brief/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iso3 }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      const data = await res.json() as { brief: CountryBrief }
      setSelected(data.brief)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handlePublish() {
    if (!selected) return
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/brief/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: selected }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      setSuccess('Brief published.')
      setBriefs(prev => {
        const idx = prev.findIndex(b => b.iso3 === selected.iso3)
        return idx >= 0 ? prev.map((b, i) => i === idx ? selected : b) : [...prev, selected]
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function upd<K extends keyof CountryBrief>(key: K, value: CountryBrief[K]) {
    setSelected(prev => prev ? { ...prev, [key]: value } : prev)
  }

  const textField = (field: keyof Pick<CountryBrief, 'situation_overview' | 'key_dynamics' | 'historical_roots' | 'actor_map'>, rows: number) => (
    <div className="card" key={field}>
      <span className="section-title" style={{ display: 'block', marginBottom: '0.5rem' }}>
        {field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </span>
      <textarea rows={rows} value={selected![field]} onChange={e => upd(field, e.target.value)} />
    </div>
  )

  return (
    <div>
      <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>Country Intelligence Briefs</h2>

      <div className="card" style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <label>ISO3 Country Code</label>
          <input type="text" value={iso3Input} onChange={e => setIso3(e.target.value)} placeholder="e.g. IRN, CHN, THA" onKeyDown={e => e.key === 'Enter' && handleRefresh()} />
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={loading}>
          {loading ? '⟳ Synthesising...' : '↻ Synthesise Brief'}
        </button>
      </div>

      {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}

      {briefs.length > 0 && !selected && (
        <div className="card">
          <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Existing Briefs</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {briefs.map(b => (
              <button key={b.iso3} className="btn btn-secondary" onClick={() => setSelected(b)}>
                {b.iso3} <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.75rem' }}>{b.last_reviewed}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ color: '#e3b341', fontWeight: 700 }}>{selected.iso3} — Intelligence Brief</h3>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={() => { setSelected(null); setSuccess('') }}>← Back</button>
              <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
                {loading ? '⟳ Publishing...' : '↑ Publish Brief'}
              </button>
            </div>
          </div>
          {success && <p className="success" style={{ marginBottom: '1rem' }}>{success}</p>}

          {textField('situation_overview', 3)}
          {textField('key_dynamics',       4)}
          {textField('historical_roots',   5)}
          {textField('actor_map',          4)}

          <div className="card">
            <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Alignment Map</span>
            {(['primary_alignment', 'secondary_ties', 'internal_factions', 'fault_lines'] as const).map(f => (
              <div key={f} className="field">
                <label>{f.replace(/_/g, ' ')}</label>
                <textarea rows={2} value={selected.alignment_map[f]} onChange={e => upd('alignment_map', { ...selected.alignment_map, [f]: e.target.value })} />
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span className="section-title">Watchlist</span>
              <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={() => upd('watchlist', [...selected.watchlist, ''])}>+ Signal</button>
            </div>
            {selected.watchlist.map((item, i) => (
              <div key={i} className="watch-item">
                <span>{i + 1}.</span>
                <input type="text" value={item} onChange={e => {
                  const w = [...selected.watchlist]; w[i] = e.target.value; upd('watchlist', w)
                }} placeholder="Signal to monitor..." />
                <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem', minWidth: 28 }} onClick={() => upd('watchlist', selected.watchlist.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: '2rem' }}>
            <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
              {loading ? '⟳ Publishing...' : '↑ Publish Brief'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build the client to verify no TS errors**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-
npm run admin:build 2>&1 | tail -10
```

Expected: `✓ built in Xs` with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add admin/client/Briefs.tsx
git commit -m "feat: add Briefs view (country brief synthesiser and editor)"
```

---

## Task 12: Extend export runner to write analysis + briefs to WorldMap

**Files:**
- Modify: `intelligence/exports/worldmap-v2-exporter.ts`
- Modify: `intelligence/exports/run-exports.ts`

- [ ] **Step 1: Extend worldmap-v2-exporter.ts — add analysis to V2ImportedEvent + helper for human records**

Open `intelligence/exports/worldmap-v2-exporter.ts`.

Replace the `V2ImportedEvent` interface with:

```typescript
interface V2ImportedEvent {
  id:               string;
  source:           'rss_intelligence' | 'manual';
  eventDate:        string;
  iso3:             string[];
  eventType:        V2EventType;
  headline:         string;
  summary?:         string;
  coordinateQuality?: string;
  confidenceScore:  number;
  confidenceLabel:  'high' | 'medium' | 'low';
  tier:             1 | 2 | 3;
  tags?:            string[];
  geopoliticalScore?:   number;
  economicImpactScore?: number;
  analysis?: {
    what_happened:      string;
    historical_context: string;
    political_analysis: string;
    social_analysis:    string;
    actor_goals:        Array<{ name: string; stated_goal: string; real_goal: string; red_lines: string }>;
    bloc_perspectives:  Array<{ bloc: string; how_they_see_it: string; their_interest: string; internal_tension: string }>;
    what_to_watch:      string[];
    confidence:         { score: number; reasoning: string };
  };
}
```

Then add these imports at the top of the file (after the existing `import type { IntelligenceEvent }` line):

```typescript
import type { HumanIntelRecord } from '../human/store.ts';
import type { EventAnalysis }    from '../../admin/types.ts';
```

Then add this function at the end of the file (before the closing):

```typescript
export function buildV2HumanEventEntry(
  record:    HumanIntelRecord,
  analysis?: EventAnalysis,
): V2ImportedEvent | null {
  if (!record.extracted.event_type) return null;
  const iso3s = record.extracted.countries.filter(c => /^[A-Z]{3}$/.test(c));
  if (iso3s.length === 0) return null;

  return {
    id:               record.id,
    source:           'manual',
    eventDate:        record.submitted_at.slice(0, 10),
    iso3:             iso3s,
    eventType:        toV2EventType(record.extracted.event_type),
    headline:         record.extracted.title,
    coordinateQuality: 'country_centroid',
    confidenceScore:  record.extracted.confidence,
    confidenceLabel:  toConfidenceLabel(record.extracted.confidence),
    tier:             2,
    tags:             record.extracted.tags.length > 0 ? record.extracted.tags : undefined,
    analysis: analysis ? {
      what_happened:      analysis.what_happened,
      historical_context: analysis.historical_context,
      political_analysis: analysis.political_analysis,
      social_analysis:    analysis.social_analysis,
      actor_goals:        analysis.actor_goals,
      bloc_perspectives:  analysis.bloc_perspectives,
      what_to_watch:      analysis.what_to_watch,
      confidence:         analysis.confidence,
    } : undefined,
  };
}
```

- [ ] **Step 2: Extend run-exports.ts — import analysis store, merge human events, write briefs**

Open `intelligence/exports/run-exports.ts`.

After the existing import block, add:

```typescript
import { loadAnalysisStore, loadBriefs } from '../human/analysis-store.ts';
```

In the existing import from `'./worldmap-v2-exporter.ts'`, add `buildV2HumanEventEntry` to the named imports:

```typescript
import { buildV2EventsFile, buildV2Manifest, buildV2HumanEventEntry } from './worldmap-v2-exporter.ts';
```

In the existing import from `'../human/store.ts'`, add `loadHumanStore` to the named imports:

```typescript
import { loadPendingRecords, markExported, loadHumanStore } from '../human/store.ts';
```

Find the block that writes the v2 import files (starts with `// ── worldmaphistory_v2 import files`). Replace it with:

```typescript
  // ── worldmaphistory_v2 import files ───────────────────────────────────────
  const analyses  = loadAnalysisStore();
  const aMap      = new Map(analyses.map(a => [a.event_id, a]));
  const allHuman  = loadHumanStore();
  const humanV2   = allHuman
    .map(r => buildV2HumanEventEntry(r, aMap.get(r.id)))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const v2Events   = buildV2EventsFile(events, date);
  // Merge human-submitted events into the v2 file
  const v2EventsMerged = {
    ...v2Events,
    eventCount: v2Events.eventCount + humanV2.length,
    events:     [...v2Events.events, ...humanV2],
  };
  const v2Manifest = buildV2Manifest(v2EventsMerged.eventCount, date);

  const briefs   = loadBriefs();
  const briefsFile = {
    schemaVersion: '1.0.0',
    generatedAt:   new Date().toISOString(),
    briefs,
  };

  const V2_IMPORT_PATHS = [
    join(PATHS.root, '..', 'worldmaphistory_v2', 'public', 'data', 'imports'),
  ];
  for (const dir of V2_IMPORT_PATHS) {
    if (!existsSync(join(dir, '..'))) continue;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.json'),               JSON.stringify(v2EventsMerged, null, 2));
      writeFileSync(join(dir, 'manifest.json'),             JSON.stringify(v2Manifest, null, 2));
      writeFileSync(join(dir, 'intelligence-briefs.json'),  JSON.stringify(briefsFile, null, 2));
      logger.info('export', `worldmaphistory_v2 imports → ${dir}`);
    } catch {
      // Non-fatal — v2 may not be present in all environments
    }
  }
```

- [ ] **Step 3: Verify run-exports compiles**

```bash
npx tsx --no-warnings -e "import { runExports } from './intelligence/exports/run-exports.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add intelligence/exports/worldmap-v2-exporter.ts intelligence/exports/run-exports.ts
git commit -m "feat: include human intel events + analysis + country briefs in v2 WorldMap exports"
```

---

## End-to-End Smoke Test

After all tasks are complete:

- [ ] **Step 1: Build the client**

```bash
npm run admin:build
```

Expected: `✓ built in Xs` — no errors.

- [ ] **Step 2: Start the admin server**

```bash
npm run admin:api
```

Expected: `Admin panel → http://localhost:3001`

- [ ] **Step 3: Open in browser**

Open `http://localhost:3001` — should show the Submit News view.

- [ ] **Step 4: Submit a test article**

Paste any news article, select "Web", click "Analyse". Expected: ~15-30 seconds later, Draft view appears with filled analysis sections.

- [ ] **Step 5: Publish**

Edit any field, click "Publish to WorldMap". Expected: success message + redirects to Submit view.

- [ ] **Step 6: Verify store**

```bash
npx tsx --no-warnings -e "
import { loadHumanStore } from './intelligence/human/store.ts';
import { loadAnalysisStore } from './intelligence/human/analysis-store.ts';
console.log('Records:', loadHumanStore().length);
console.log('Analyses:', loadAnalysisStore().length);
"
```

Expected: both show 1 (or more if you tested multiple times).
