# AI-Powered News Paste Intake — Design Spec

**Date:** 2026-07-01  
**App:** `apps/capital-intelligence-ingestion`  
**Command:** `npm run paste`

---

## Problem

`npm run add` requires the user to manually specify `--ticker` and `--company`. When you find a news snippet (TradingView, Thai digest, Reuters paragraph, any format), you have to:
1. Identify the ticker(s) yourself
2. Run a separate command per ticker if the story touches multiple companies

This friction means news that should inform the investment thesis often doesn't get ingested.

---

## Solution

A single command that accepts any freeform text and uses Claude to extract structured metadata automatically:

```bash
pbpaste | npm run paste
```

Works on any input format: Thai-language digests, English articles, TradingView blurbs, multi-story digests, single sentences.

---

## Architecture

### New file: `src/intake/cli-paste.ts`

**Input:** stdin (the copied text), piped via `pbpaste | npm run paste`

**Steps:**

1. Read full stdin content
2. Call Claude API (`claude-haiku-4-5` — cheap, fast, sufficient for extraction)
3. Parse structured extraction result
4. Write one drop file + `.meta.json` per `(story × ticker)` pair into `intake/drop/`
5. Print summary table, remind user to run `npm run pipeline`

### Claude extraction prompt

Returns a JSON array of stories:

```json
[
  {
    "tickers": ["NVDA", "MSFT"],
    "headline": "OpenAI cuts inference cost by 50% via software optimization",
    "impact": "Reduces near-term GPU demand; negative for NVDA datacenter; MSFT benefits from lower OpenAI operating costs",
    "doc_type": "article"
  },
  {
    "tickers": ["MACRO"],
    "headline": "Meituan open-sources LongCat-2.0 trained on Huawei chips",
    "impact": "Proves China can pre-train large models on domestic hardware without NVIDIA",
    "doc_type": "article"
  }
]
```

**Ticker rules for Claude:**
- Use watchlist tickers when a known company is mentioned (`AAPL`, `GOOGL`, `RKLB`, etc.)
- For companies with no obvious ticker (private, Chinese, etc.), use `MACRO` as the ticker
- Multi-company stories → list all relevant tickers; story will be written once per ticker
- Relate implied impact too: an OpenAI cost-cut story isn't just about OpenAI — it impacts `NVDA`

### Drop file format

For a story touching `AAPL` and `GOOGL`, two files are written:

```
intake/drop/AAPL-paste-1751380000000-0.txt
intake/drop/AAPL-paste-1751380000000-0.txt.meta.json
intake/drop/GOOGL-paste-1751380000000-0.txt
intake/drop/GOOGL-paste-1751380000000-0.txt.meta.json
```

Content of each `.txt`:
```
[Paste Intake] 2026-07-01T10:00:00Z
Tickers: AAPL, GOOGL

UK CMA proposes forcing Apple to open NFC access...
[impact] App Store revenue risk in UK market. Google already compliant.
```

Content of `.meta.json`:
```json
{
  "ticker": "AAPL",
  "company": "AAPL",
  "doc_type": "article",
  "tags": ["paste", "multi-ticker"],
  "related_tickers": ["GOOGL"]
}
```

### No-ticker fallback

If Claude finds no tickers and can't assign `MACRO` meaningfully, write one file tagged `MACRO` so the content remains searchable.

---

## New script in `package.json`

```json
"paste": "tsx src/intake/cli-paste.ts"
```

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Empty stdin | Exit with usage hint |
| Claude API error | Exit with error; no drop files written |
| Claude returns invalid JSON | Retry once with stricter prompt; if still invalid, exit |
| Story with no tickers extracted | Assign `MACRO` |

---

## Out of scope

- Automatic `npm run pipeline` trigger after paste (user runs it manually; keeps control over when ingest happens)
- Deduplication within a single paste session (pipeline's existing dedup handles this)
- URL fetching (use `npm run add -- --url=...` for that)
