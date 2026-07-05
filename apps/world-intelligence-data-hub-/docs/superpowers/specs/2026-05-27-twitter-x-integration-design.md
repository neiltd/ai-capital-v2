# Twitter / X Integration — Design Spec
**Date:** 2026-05-27
**Status:** Approved

---

## Scope

Add X (Twitter) as a daily-batch intelligence source. Monitored accounts are fetched once per day as part of `npm run observe`. Tweets flow through the existing pipeline — `score → report → dedup → link → export` — unchanged. No new pipeline logic.

**Out of scope:**
- Real-time webhook processing (deferred — architecture is migration-friendly)
- Write actions (posting, liking)
- Follower/following graph analysis

---

## API Provider

**twitterapi.io** — third-party X data API.

- Auth: API key (`TWITTERAPI_IO_KEY` in `.env`)
- Cost: $0.15 per 1,000 tweets — estimated under $0.10/month for 20 accounts at daily cadence
- Endpoints used: user timeline (last 48h per account)
- No X developer account required

---

## Architecture

```
intelligence/twitter/accounts.json        ← curated account list (user-editable)
intelligence/ingestion/twitter-collector.ts  ← new collector module

Daily flow (part of npm run observe):
  collect-articles.ts
    ├── rss-collector.ts   (existing, unchanged)
    └── twitter-collector.ts (new)
          ↓ writes intelligence/outputs/articles/YYYY-MM-DD/twitter-{username}.json
  score → report → dedup → link → export  (all unchanged)
```

The twitter collector is transparent to all downstream pipeline stages. Output files are in the same `ArticleRecord` format as RSS collector output.

---

## Account List — `intelligence/twitter/accounts.json`

Array of account objects. User adds/removes entries directly. The collector skips `enabled: false` accounts without fetching.

```json
[
  {
    "username": "string — X handle without @",
    "display_name": "string — human-readable name",
    "category": "analyst | reporter | official",
    "reliability_tier": 2,
    "region_focus": ["string — ISO region or country name"],
    "topics": ["string — topic keywords"],
    "notes": "string — why this account is monitored",
    "enabled": true
  }
]
```

**Tier assignment:**
- `analyst`, `reporter` → Tier 2 (treated like Al Jazeera or DW — credible but verify)
- `official` → Tier 3 (narrative track — events flagged `cross_reference_required: true`, same as Global Times)

---

## Collector Behavior — `intelligence/ingestion/twitter-collector.ts`

### What is fetched
- Tweets published in the last **48 hours** per account (daily runs only need yesterday's content; the existing 30-day stale filter catches anything older)
- **Included:** original tweets, quote tweets (quoted text appended to body)
- **Excluded:** retweets (not original content), replies (conversational)

### ArticleRecord mapping

| Field | Value |
|---|---|
| `id` | `tweet-{tweet_id}` |
| `title` | First 100 chars of tweet text |
| `description` | Full tweet text |
| `content` | Full tweet text + quoted tweet text (if quote tweet) |
| `url` | `https://x.com/{username}/status/{tweet_id}` |
| `published_at` | Tweet `created_at` (ISO-8601) |
| `source_id` | `twitter-{username}` |
| `source_name` | Account `display_name` from accounts.json |
| `reliability_tier` | Per-account value from accounts.json |

### Output
One file per account: `intelligence/outputs/articles/YYYY-MM-DD/twitter-{username}.json`
Same structure as RSS collector output (`{ source_id, date, generated_at, stats, articles[] }`).

### Error handling
If twitterapi.io returns an error for one account, log a warning and continue to the next account — same non-fatal pattern as stale RSS feeds. If `TWITTERAPI_IO_KEY` is absent, skip Twitter collection entirely with a single warning log.

---

## Pipeline Integration

### `scripts/collect-articles.ts` change
After the RSS collection loop, add:

```typescript
if (process.env.TWITTERAPI_IO_KEY) {
  await runTwitterCollector(date);
} else {
  logger.warn('collector', 'TWITTERAPI_IO_KEY not set — Twitter collection skipped');
}
```

### `lib/paths.ts` addition
```typescript
twitter: {
  root:     join(ROOT, 'intelligence', 'twitter'),
  accounts: join(ROOT, 'intelligence', 'twitter', 'accounts.json'),
},
```

### `.env`
```
TWITTERAPI_IO_KEY=your_key_here
```

### No new npm scripts
Twitter collection runs transparently inside `npm run collect`. No separate command needed.

---

## New Files

| Path | Purpose |
|---|---|
| `intelligence/twitter/accounts.json` | Curated account list |
| `intelligence/ingestion/twitter-collector.ts` | Collector module |

## Modified Files

| Path | Change |
|---|---|
| `scripts/collect-articles.ts` | Call `runTwitterCollector` when key is present |
| `lib/paths.ts` | Add `intelligence.twitter` paths |

---

## Migration Path to Real-Time (Future)

When upgrading to webhook-based real-time processing:
1. Add a webhook receiver server (HTTP endpoint, publicly accessible)
2. Register monitored accounts with twitterapi.io webhook
3. Webhook handler calls the same processing functions already used by the batch collector
4. No changes to scoring, dedup, extraction, or export logic

The batch collector and the webhook handler share the same `ArticleRecord` conversion logic — extraction is already isolated in `twitter-collector.ts`.
