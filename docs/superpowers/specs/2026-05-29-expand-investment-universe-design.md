# Expand Investment Universe Design

## Goal

Add 8 companies across 2 new themes — `financials` (JPM, BAC, GS) and `healthcare` (LLY, UNH, JNJ, ABBV, MRNA) — to the full thesis-tracking pipeline. Financials update daily; healthcare updates weekly to control cost. New tickers in either theme get added via a CLI command and are automatically picked up by all downstream engines.

## Architecture

No new projects. Changes across 3 existing projects:

1. **capital-intelligence-ingestion** — register companies, add frequency field
2. **thesis-memory** — respect per-company update frequency
3. **dependency-graph-engine** — add new nodes and cross-theme edges

The capital-intel-dashboard requires no code changes — it reads JSON exports and will automatically surface new companies in Portfolio, Briefing, and Graph pages once data is present.

## New Companies

### Theme: `financials` — daily thesis updates

| Ticker | Company | CIK | Why Watch |
|--------|---------|-----|-----------|
| JPM | JPMorgan Chase | 0000019617 | Largest US bank; investment banking barometer |
| BAC | Bank of America | 0000070858 | Consumer banking proxy; rate sensitivity bellwether |
| GS | Goldman Sachs | 0000886982 | Risk appetite signal; M&A and IPO pipeline health |

### Theme: `healthcare` — weekly thesis updates (7-day cadence)

| Ticker | Company | CIK | Why Watch |
|--------|---------|-----|-----------|
| LLY | Eli Lilly | 0000059478 | GLP-1/Ozempic race; biggest pharma story of the decade |
| UNH | UnitedHealth Group | 0000731766 | Largest US health insurer; US healthcare system health |
| JNJ | Johnson & Johnson | 0000200406 | Diversified healthcare anchor; MedTech + pharma |
| ABBV | AbbVie | 0001551152 | Post-Humira pivot; aesthetics (Botox); strong pipeline |
| MRNA | Moderna | 0001682852 | mRNA platform beyond COVID; AI + biology intersection |

**Future additions:** Any new ticker in `financials` or `healthcare` is added via `npm run watchlist -- add --ticker=XYZ --theme=financials --freq=1` (or `--freq=7` for healthcare). No other changes needed — ingestion and thesis-memory pick it up automatically on the next scheduled run.

## Component Changes

### 1. capital-intelligence-ingestion

**Schema change — `watchlist` table:**
Add `thesis_update_days INTEGER NOT NULL DEFAULT 1` column. Existing companies get default of 1 (daily, preserving current behavior).

**New CLI — `src/intake/cli-watchlist.ts`:**
```
npm run watchlist -- add --ticker=JPM --company="JPMorgan Chase" --theme=financials --cik=0000019617 --freq=1
npm run watchlist -- list
npm run watchlist -- remove --ticker=JPM
```

`add` calls `store.upsertCompany()` with the provided fields plus `newsSearchTerms` auto-generated as `[ticker, company name]`. `list` prints all active companies with their themes and frequencies. `remove` sets `active=false`.

**`Company` type addition:**
```typescript
interface Company {
  // ... existing fields ...
  thesisUpdateDays: number  // 1 = daily, 7 = weekly
}
```

**`getActiveCompanies()` updated** to include `thesisUpdateDays` in the returned object.

**package.json addition:**
```json
"watchlist": "tsx src/intake/cli-watchlist.ts"
```

### 2. thesis-memory

**`src/cli/update.ts` change:**
Before calling the analyzer for a company, check:
```typescript
const daysSinceUpdate = (Date.now() - new Date(thesis.updatedAt).getTime()) / 86_400_000
if (daysSinceUpdate < company.thesisUpdateDays) {
  console.log(`[skip] ${ticker}: updated ${daysSinceUpdate.toFixed(1)}d ago, next in ${(company.thesisUpdateDays - daysSinceUpdate).toFixed(1)}d`)
  continue
}
```

`company.thesisUpdateDays` is read from capital-intelligence-ingestion's SQLite DB (already on disk at `../capital-intelligence-ingestion/data/sqlite.db`). The ingestion reader already accesses this DB — extend it to also read `thesis_update_days`.

**`src/store/sqlite.ts` change in ingestion-reader:**
Add `thesisUpdateDays` to the row mapping in `getActiveCompanies()`.

### 3. dependency-graph-engine

Add 8 new nodes to `data/graph.json`:

```json
{ "ticker": "JPM", "company": "JPMorgan Chase", "themes": ["financials"] },
{ "ticker": "BAC", "company": "Bank of America", "themes": ["financials"] },
{ "ticker": "GS",  "company": "Goldman Sachs",   "themes": ["financials"] },
{ "ticker": "LLY", "company": "Eli Lilly",        "themes": ["healthcare"] },
{ "ticker": "UNH", "company": "UnitedHealth",     "themes": ["healthcare"] },
{ "ticker": "JNJ", "company": "Johnson & Johnson","themes": ["healthcare"] },
{ "ticker": "ABBV","company": "AbbVie",           "themes": ["healthcare"] },
{ "ticker": "MRNA","company": "Moderna",          "themes": ["healthcare"] }
```

Add cross-theme edges:
- `JPM → NVDA` (type: `customer`, strength: `moderate`) — JPM is a major AI infrastructure spender; NVDA supplies the compute
- `GS → MSFT` (type: `customer`, strength: `weak`) — Goldman uses Azure/OpenAI for internal tooling
- `LLY → MRNA` (type: `competitive`, strength: `moderate`) — competing mRNA-based drug platforms
- `MRNA → NVDA` (type: `customer`, strength: `weak`) — AI-accelerated drug discovery
- `UNH → JNJ` (type: `customer`, strength: `moderate`) — insurer/provider relationship

## Initial Data Bootstrap

After code changes are deployed, run in order:

```bash
# 1. Register all 8 companies
cd capital-intelligence-ingestion
npm run watchlist -- add --ticker=JPM --company="JPMorgan Chase" --theme=financials --cik=0000019617 --freq=1
npm run watchlist -- add --ticker=BAC --company="Bank of America" --theme=financials --cik=0000070858 --freq=1
npm run watchlist -- add --ticker=GS  --company="Goldman Sachs"   --theme=financials --cik=0000886982 --freq=1
npm run watchlist -- add --ticker=LLY --company="Eli Lilly"       --theme=healthcare --cik=0000059478 --freq=7
npm run watchlist -- add --ticker=UNH --company="UnitedHealth"    --theme=healthcare --cik=0000731766 --freq=7
npm run watchlist -- add --ticker=JNJ --company="Johnson & Johnson" --theme=healthcare --cik=0000200406 --freq=7
npm run watchlist -- add --ticker=ABBV --company="AbbVie"         --theme=healthcare --cik=0001551152 --freq=7
npm run watchlist -- add --ticker=MRNA --company="Moderna"        --theme=healthcare --cik=0001682852 --freq=7

# 2. Fetch initial documents for all 8
npm run pipeline

# 3. Create initial theses (thesis-memory)
cd ../thesis-memory
npm run thesis -- create JPM
npm run thesis -- create BAC
npm run thesis -- create GS
npm run thesis -- create LLY
npm run thesis -- create UNH
npm run thesis -- create JNJ
npm run thesis -- create ABBV
npm run thesis -- create MRNA
```

## Cost Impact

| State | Monthly Estimate |
|-------|-----------------|
| Before (21 companies, all daily) | ~$5–9/mo |
| After (29 companies, healthcare weekly) | ~$6.50–11/mo |
| Savings from weekly healthcare vs daily | ~$1.50/mo |

The `thesisUpdateDays` field applies to all future companies too — any new ticker added with `--freq=7` costs ~half as much as a daily-tracked company.
