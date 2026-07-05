# Twitter / X Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add X (Twitter) as a daily-batch source — fetches timelines from a curated account list via twitterapi.io and feeds tweets through the existing pipeline unchanged.

**Architecture:** A standalone `twitter-collector.ts` module loads `intelligence/twitter/accounts.json`, calls the twitterapi.io REST API for each enabled account, converts tweets to `ArticleRecord` format, and writes per-account output files to `intelligence/outputs/articles/YYYY-MM-DD/`. The existing `score → report → dedup → link → export` pipeline picks these up automatically. `scripts/collect-articles.ts` calls the Twitter collector after the RSS collection loop, gated on `TWITTERAPI_IO_KEY`.

**Tech Stack:** TypeScript/ESM, `tsx`, `fetch` (Node built-in ≥20), twitterapi.io REST API, `@anthropic-ai/sdk` is NOT used here.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `lib/paths.ts` | Modify | Add `intelligence.twitter.{root, accounts}` paths |
| `intelligence/twitter/accounts.json` | Create | Curated account list with 5 seed accounts |
| `intelligence/twitter/twitter-collector.ts` | Create | API fetch, tweet→ArticleRecord conversion, output persistence |
| `scripts/collect-articles.ts` | Modify | Call `runTwitterCollector` after RSS; display results |

---

### Task 1: Paths + Account List

**Files:**
- Modify: `lib/paths.ts:56-63`
- Create: `intelligence/twitter/accounts.json`

- [ ] **Step 1: Add twitter paths to `lib/paths.ts`**

Find the `human:` block (around line 56) and add the `twitter:` block immediately after it, inside the `intelligence:` object:

```typescript
    human: {
      root:          join(ROOT, 'intelligence', 'human'),
      store:         join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox:         join(ROOT, 'intelligence', 'human', 'inbox.md'),
      analysisStore: join(ROOT, 'intelligence', 'human', 'analysis-store.json'),
      briefs:        join(ROOT, 'intelligence', 'human', 'briefs.json'),
    },
    twitter: {
      root:     join(ROOT, 'intelligence', 'twitter'),
      accounts: join(ROOT, 'intelligence', 'twitter', 'accounts.json'),
    },
```

- [ ] **Step 2: Create `intelligence/twitter/accounts.json`**

```json
[
  {
    "username": "RALee85",
    "display_name": "Rob Lee",
    "category": "analyst",
    "reliability_tier": 2,
    "region_focus": ["Russia", "Ukraine", "Europe"],
    "topics": ["conflict", "politics"],
    "notes": "Senior Fellow FPRI — real-time Russian/Ukrainian military analysis",
    "enabled": true
  },
  {
    "username": "HassanIHassan",
    "display_name": "Hassan Hassan",
    "category": "analyst",
    "reliability_tier": 2,
    "region_focus": ["Middle East", "Syria", "Iraq"],
    "topics": ["conflict", "diplomacy", "politics"],
    "notes": "ISIS/Syria expert, New Lines Institute",
    "enabled": true
  },
  {
    "username": "borzou",
    "display_name": "Borzou Daragahi",
    "category": "reporter",
    "reliability_tier": 2,
    "region_focus": ["Middle East", "North Africa"],
    "topics": ["conflict", "politics", "society"],
    "notes": "Independent journalist — Middle East and North Africa field reporting",
    "enabled": true
  },
  {
    "username": "MFA_China",
    "display_name": "Chinese MFA Spokesperson",
    "category": "official",
    "reliability_tier": 3,
    "region_focus": ["China", "Global"],
    "topics": ["diplomacy", "politics"],
    "notes": "Official CCP foreign ministry account — narrative track",
    "enabled": true
  },
  {
    "username": "mfa_russia",
    "display_name": "Russian MFA",
    "category": "official",
    "reliability_tier": 3,
    "region_focus": ["Russia", "Global"],
    "topics": ["diplomacy", "conflict", "politics"],
    "notes": "Official Russian foreign ministry — narrative track",
    "enabled": true
  }
]
```

- [ ] **Step 3: Verify paths are importable**

```bash
node -e "import('./lib/paths.ts').then(m => console.log(m.PATHS.intelligence.twitter))"
```

Expected output:
```
{ root: '/…/intelligence/twitter', accounts: '/…/intelligence/twitter/accounts.json' }
```

- [ ] **Step 4: Commit**

```bash
git add lib/paths.ts intelligence/twitter/accounts.json
git commit -m "feat: add twitter paths and seed accounts list"
```

---

### Task 2: Twitter Collector Module

**Files:**
- Create: `intelligence/twitter/twitter-collector.ts`

This module is self-contained. It imports types from `lib/types.ts` and `intelligence/sources/collector.ts`, and the fingerprint function from `intelligence/sources/fingerprint.ts`. It does NOT import from `intelligence/sources/collector.ts`'s internal helpers — it reimplements the minimal patterns it needs.

- [ ] **Step 1: Create `intelligence/twitter/twitter-collector.ts`**

```typescript
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PATHS }          from '../../lib/paths.ts';
import { logger }         from '../../lib/logger.ts';
import { checkAndRecord } from '../sources/fingerprint.ts';
import type { ArticleRecord, ArticleLifecycle, TranslationMetadata } from '../../lib/types.ts';
import type { CollectionResult } from '../sources/collector.ts';

// ── Account types ─────────────────────────────────────────────────────────────

export interface TwitterAccount {
  username:         string;
  display_name:     string;
  category:         'analyst' | 'reporter' | 'official';
  reliability_tier: 1 | 2 | 3;
  region_focus:     string[];
  topics:           string[];
  notes:            string;
  enabled:          boolean;
}

// ── twitterapi.io response types ──────────────────────────────────────────────

interface TweetAuthor {
  userName: string;
  name:     string;
}

interface TweetItem {
  id:               string;
  url:              string;
  text:             string;
  createdAt:        string;
  lang:             string;
  isReply:          boolean;
  author:           TweetAuthor;
  retweeted_tweet:  TweetItem | null;
  quoted_tweet:     TweetItem | null;
}

interface TwitterApiResponse {
  tweets:        TweetItem[];
  has_next_page: boolean;
  next_cursor:   string;
  status:        string;
  message?:      string;
}

interface SourceOutputFile {
  source_id:    string;
  date:         string;
  generated_at: string;
  stats: {
    total:             number;
    new_articles:      number;
    exact_duplicates:  number;
    syndicated:        number;
    stale_skipped:     number;
  };
  articles: ArticleRecord[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ARTICLE_AGE_MS = 30 * 86_400_000; // 30 days — matches RSS collector
const API_BASE           = 'https://api.twitterapi.io';

// ── Account loader ────────────────────────────────────────────────────────────

export function loadAccounts(): TwitterAccount[] {
  const p = PATHS.intelligence.twitter.accounts;
  if (!existsSync(p)) {
    logger.warn('twitter', 'accounts.json not found');
    return [];
  }
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TwitterAccount[];
  } catch {
    logger.warn('twitter', 'Failed to parse accounts.json');
    return [];
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchTweets(username: string, apiKey: string): Promise<TweetItem[]> {
  const url = `${API_BASE}/twitter/user/last_tweets?userName=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    signal:  AbortSignal.timeout(20_000),
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as TwitterApiResponse;
  if (data.status !== 'success') throw new Error(`API error: ${data.status} — ${data.message ?? ''}`);
  return data.tweets;
}

// ── ArticleRecord builder ─────────────────────────────────────────────────────

function defaultLifecycle(): ArticleLifecycle {
  return {
    ingestion_status:  'fetched',
    processing_status: 'normalized',
    dedup_status:      'new',
    ai_status:         'pending',
  };
}

function defaultTranslation(lang: string): TranslationMetadata {
  const isEnglish = !lang || lang === 'en';
  return {
    original_language:  lang || 'en',
    translation_status: isEnglish ? 'not_required' : 'pending',
  };
}

function tweetToArticleRecord(
  tweet:     TweetItem,
  account:   TwitterAccount,
  fetchedAt: string,
): ArticleRecord | null {
  if (!tweet.text?.trim() || !tweet.url?.trim()) return null;

  const description = tweet.quoted_tweet
    ? `${tweet.text}\n\nQuoting @${tweet.quoted_tweet.author.userName}: ${tweet.quoted_tweet.text}`
    : tweet.text;

  const title    = tweet.text.replace(/\n/g, ' ').slice(0, 100);
  const sourceId = `twitter-${account.username}`;
  const fp       = checkAndRecord(title, sourceId, tweet.createdAt, tweet.url);

  const lifecycle = defaultLifecycle();
  lifecycle.dedup_status = fp.is_exact_duplicate ? 'exact_duplicate'
                         : fp.is_syndicated      ? 'syndicated'
                         : 'new';
  if (fp.is_exact_duplicate) lifecycle.ai_status = 'skipped';

  return {
    id:               fp.fingerprint.exact,
    source_id:        sourceId,
    source_name:      account.display_name,
    reliability_tier: account.reliability_tier,
    title,
    url:              tweet.url,
    published_at:     tweet.createdAt,
    fetched_at:       fetchedAt,
    description,
    author:           tweet.author.userName,
    fingerprint:      fp.fingerprint.exact,
    syndication_key:  fp.fingerprint.syndication_key,
    translation:      defaultTranslation(tweet.lang),
    lifecycle,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function outputPath(username: string, date: string): string {
  return join(PATHS.intelligence.outputArticles, date, `twitter-${username}.json`);
}

function loadExistingOutput(username: string, date: string): ArticleRecord[] {
  const p = outputPath(username, date);
  if (!existsSync(p)) return [];
  try {
    const f = JSON.parse(readFileSync(p, 'utf-8')) as SourceOutputFile;
    return f.articles ?? [];
  } catch { return []; }
}

function saveOutput(
  username: string,
  date:     string,
  articles: ArticleRecord[],
  stats:    SourceOutputFile['stats'],
): void {
  const dir = join(PATHS.intelligence.outputArticles, date);
  mkdirSync(dir, { recursive: true });
  const file: SourceOutputFile = {
    source_id:    `twitter-${username}`,
    date,
    generated_at: new Date().toISOString(),
    stats,
    articles,
  };
  writeFileSync(outputPath(username, date), JSON.stringify(file, null, 2));
}

// ── Per-account collection ────────────────────────────────────────────────────

async function collectAccount(
  account:  TwitterAccount,
  apiKey:   string,
  date:     string,
): Promise<CollectionResult> {
  const t0        = Date.now();
  const fetchedAt = new Date().toISOString();
  const sourceId  = `twitter-${account.username}`;

  let raw: TweetItem[];
  try {
    logger.info('twitter', `${sourceId}: fetching timeline`);
    raw = await fetchTweets(account.username, apiKey);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('twitter', `${sourceId}: fetch failed — ${msg}`);
    return {
      source_id: sourceId, status: 'failed',
      new_articles: 0, exact_duplicates: 0, syndicated: 0, stale_skipped: 0,
      avg_age_hours: 0, oldest_age_days: 0, stale_feed: false,
      duration_ms: Date.now() - t0, error: msg,
    };
  }

  const existingIds = new Set(loadExistingOutput(account.username, date).map(a => a.id));
  const articles: ArticleRecord[] = [];
  let newCount  = 0;
  let dupeCount = 0;
  let syndCount = 0;
  let staleCount = 0;

  for (const tweet of raw) {
    // Skip retweets (retweeted_tweet present) and replies
    if (tweet.retweeted_tweet !== null || tweet.isReply) continue;

    // Recency filter — same 30-day window as RSS collector
    const ageMs = Date.now() - new Date(tweet.createdAt).getTime();
    if (ageMs > MAX_ARTICLE_AGE_MS) { staleCount++; continue; }

    const record = tweetToArticleRecord(tweet, account, fetchedAt);
    if (!record) continue;

    // Skip articles already in today's output (idempotent re-runs)
    if (existingIds.has(record.id)) { dupeCount++; continue; }

    if (record.lifecycle.dedup_status === 'exact_duplicate') { dupeCount++; continue; }
    if (record.lifecycle.dedup_status === 'syndicated') syndCount++;
    else newCount++;

    articles.push(record);
  }

  // Merge with any previously saved articles from earlier runs today
  const previous = loadExistingOutput(account.username, date)
    .filter(a => !articles.some(n => n.id === a.id));
  const merged = [...previous, ...articles];

  saveOutput(account.username, date, merged, {
    total: merged.length, new_articles: newCount,
    exact_duplicates: dupeCount, syndicated: syndCount, stale_skipped: staleCount,
  });

  const duration_ms = Date.now() - t0;
  logger.info('twitter', `${sourceId}: ${newCount} new / ${dupeCount} dupes / ${staleCount} stale (${duration_ms}ms)`);

  return {
    source_id: sourceId, status: 'ok',
    new_articles: newCount, exact_duplicates: dupeCount,
    syndicated: syndCount, stale_skipped: staleCount,
    avg_age_hours: 0, oldest_age_days: 0, stale_feed: false, duration_ms,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runTwitterCollector(date: string): Promise<CollectionResult[]> {
  const apiKey   = process.env.TWITTERAPI_IO_KEY ?? '';
  const accounts = loadAccounts().filter(a => a.enabled);

  if (!accounts.length) {
    logger.warn('twitter', 'No enabled accounts in accounts.json — skipping');
    return [];
  }

  // Sequential — one account at a time to respect rate limits
  const results: CollectionResult[] = [];
  for (const account of accounts) {
    results.push(await collectAccount(account, apiKey, date));
  }

  const totalNew = results.reduce((s, r) => s + r.new_articles, 0);
  const ok       = results.filter(r => r.status === 'ok').length;
  logger.info('twitter', `Done — ${totalNew} new tweets from ${ok}/${accounts.length} accounts`);
  return results;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsx --check intelligence/twitter/twitter-collector.ts
```

Expected: no output (clean compile). If errors appear, fix them before continuing.

- [ ] **Step 3: Smoke test — load accounts**

```bash
node -e "
import('./intelligence/twitter/twitter-collector.ts').then(m => {
  const accounts = m.loadAccounts();
  console.log('Accounts loaded:', accounts.length);
  accounts.forEach(a => console.log(' -', a.username, '| tier:', a.reliability_tier, '| category:', a.category));
});
"
```

Expected:
```
Accounts loaded: 5
 - RALee85 | tier: 2 | category: analyst
 - HassanIHassan | tier: 2 | category: analyst
 - borzou | tier: 2 | category: reporter
 - MFA_China | tier: 3 | category: official
 - mfa_russia | tier: 3 | category: official
```

- [ ] **Step 4: Smoke test — live API call (requires key in .env)**

```bash
node -e "
import('dotenv/config').then(() =>
  import('./intelligence/twitter/twitter-collector.ts').then(async m => {
    const date = new Date().toISOString().slice(0, 10);
    const results = await m.runTwitterCollector(date);
    console.log('Results:');
    results.forEach(r => console.log(' ', r.source_id, r.status, r.new_articles, 'new'));
  })
);
"
```

Expected: each account logs `ok N new` (N will vary, 0 is fine on re-run). No `failed` statuses. Output files created at `intelligence/outputs/articles/YYYY-MM-DD/twitter-*.json`.

Verify one output file exists and has correct structure:

```bash
node -e "
const fs = require('fs');
const date = new Date().toISOString().slice(0,10);
const files = fs.readdirSync('intelligence/outputs/articles/' + date).filter(f => f.startsWith('twitter-'));
console.log('Twitter output files:', files);
if (files[0]) {
  const f = JSON.parse(fs.readFileSync('intelligence/outputs/articles/' + date + '/' + files[0], 'utf-8'));
  console.log('source_id:', f.source_id);
  console.log('articles:', f.articles.length);
  if (f.articles[0]) console.log('first article:', f.articles[0].title?.slice(0,80));
}
"
```

- [ ] **Step 5: Commit**

```bash
git add intelligence/twitter/twitter-collector.ts
git commit -m "feat: add twitter-collector module for twitterapi.io"
```

---

### Task 3: Wire into collect-articles.ts

**Files:**
- Modify: `scripts/collect-articles.ts`

- [ ] **Step 1: Add import at the top of `scripts/collect-articles.ts`**

After the existing imports (after the `updateCollectionMetrics` import line), add:

```typescript
import { runTwitterCollector } from '../intelligence/twitter/twitter-collector.ts';
```

- [ ] **Step 2: Add Twitter collection block at the end of `scripts/collect-articles.ts`**

After the `updateCollectionMetrics(date, { ... });` call and before the `if (summary.sources_failed > 0 && summary.sources_ok === 0)` block, insert:

```typescript
// ── Twitter collection ────────────────────────────────────────────────────────
if (process.env.TWITTERAPI_IO_KEY) {
  console.log('');
  console.log(B('Twitter / X'));
  console.log('─'.repeat(88));
  const twitterResults = await runTwitterCollector(date);
  for (const r of twitterResults) {
    const icon   = r.status === 'ok' ? G('✓') : R('✗');
    const status = r.status === 'ok' ? G('ok') : R('fail');
    const note   = r.status === 'failed' ? R(`  ${r.error?.slice(0, 50) ?? 'unknown'}`) : '';
    console.log(
      `${icon}  ` +
      padEnd(r.source_id, 28) +
      padEnd(status, 10) +
      padEnd(r.status === 'ok' ? String(r.new_articles) : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.exact_duplicates) : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.syndicated) : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.stale_skipped) : '—', 8) +
      D(`${r.duration_ms}ms`) +
      note,
    );
  }
  console.log('─'.repeat(88));
  const twitterNew = twitterResults.reduce((s, r) => s + r.new_articles, 0);
  console.log(`${G(String(twitterNew) + ' new')}  |  ${twitterResults.filter(r => r.status === 'ok').length} accounts ok`);
  console.log('');
} else {
  logger.warn('collect', 'TWITTERAPI_IO_KEY not set — Twitter collection skipped');
}
```

- [ ] **Step 3: Add `TWITTERAPI_IO_KEY` to `.env`**

Open `.env` and add:

```
TWITTERAPI_IO_KEY=your_regenerated_key_here
```

Replace `your_regenerated_key_here` with the key you regenerated at twitterapi.io after the old one was exposed.

- [ ] **Step 4: Run `npm run collect` end-to-end**

```bash
npm run collect
```

Expected output — the existing RSS table appears as before, then a new `Twitter / X` section:
```
Twitter / X
────────────────────────────────────────────────────────────────────────────────────────
✓  twitter-RALee85              ok        3       0       0       0       …ms
✓  twitter-HassanIHassan        ok        1       0       0       0       …ms
✓  twitter-borzou               ok        2       0       0       0       …ms
✓  twitter-MFA_China            ok        0       2       0       17      …ms
✓  twitter-mfa_russia           ok        1       0       0       5       …ms
────────────────────────────────────────────────────────────────────────────────────────
7 new  |  5 accounts ok
```

(Exact numbers vary. All statuses should be `ok`.)

- [ ] **Step 5: Verify tweets flow into scoring**

Run scoring against today's date and confirm twitter articles appear:

```bash
npm run score
node -e "
const fs = require('fs');
const date = new Date().toISOString().slice(0, 10);
const dir  = 'intelligence/outputs/articles/' + date;
const files = fs.readdirSync(dir).filter(f => f.startsWith('twitter-'));
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf-8'));
  const scored = data.articles.filter(a => a.scoring);
  console.log(f + ': ' + scored.length + '/' + data.articles.length + ' scored');
  scored.filter(a => a.scoring?.recommended_for_ai).forEach(a =>
    console.log('  RECOMMENDED:', a.title?.slice(0, 70), '| score:', a.scoring?.total_score)
  );
}
"
```

Expected: all articles have `scoring` populated. Any that reached score ≥ 25 appear under `RECOMMENDED`. Tier-3 accounts (MFA_China, mfa_russia) scoring ≥ 25 will show `cross_reference_required: true` after the reporter runs.

- [ ] **Step 6: Run full observe to confirm end-to-end**

```bash
npm run observe
```

Confirm: no errors, Twitter articles that scored high enough appear in today's events output, Tier-3 account events are flagged `human_review_required: true`.

- [ ] **Step 7: Commit**

```bash
git add scripts/collect-articles.ts .env
git commit -m "feat: wire Twitter collector into npm run collect"
```

---

## Done

Twitter is now a live daily-batch source. To add or remove accounts, edit `intelligence/twitter/accounts.json` — no code changes needed. To upgrade to real-time webhook processing later, implement a webhook receiver that calls `collectAccount` directly; `runTwitterCollector` and all downstream logic stay unchanged.
