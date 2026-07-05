# World Intelligence Data Hub

Shared ingestion backbone for geopolitical and energy intelligence.
Pulls from external APIs once, stores normalized data, and exports
project-specific slices. Downstream projects read exported JSON — they
never call APIs directly.

## Architecture

```
External APIs
  → ingestion/clients/      one client per source, one fetch per TTL
  → store/raw/              immutable dated snapshots
  → processing/normalizers/ typed clean records
  → processing/validators/  schema enforcement
  → store/validated/        source of truth
  → exports/{project}/      filtered slices for each consumer
```

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with real credentials (never commit .env)
```

## Credentials

| Source | Auth | Where to get |
|--------|------|--------------|
| NewsAPI | API key | newsapi.org — free 100 req/day |
| ACLED | OAuth2 (user/pass) | acleddata.com — free 10k req/month |
| EIA | API key | eia.gov/opendata — free 1k req/day |
| GDELT | None | Free, no registration |
| World Bank | None | Free, no registration |

## Commands

```bash
# Validate credentials before first run (recommended)
npm run validate

# Run full pipeline (all sources)
npm run pipeline

# Run a single source
npm run pipeline -- newsapi
npm run pipeline -- acled
npm run pipeline -- eia
npm run pipeline -- gdelt
npm run pipeline -- worldbank

# Start continuous scheduler (GDELT every 15min, others on their cadence)
npm run schedule

# Backfill historical data for a source
npm run backfill -- --source=acled --from=2026-01-01 --to=2026-05-01

# Compress raw snapshots older than 7 days
npm run compress

# Dry run with synthetic data (no API keys needed)
npm run dry-run
```

## Exports

After each pipeline run, project-specific files are written to `exports/`:

| File | Consumer | Contents |
|------|----------|----------|
| `exports/world-map/events.json` | world-intelligence-map | All events, last 30 days, sorted by severity |
| `exports/oil-project/oil-events.json` | world-intelligence-oil | Events in oil-producing countries only |
| `exports/oil-project/energy-indicators.json` | world-intelligence-oil | WTI/Brent prices, production data |
| `exports/stock-project/macro-indicators.json` | future stock project | GDP, inflation, interest rates |
| `exports/manifest.json` | all | SHA-256 checksums + record counts |

Every export file has this envelope:

```json
{
  "meta": {
    "schemaVersion": "1.0",
    "generatedAt": "...",
    "sourceVersions": { "newsapi": "...", "acled": "..." },
    "recordCount": 123,
    "breaking": false,
    "staleSourcesPresent": false
  },
  "data": [ ... ]
}
```

Consumers should check `meta.schemaVersion` on startup and warn if `meta.staleSourcesPresent` is true.

## Adding a new source

1. `ingestion/clients/mysource.ts` — implement `SourceClient` (`name` + `fetch()`)
2. `quota/quota-tracker.ts` — add entry to `SOURCE_CONFIGS`
3. `processing/normalizers/` — add a normalizer function
4. `ingestion/pipelines/pipeline.ts` — add case to `normalizeRaw()` switch
5. `run.ts` — add `new MySourceClient()` to `ALL_CLIENTS`

## Security notes

- `.env` is git-ignored and must never be committed
- API keys and OAuth tokens are never written to logs or raw files
- ACLED OAuth tokens live in process memory only (never serialized to disk)
- Raw API error bodies are truncated before logging to prevent credential echo

---

## Intelligence Layer (added post-baseline)

The intelligence layer sits above the raw ingestion pipeline and adds
AI-assisted extraction, scoring, deduplication, storyline continuity,
and structured exports. It uses only RSS feeds (no proprietary APIs)
and the Anthropic Claude API for event extraction.

### Intelligence pipeline

```
npm run observe
  = collect → score → report → dedup → link → export → metrics
```

| Command | What it does |
|---------|-------------|
| `npm run collect` | Fetch RSS feeds from 13 sources, apply 30-day recency filter |
| `npm run score` | Score articles for geopolitical relevance (threshold 35/100) |
| `npm run report` | AI extraction via Claude (extractor-v2, reporter-v1.1) |
| `npm run dedup` | Same-day event deduplication (deterministic, Jaccard similarity) |
| `npm run link` | Cross-day storyline continuity (deterministic scoring, no AI) |
| `npm run export` | Write stable JSON exports for downstream projects |
| `npm run metrics` | Show operational dashboard |

### Intelligence exports (schema_version: 1.0)

Each export is a stable JSON file with explicit provenance labels.
Downstream projects read ONLY from `exports/` — never from `intelligence/`.

| File | Consumer | Key fields |
|------|----------|------------|
| `exports/world-map/intelligence.json` | world-intelligence-map | events, storylines, country_signals |
| `exports/oil-project/intelligence.json` | world-intelligence-oil | hormuz_risk, energy_events, commodity_signals |
| `exports/stock-project/intelligence.json` | future stock project | market_events, macro_risk_signals, sector_exposure |
| `exports/manifest.json` | all | discovery index, dates, event counts |

All exports include: `schema_version`, `generated_at`, `extraction_version`,
`event_count`, `review_excluded_count`, `unique_source_count`.

### Intelligence RSS sources

13 sources in 3 reliability tiers:

| Tier | Sources |
|------|---------|
| 1 (highest) | BBC World, NYT World, Bloomberg Markets, NPR News, DW World, Washington Post World |
| 2 | Al Jazeera English, France24 English, SCMP China |
| 3 (state media — narrative track) | Xinhua English, Global Times |
| Local (filtered) | Bangkok Post, Khaosod English |

### Calibration

Calibration documents are tracked in git under `intelligence/calibration/`:

| File | Purpose |
|------|---------|
| `CALIBRATION.md` | Scoring calibration log, threshold history, extraction quality |
| `calibration-state.json` | Machine-readable thresholds, checklist, live run log |
| `STORYLINE_OBSERVATIONS.md` | Multi-day storyline behavior observations |
| `TAXONOMY_NOTES.md` | Event type taxonomy drift and classification notes |

Daily metrics are tracked in `intelligence/metrics/YYYY-MM-DD.json`
(intentionally committed — the history calibrates extraction quality).

---

## Stable Milestone — 2026-05-13

**7-run calibration completed.** All pre-memory-agent checklist criteria met.
Pipeline is in extended observation mode.

### What works

**Calibrated extraction pipeline** (`extractor-v2`, `reporter-v1.1`)
- Recommendation threshold: 35/100 (lowered from 40 after false-negative analysis)
- Narrative monitoring track: Tier 3 state media at threshold 25
- 7-run calibration: avg confidence 0.75, cache hit rate 54%, zero false positives
- Human review rate trending from 50% (Run #1) → 0% (Runs #6–7)
- event_id stability verified: re-extractions consistently match existing IDs

**Same-day event deduplication** (`intelligence/dedup/`)
- Deterministic Jaccard similarity on event titles (threshold 0.25)
- Type-specific continuity rules (natural_disaster isolation, military/diplomatic separation)
- 0 bad merges across all observed runs
- Idempotent: safe to run multiple times per day

**Cross-day storyline continuity** (`intelligence/storylines/`)
- 7 storylines emerged on Day 1 from 42 events
- Observation signals: persistence_rate, cohesion_signal, gravity_links, fragmentation, branching
- Daily snapshots in `intelligence/outputs/storylines/snapshots/` for cross-day diff
- Match scoring: country(+3) + actor(+2) + type_exact(+3)/family(+1) + title_sim(+2) + temporal(+1)
- Threshold: 5 — requires at least two strong signals to link

**Export interface layer** (`intelligence/exports/`, `exports/`)
- Three stable consumer exports (schema_version: 1.0)
- All exports include provenance labels and `review_excluded_count`
- `event_id` and `storyline_id` preserved for drilldown linking
- Export runner auto-copies to sibling frontend `public/data/` directories
- Schema stability guaranteed: fields only added (never renamed/removed) within a version

**Frontend integrations**
- `worldmaphistory_v1`: Intelligence panel (Storylines / Countries / Events tabs)
- `world-intelligence-oil`: Hormuz risk panel + energy events + commodity signals
- Both connected to exports only — zero coupling to Data Hub internals

### Current observation state

Pipeline is in **extended real-world observation mode** as of 2026-05-13.
Do not add memory-agent, graph DB, or AI continuity reasoning until
multi-day narrative patterns have been observed across real calendar days.

Observation mandate: `intelligence/calibration/STORYLINE_OBSERVATIONS.md`
