# Datahub Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-intel submission channel (conversational + file inbox), an economist agent (auto consequence analysis + on-demand scenario drilling), and two Claude Code skills that wire them together.

**Architecture:** Human intel records are stored in `intelligence/human/store.json` (snake_case, one record per submission). The existing export runner is extended to merge pending records into all three export files as `human_intel[]`, then marks them exported. Two Claude Code skills (`.claude/skills/human-intel.md` and `.claude/skills/economist.md`) guide the conversational path; a non-interactive script (`scripts/human-intel.ts`) handles the inbox fallback.

**Tech Stack:** TypeScript/ESM, `tsx`, `@anthropic-ai/sdk` (already in `package.json`), existing `lib/paths.ts` / `lib/logger.ts` / `intelligence/exports/` patterns.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `lib/paths.ts` | Add `intelligence.human.*` path constants |
| Create | `intelligence/human/store.ts` | `HumanIntelRecord` type + CRUD (load / save / append / markExported) |
| Create | `intelligence/human/store.json` | Empty store (`[]`) — committed as initial state |
| Create | `intelligence/human/inbox.md` | Empty fallback inbox file |
| Create | `intelligence/human/extractor.ts` | Claude API call: extract + credibility + cross-reference + follow-ups |
| Create | `intelligence/human/economist.ts` | Claude API: quick consequence chain (auto) + deep scenario analysis (on-demand) |
| Modify | `intelligence/exports/run-exports.ts` | Load pending human records, spread into each written export, mark exported |
| Create | `scripts/human-intel.ts` | Non-interactive inbox processor: read inbox → extract → economist → export |
| Modify | `package.json` | Add `"human-intel": "tsx scripts/human-intel.ts"` script |
| Create | `.claude/skills/human-intel.md` | Claude Code skill: guides conversational human intel submission |
| Create | `.claude/skills/economist.md` | Claude Code skill: guides on-demand scenario analysis |

---

## Task 1: Add human paths to `lib/paths.ts`

**Files:**
- Modify: `lib/paths.ts`

- [ ] **Step 1: Add the human intel paths block**

Open `lib/paths.ts`. Inside the `intelligence:` object (after the `memory:` line, before the closing `}`), add:

```typescript
    human: {
      root:  join(ROOT, 'intelligence', 'human'),
      store: join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox: join(ROOT, 'intelligence', 'human', 'inbox.md'),
    },
```

The full `intelligence:` block becomes:
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
      root:  join(ROOT, 'intelligence', 'human'),
      store: join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox: join(ROOT, 'intelligence', 'human', 'inbox.md'),
    },
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/thanapold/Desktop/Projects/world-intelligence-data-hub-
npx tsx --no-warnings -e "import { PATHS } from './lib/paths.ts'; console.log(PATHS.intelligence.human)"
```

Expected output:
```
{ root: '...intelligence/human', store: '...intelligence/human/store.json', inbox: '...intelligence/human/inbox.md' }
```

- [ ] **Step 3: Commit**

```bash
git add lib/paths.ts
git commit -m "feat: add human intel paths to PATHS constant"
```

---

## Task 2: Create HumanIntelRecord type and store CRUD

**Files:**
- Create: `intelligence/human/store.ts`
- Create: `intelligence/human/store.json`
- Create: `intelligence/human/inbox.md`

- [ ] **Step 1: Create `intelligence/human/store.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { PATHS } from '../../lib/paths.ts';

export interface HumanIntelRecord {
  id:               string;   // 'human-<8-char-hash>'
  submitted_at:     string;   // ISO-8601
  source_platform:  'tiktok' | 'youtube' | 'podcast' | 'web' | 'other';
  source_url?:      string;
  raw_text:         string;
  extracted: {
    title:      string;
    topic:      'geopolitical' | 'economic' | 'technology' | 'social' | 'energy' | 'other';
    countries:  string[];     // ISO alpha-3
    actors:     string[];
    event_type: string | null;
    confidence: number;       // 0–1
    tags:       string[];
  };
  credibility: {
    source_tier:      'unverified' | 'social' | 'news' | 'primary';
    bias_flags:       string[];
    cross_references: string[];   // storyline_id or event_id from exports
    assessment:       string;
  };
  follow_up_requests:       string[];
  economist_quick_analysis: string;
  exported:                 boolean;
}

export function generateHumanIntelId(rawText: string, submittedAt: string): string {
  return 'human-' + createHash('sha256').update(rawText + submittedAt).digest('hex').slice(0, 8);
}

export function loadHumanStore(): HumanIntelRecord[] {
  if (!existsSync(PATHS.intelligence.human.store)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.store, 'utf-8')) as HumanIntelRecord[];
  } catch {
    return [];
  }
}

export function saveHumanStore(records: HumanIntelRecord[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.store, JSON.stringify(records, null, 2));
}

export function appendHumanRecord(record: HumanIntelRecord): void {
  const store = loadHumanStore();
  store.push(record);
  saveHumanStore(store);
}

export function markExported(ids: string[]): void {
  const store = loadHumanStore();
  const idSet = new Set(ids);
  for (const r of store) {
    if (idSet.has(r.id)) r.exported = true;
  }
  saveHumanStore(store);
}

export function loadPendingRecords(): HumanIntelRecord[] {
  return loadHumanStore().filter(r => !r.exported);
}
```

- [ ] **Step 2: Create `intelligence/human/store.json`**

```json
[]
```

- [ ] **Step 3: Create `intelligence/human/inbox.md`**

```markdown
<!-- Drop news summaries below this line. Run `npm run human-intel` to process. -->
```

- [ ] **Step 4: Verify types compile**

```bash
npx tsx --no-warnings -e "import { loadHumanStore } from './intelligence/human/store.ts'; console.log(loadHumanStore())"
```

Expected: `[]`

- [ ] **Step 5: Commit**

```bash
git add intelligence/human/store.ts intelligence/human/store.json intelligence/human/inbox.md
git commit -m "feat: add HumanIntelRecord type and store CRUD"
```

---

## Task 3: Build the Claude extractor

**Files:**
- Create: `intelligence/human/extractor.ts`

- [ ] **Step 1: Create `intelligence/human/extractor.ts`**

```typescript
import Anthropic        from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }         from 'path';
import { PATHS }        from '../../lib/paths.ts';
import { generateHumanIntelId } from './store.ts';
import type { HumanIntelRecord } from './store.ts';

const client = new Anthropic();

function loadExportContext(): string {
  const wiPath = join(PATHS.exports.worldMap, 'intelligence.json');
  if (!existsSync(wiPath)) return 'No existing intelligence data.';
  try {
    const wi = JSON.parse(readFileSync(wiPath, 'utf-8'));
    const storylines = (wi.storylines ?? []).slice(0, 12).map((s: Record<string, unknown>) =>
      `  [${s['storylineId']}] "${s['title']}" — ${s['storylineState']}, ${s['totalEvents']} events, countries: ${(s['countries'] as string[] ?? []).join(', ')}`
    ).join('\n');
    const events = (wi.events ?? []).slice(0, 15).map((e: Record<string, unknown>) =>
      `  [${e['eventId']}] "${e['title']}" — ${e['eventType']}, severity ${e['severity']}`
    ).join('\n');
    return `Active storylines:\n${storylines || '  (none)'}\n\nRecent events:\n${events || '  (none)'}`;
  } catch {
    return 'Export context unavailable.';
  }
}

const SYSTEM_PROMPT = `You are an intelligence analyst for a geopolitical data hub.
Given user-submitted content from any source, you must:
1. Extract structured intelligence (title, topic, countries, actors, event_type, confidence, tags)
2. Assess credibility (source tier, bias flags, plausibility against existing intel)
3. Cross-reference against the current intelligence database
4. List follow-up questions the user should go verify manually

Respond ONLY with valid JSON. No markdown. No explanation.

Schema:
{
  "extracted": {
    "title": "concise title, max 120 chars",
    "topic": "geopolitical|economic|technology|social|energy|other",
    "countries": ["ISO alpha-3 e.g. USA IRN CHN"],
    "actors": ["named individuals or organizations"],
    "event_type": "one type from the list below, or null",
    "confidence": 0.0,
    "tags": ["relevant tags"]
  },
  "credibility": {
    "source_tier": "unverified|social|news|primary",
    "bias_flags": ["state_narrative|unverified_claim|single_source|sensationalist|speculation"],
    "cross_references": ["storylineId or eventId from the database that this relates to"],
    "assessment": "plain text: plausibility, contradictions, confirmations"
  },
  "follow_up_requests": ["specific things to verify from sources you cannot access"]
}

Valid event_type values: armed_conflict, airstrike, missile_attack, military_operation,
military_exercise, nuclear_incident, assassination, terrorist_attack, coup, election,
protest, regime_change, diplomatic_incident, sanctions, treaty, peace_negotiation,
referendum, supply_disruption, trade_dispute, market_crash, central_bank_action,
economic_data_release, debt_crisis, commodity_price_move, opec_decision,
energy_infrastructure, humanitarian_crisis, refugee_movement, natural_disaster,
epidemic, other. Use null if nothing fits.

Source tiers: primary=official docs/verified eyewitness, news=established outlets,
social=TikTok/YouTube/podcasts/informal, unverified=anonymous/speculative.`;

export async function extractHumanIntel(opts: {
  rawText:        string;
  sourcePlatform: HumanIntelRecord['source_platform'];
  sourceUrl?:     string;
}): Promise<HumanIntelRecord> {
  const { rawText, sourcePlatform, sourceUrl } = opts;
  const submittedAt = new Date().toISOString();
  const id = generateHumanIntelId(rawText, submittedAt);
  const exportContext = loadExportContext();

  const userMessage = [
    `Source platform: ${sourcePlatform}`,
    sourceUrl ? `Source URL: ${sourceUrl}` : null,
    '',
    'Submitted content:',
    '---',
    rawText,
    '---',
    '',
    'Current intelligence database for cross-referencing:',
    exportContext,
  ].filter(l => l !== null).join('\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');

  type ParsedResponse = {
    extracted:          HumanIntelRecord['extracted'];
    credibility:        HumanIntelRecord['credibility'];
    follow_up_requests: string[];
  };
  const parsed = JSON.parse(block.text) as ParsedResponse;

  return {
    id,
    submitted_at:              submittedAt,
    source_platform:           sourcePlatform,
    source_url:                sourceUrl,
    raw_text:                  rawText,
    extracted:                 parsed.extracted,
    credibility:               parsed.credibility,
    follow_up_requests:        parsed.follow_up_requests ?? [],
    economist_quick_analysis:  '',   // filled by economist.ts
    exported:                  false,
  };
}
```

- [ ] **Step 2: Verify it compiles (no API call yet)**

```bash
npx tsx --no-warnings -e "import './intelligence/human/extractor.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add intelligence/human/extractor.ts
git commit -m "feat: add Claude extractor for human intel submissions"
```

---

## Task 4: Build the economist module

**Files:**
- Create: `intelligence/human/economist.ts`

- [ ] **Step 1: Create `intelligence/human/economist.ts`**

```typescript
import Anthropic    from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }     from 'path';
import { PATHS }    from '../../lib/paths.ts';
import type { HumanIntelRecord } from './store.ts';

const client = new Anthropic();

function loadEconomicContext(): string {
  const parts: string[] = [];

  const oilPath = join(PATHS.exports.oilProject, 'intelligence.json');
  if (existsSync(oilPath)) {
    try {
      const oil = JSON.parse(readFileSync(oilPath, 'utf-8')) as Record<string, unknown>;
      const risk = (oil['hormuzRisk'] as Record<string, unknown> | undefined);
      if (risk) parts.push(`Hormuz risk: ${risk['riskLevel']}`);
      const sigs = (oil['commoditySignals'] as Array<Record<string, unknown>> | undefined) ?? [];
      if (sigs.length) parts.push(`Commodity signals: ${sigs.map(c => `${c['commodity']}:${c['signalDirection']}`).join(', ')}`);
    } catch { /* non-fatal */ }
  }

  const stockPath = join(PATHS.exports.stockProject, 'intelligence.json');
  if (existsSync(stockPath)) {
    try {
      const stock = JSON.parse(readFileSync(stockPath, 'utf-8')) as Record<string, unknown>;
      const macros = (stock['macroRiskSignals'] as Array<Record<string, unknown>> | undefined) ?? [];
      if (macros.length) parts.push(`Macro risks: ${macros.map(r => `${r['riskType']}(${Number(r['intensity']).toFixed(2)})`).join(', ')}`);
    } catch { /* non-fatal */ }
  }

  return parts.length ? parts.join('\n') : 'No economic context available.';
}

export async function generateQuickAnalysis(record: HumanIntelRecord): Promise<string> {
  const ctx = loadEconomicContext();

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system:     `You are an economist specializing in geopolitical risk and second-order effects.
Given an intelligence event, write a 3–5 step consequence chain.
Format: "If [event] → [immediate effect] → [secondary effect] → [who gets hit and how]"
Be specific and directional. One paragraph. No headers. No bullet points.`,
    messages: [{
      role:    'user',
      content: `Event: ${record.extracted.title}
Topic: ${record.extracted.topic}
Countries: ${record.extracted.countries.join(', ')}
Confidence: ${record.extracted.confidence}
Current economic context:
${ctx}`,
    }],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text.trim() : '';
}

export interface ScenarioAnalysis {
  base_case:        string;
  bull_case:        string;
  bear_case:        string;
  affected_sectors: string[];
  key_variables:    string[];
  data_gaps:        string[];
}

export async function analyzeScenario(scenario: string): Promise<ScenarioAnalysis> {
  const oilPath   = join(PATHS.exports.oilProject,   'intelligence.json');
  const stockPath = join(PATHS.exports.stockProject,  'intelligence.json');
  const wiPath    = join(PATHS.exports.worldMap,      'intelligence.json');

  const contextParts: string[] = [];
  for (const [label, path] of [['Oil/energy', oilPath], ['Stock/macro', stockPath], ['World intel', wiPath]] as [string, string][]) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
        contextParts.push(`${label}: ${JSON.stringify(data).slice(0, 800)}`);
      } catch { /* non-fatal */ }
    }
  }

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     `You are a senior economist specializing in geopolitical risk.
Analyze scenarios across multiple outcome paths.
Respond ONLY with valid JSON — no markdown:
{
  "base_case": "most likely economic outcome",
  "bull_case": "optimistic path — what must go right",
  "bear_case": "pessimistic path — what could go wrong",
  "affected_sectors": ["sector: brief exposure note"],
  "key_variables": ["3-5 signals that determine which case plays out"],
  "data_gaps": ["sources the user could check manually to sharpen the analysis"]
}`,
    messages: [{
      role:    'user',
      content: `Scenario: ${scenario}\n\nContext:\n${contextParts.join('\n\n')}`,
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response');
  return JSON.parse(block.text) as ScenarioAnalysis;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsx --no-warnings -e "import './intelligence/human/economist.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add intelligence/human/economist.ts
git commit -m "feat: add economist module (quick analysis + scenario drilling)"
```

---

## Task 5: Extend export runner to merge human intel

**Files:**
- Modify: `intelligence/exports/run-exports.ts`

- [ ] **Step 1: Add imports at the top of `run-exports.ts`**

After the existing imports block, add:

```typescript
import { loadPendingRecords, markExported } from '../human/store.ts';
import type { HumanIntelRecord } from '../human/store.ts';
```

- [ ] **Step 2: Load pending human records at start of `runExports()`**

At the top of the `runExports()` function body, after the `logger.info('export', ...)` line, add:

```typescript
  const pendingHuman: HumanIntelRecord[] = loadPendingRecords();
  if (pendingHuman.length > 0) {
    logger.info('export', `Merging ${pendingHuman.length} pending human-intel record(s) into exports`);
  }
```

- [ ] **Step 3: Inject `human_intel` into each export write**

Find the three `writeExport()` calls. Replace each one with a version that spreads human intel into the payload.

Replace:
```typescript
  const wiWritten = writeExport(wiPath, worldIntelExt);
```
With:
```typescript
  const wiPayload = pendingHuman.length ? { ...(worldIntelExt as Record<string, unknown>), human_intel: pendingHuman } : worldIntelExt;
  const wiWritten = writeExport(wiPath, wiPayload);
```

Replace:
```typescript
  const oilWritten = writeExport(oilPath, oilExt);
```
With:
```typescript
  const oilPayload = pendingHuman.length ? { ...(oilExt as Record<string, unknown>), human_intel: pendingHuman } : oilExt;
  const oilWritten = writeExport(oilPath, oilPayload);
```

Replace:
```typescript
  const stockWritten = writeExport(stockPath, stockExt);
```
With:
```typescript
  const stockPayload = pendingHuman.length ? { ...(stockExt as Record<string, unknown>), human_intel: pendingHuman } : stockExt;
  const stockWritten = writeExport(stockPath, stockPayload);
```

- [ ] **Step 4: Mark all pending records as exported after all three writes**

Find the `saveManifest(manifest)` call. Immediately after it, add:

```typescript
  if (pendingHuman.length > 0) {
    markExported(pendingHuman.map(r => r.id));
    logger.info('export', `Marked ${pendingHuman.length} human-intel record(s) as exported`);
  }
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsx --no-warnings -e "import { runExports } from './intelligence/exports/run-exports.ts'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add intelligence/exports/run-exports.ts
git commit -m "feat: merge pending human-intel records into export files"
```

---

## Task 6: Build the inbox processor script

**Files:**
- Create: `scripts/human-intel.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/human-intel.ts`**

```typescript
// Non-interactive human intel processor.
// Reads intelligence/human/inbox.md, extracts intel, runs economist analysis,
// appends to store, then re-runs exports.
// Usage: npm run human-intel

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { PATHS }             from '../lib/paths.ts';
import { logger }            from '../lib/logger.ts';
import { extractHumanIntel } from '../intelligence/human/extractor.ts';
import { generateQuickAnalysis } from '../intelligence/human/economist.ts';
import { appendHumanRecord } from '../intelligence/human/store.ts';
import { runExports }        from '../intelligence/exports/run-exports.ts';

const PROCESSED_MARKER = /^<!--\s*processed:/m;

function readInbox(): { text: string; sourcePlatform: 'web' } | null {
  if (!existsSync(PATHS.intelligence.human.inbox)) {
    logger.warn('human-intel', 'inbox.md not found — nothing to process');
    return null;
  }

  const raw = readFileSync(PATHS.intelligence.human.inbox, 'utf-8');

  // Content is everything after the last <!-- processed: ... --> line
  const lines = raw.split('\n');
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (PROCESSED_MARKER.test(lines[i])) contentStart = i + 1;
  }

  const content = lines.slice(contentStart).join('\n').trim();
  if (!content || content.startsWith('<!--')) {
    logger.info('human-intel', 'inbox.md is empty — nothing to process');
    return null;
  }

  return { text: content, sourcePlatform: 'web' };
}

function clearInbox(): void {
  const now = new Date().toISOString();
  const existing = existsSync(PATHS.intelligence.human.inbox)
    ? readFileSync(PATHS.intelligence.human.inbox, 'utf-8')
    : '';

  // Keep all previous processed markers + add new one; clear content
  const prevMarkers = existing.split('\n').filter(l => PROCESSED_MARKER.test(l));
  const newContent = [...prevMarkers, `<!-- processed: ${now} -->`].join('\n') + '\n';
  writeFileSync(PATHS.intelligence.human.inbox, newContent);
}

async function main(): Promise<void> {
  const inbox = readInbox();
  if (!inbox) process.exit(0);

  logger.info('human-intel', `Processing inbox content (${inbox.text.length} chars)`);

  const record = await extractHumanIntel({
    rawText:        inbox.text,
    sourcePlatform: inbox.sourcePlatform,
  });

  logger.info('human-intel', `Extracted: "${record.extracted.title}" (confidence: ${record.extracted.confidence})`);

  record.economist_quick_analysis = await generateQuickAnalysis(record);
  logger.info('human-intel', 'Economist quick analysis complete');

  appendHumanRecord(record);
  logger.info('human-intel', `Record saved → ${record.id}`);

  clearInbox();
  logger.info('human-intel', 'Inbox cleared');

  const today = new Date().toISOString().slice(0, 10);
  try {
    runExports(today);
    logger.info('human-intel', 'Exports updated with new human-intel record');
  } catch (err) {
    logger.warn('human-intel', `Export step skipped: ${(err as Error).message}`);
  }

  console.log('\n=== Extraction result ===');
  console.log(`ID:         ${record.id}`);
  console.log(`Title:      ${record.extracted.title}`);
  console.log(`Topic:      ${record.extracted.topic}`);
  console.log(`Countries:  ${record.extracted.countries.join(', ')}`);
  console.log(`Confidence: ${record.extracted.confidence}`);
  console.log(`Assessment: ${record.credibility.assessment}`);
  if (record.follow_up_requests.length) {
    console.log('\nFollow-up needed:');
    record.follow_up_requests.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  }
  console.log('\nEconomist analysis:');
  console.log(`  ${record.economist_quick_analysis}`);
}

main().catch(err => {
  logger.error('human-intel', (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: Add script to `package.json`**

In `package.json`, inside the `"scripts"` object, add after `"observe"`:

```json
    "human-intel": "tsx scripts/human-intel.ts"
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsx --no-warnings -e "import './scripts/human-intel.ts'" 2>&1 | head -5
```

Expected: no TypeScript errors (it will exit early since there's no inbox content to process).

- [ ] **Step 4: Smoke test with real content**

Drop a test item in the inbox:
```bash
echo "
TikTok video claims China is moving warships near Taiwan strait again. Multiple videos showing naval vessels. Posted by military enthusiast accounts. No official confirmation.
" >> intelligence/human/inbox.md
```

Run the processor:
```bash
npm run human-intel
```

Expected: extraction output printed, `intelligence/human/store.json` now has one record, inbox cleared.

- [ ] **Step 5: Verify store**

```bash
npx tsx --no-warnings -e "import { loadHumanStore } from './intelligence/human/store.ts'; console.log(JSON.stringify(loadHumanStore()[0], null, 2))"
```

Expected: full record with `extracted`, `credibility`, `follow_up_requests`, `economist_quick_analysis`, `exported: false`.

- [ ] **Step 6: Commit**

```bash
git add scripts/human-intel.ts package.json
git commit -m "feat: add human-intel inbox processor script"
```

---

## Task 7: Create Claude Code skills

**Files:**
- Create: `.claude/skills/human-intel.md`
- Create: `.claude/skills/economist.md`

- [ ] **Step 1: Create `.claude/` and `.claude/skills/` directories**

```bash
mkdir -p .claude/skills
```

- [ ] **Step 2: Create `.claude/skills/human-intel.md`**

```markdown
# Human Intel Submission

Guide the user through submitting intelligence they discovered manually from sources
the pipeline cannot reach (TikTok, YouTube, podcasts, private links, personal observations).

## Steps

1. **Ask what they found** — "What did you see? Paste the text, describe the video, or summarize the podcast."
   - Also ask: what platform/source, and do they have a URL?

2. **Load context** — Read these files for cross-referencing:
   - `exports/world-map/intelligence.json` (storylines and events)
   - `intelligence/human/store.json` (prior human submissions)

3. **Analyse inline** — You ARE the analyst. Do not call an external script. Perform:
   - **Extraction**: title, topic, countries (ISO alpha-3), actors, event_type (from the taxonomy or null), confidence (0–1), tags
   - **Credibility**: source tier (unverified/social/news/primary), bias flags, cross-references to existing storyline/event IDs, written assessment
   - **Follow-up questions**: list specific things the user should go verify from sources you cannot access

4. **Present findings** — Show the extraction and credibility assessment clearly.
   Ask follow-up questions if needed. Wait for the user's answers before finalising.

5. **Economist quick analysis** — After extraction is finalised, generate a 3–5 step
   consequence chain: "If [event] → [effect] → [secondary effect] → [who gets hit]"

6. **Write to store** — Append the complete record to `intelligence/human/store.json`
   using the Write/Edit tool. Record format:
   ```json
   {
     "id": "human-<8 hex chars from sha256 of rawText+submittedAt>",
     "submitted_at": "<ISO-8601>",
     "source_platform": "tiktok|youtube|podcast|web|other",
     "source_url": "<optional>",
     "raw_text": "<full user text>",
     "extracted": { "title": "", "topic": "", "countries": [], "actors": [], "event_type": null, "confidence": 0.0, "tags": [] },
     "credibility": { "source_tier": "", "bias_flags": [], "cross_references": [], "assessment": "" },
     "follow_up_requests": [],
     "economist_quick_analysis": "",
     "exported": false
   }
   ```

7. **Re-export** — Run `npm run export` via Bash to push the record into the export files.
   Confirm success to the user.

## Tone
Be concise and analytical. Flag contradictions with existing intelligence immediately.
If a claim seems implausible, say so and explain why. Don't soften assessments.
```

- [ ] **Step 3: Create `.claude/skills/economist.md`**

```markdown
# Economist — Scenario Analysis

Guide the user through analyzing the economic and geopolitical consequences of any scenario.
Not domain-restricted — any topic is valid (AI regulation, Fed decisions, supply chains, conflict, etc.).

## Steps

1. **Understand the scenario** — Ask the user to describe it in plain language if they haven't already.
   Clarify the scope: What is the triggering event? What timeframe?

2. **Load context** — Read these files:
   - `exports/world-map/intelligence.json` — active storylines and events
   - `exports/oil-project/intelligence.json` — Hormuz risk, commodity signals
   - `exports/stock-project/intelligence.json` — macro risk signals, sector exposure
   - `intelligence/human/store.json` — recent human-submitted intel

3. **Analyse the scenario** — Produce a structured analysis:

   **Base case** — most likely outcome and economic consequences
   **Bull case** — optimistic path: what must go right
   **Bear case** — pessimistic path: what could go wrong

   **Affected sectors and countries** — who is exposed and how
   **Key variables to watch** — 3–5 signals/indicators that determine which case plays out
   **Data gaps** — specific sources the user could check manually to sharpen the analysis
     (these become inputs for a follow-up human-intel submission)

4. **Invite drill-down** — After presenting the analysis, ask: "Which case do you want to
   drill into further?" or "Should I go deeper on any sector?"

5. **Loop back to human-intel** — If the data gaps are significant, suggest the user invoke
   the human-intel skill after checking those sources, so the new information is captured
   in the store.

## Tone
Senior economist register. Be specific and directional — give rough probability guidance
(e.g. "base case ~60%, bear case ~30%") rather than hedging everything. Flag your
assumptions explicitly. Disagree with the user if the data doesn't support their framing.
```

- [ ] **Step 4: Verify both files exist**

```bash
ls -la .claude/skills/
```

Expected: `human-intel.md` and `economist.md` listed.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/human-intel.md .claude/skills/economist.md
git commit -m "feat: add human-intel and economist Claude Code skills"
```

---

## Task 8: Git privacy (manual — user performs this)

This task requires the user to act on GitHub. No code changes.

- [ ] **Step 1: Change repo visibility**

  1. Open the repository on GitHub
  2. Settings → Danger Zone → "Change repository visibility"
  3. Select "Private"
  4. Confirm with your GitHub password

- [ ] **Step 2: Verify remote still works**

```bash
git remote -v
git fetch origin
```

Expected: fetch succeeds with no authentication errors.

---

## Self-review notes

- All tasks produce a commit — no orphaned state between tasks
- `loadPendingRecords()` is idempotent — safe to run export multiple times
- `markExported()` uses a Set for O(1) lookup
- `human_intel` is additive to existing exports — no breaking schema change
- Skills reference exact file paths matching `PATHS` constants
- Inbox processor exits cleanly if inbox is empty (no error, no API call)
- `analyzeScenario()` in `economist.ts` is used exclusively by the Claude Code skill (not by the inbox processor)
