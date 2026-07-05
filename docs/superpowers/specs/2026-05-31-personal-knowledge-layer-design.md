# Personal Knowledge Layer Design

## Goal

Add a personal notes layer and interactive thesis brainstorm CLI to the existing investment intelligence system. Captures the investor's own thinking alongside market data, completing the compounding knowledge loop described in the "knowledge base first" framework.

## Architecture

Two targeted extensions to existing projects. No new projects.

### Extension 1: `capital-intelligence-ingestion` — Personal Notes

Adds a personal note as a first-class document type alongside SEC filings, transcripts, and news. Notes embed with the same local HuggingFace model (free) and land in LanceDB — so they surface automatically in `/api/ask`, daily briefings, and the brainstorm session.

### Extension 2: `thesis-memory` — Brainstorm CLI

A multi-turn terminal session where the investor shares their thinking about a company, Claude pushes back with grounded questions, and the session ends with real thesis legs committed to `thesis-memory`. The entire conversation uses the Claude Code subscription (free). Only the final synthesis step calls the Anthropic API (one Sonnet call per session, ~$0.01).

---

## Data Model

### New types in `capital-intelligence-ingestion/src/types.ts`

```typescript
// Add to SourceType union:
'personal_note'

// Add to DocType union:
'note'

// Note subtypes (stored in content frontmatter, not in the type system):
type NoteType = 'trade_rationale' | 'thesis_observation' | 'market_thought' | 'post_trade' | 'journal'
```

### Note file format

Markdown files with YAML frontmatter, stored in `capital-intelligence-ingestion/intake/personal-notes/`:

```markdown
---
ticker: ARM
type: trade_rationale
date: 2026-05-31
---

I bought ARM because I believe x86 displacement in the data center is
underpriced by the market. Every new AI chip still uses ARM ISA as the
base architecture...
```

`ticker` is optional — a note can be a general market observation with no ticker.

---

## Personal Notes: Three Capture Paths

All three paths ultimately produce a markdown file in `intake/personal-notes/` and trigger local embedding. No API cost.

### Path 1: File Drop

Drop any `.md` file with the frontmatter above into `intake/personal-notes/`. The existing pipeline picks it up on the next run.

### Path 2: CLI (quick capture)

New script in `capital-intelligence-ingestion/package.json`:

```bash
npm run note -- --ticker ARM --type trade_rationale "I bought because x86 displacement is underpriced"
```

Writes the markdown file and immediately embeds it (no waiting for the next pipeline run). `--ticker` and `--type` are optional; omitting them creates a journal entry.

Implementation: `src/cli/cli-note.ts`
- Parses `--ticker`, `--type`, and the remaining text as content
- Writes to `intake/personal-notes/<ticker>-<type>-<date>.md` (or `journal-<date>.md` if no ticker)
- Calls `createLanceStore` + `createEmbedder` directly to embed immediately
- Marks in SQLite with `source: 'personal_note'`

### Path 3: Dashboard Form

New page in `capital-intel-dashboard`: `/notes`

New API route: `POST /api/notes` with body `{ ticker?: string, type: NoteType, content: string }`

The API route writes the markdown file to `DATA_ROOT/capital-intelligence-ingestion/intake/personal-notes/`. The note is available in search after the next pipeline run (daily cron). For immediate embedding, use the CLI instead.

UI: Simple form with ticker input (optional), type selector, and a textarea. Shows recent personal notes below the form.

---

## Brainstorm CLI

### Command

```bash
cd /Users/thanapold/Desktop/Projects/thesis-memory
npm run brainstorm -- --ticker ARM
```

### Session flow

```
Loading ARM context... 14 documents found (earnings, filings, news, notes)

Thesis brainstorm for ARM. Share your thinking — I'll push back with
questions grounded in what the company has actually said.
Type 'done' to commit thesis legs. Ctrl+C to exit without saving.

──────────────────────────────────────────────────────────────
You: I think ARM is well positioned for AI chip demand because
     every new accelerator uses ARM ISA...

Claude: That's a real tailwind. But ARM's royalty is per-chip,
        and hyperscalers are designing custom silicon to reduce
        per-unit cost. How does your thesis hold if Nvidia and
        Google negotiate lower royalty rates at volume?

You: The rate compression is real but volume growth offsets it.
     Plus the v9 architecture adds a mandatory premium tier...

Claude: Good — the v9 uplift is concrete. What has to be true
        for the volume thesis to break? RISC-V adoption above
        what threshold changes your view?

[... continues ...]

You: done

Synthesizing thesis legs from your conversation...
```

One Anthropic Sonnet call at this point with:
- The full conversation transcript
- Key excerpts from the company's LanceDB documents as grounding evidence
- Instruction to produce 3-5 thesis legs with supporting evidence

```
ARM Thesis Draft
────────────────
Leg 1: AI royalty volume expansion
  Thesis: Hyperscaler design win cycle drives unit volume that offsets rate compression
  Evidence: Q3 FY26 transcript — "royalty revenue up 37% YoY driven by AI inference deployments"
  Weakens if: Custom RISC-V adoption exceeds 15% of new AI chip tapeouts

Leg 2: v9 architecture pricing power
  Thesis: Mandatory v9 migration for ARMv9 devices adds ~$0.10 royalty premium per chip
  Evidence: Analyst day 2025 — confirmed v9 blended ASP uplift of 8-12%
  Weakens if: Hyperscalers negotiate exemptions at volume thresholds

Leg 3: x86 displacement multi-year tailwind
  Thesis: Data center CPU migration from x86 to ARM is a 5-7 year secular shift
  Evidence: AWS Graviton, Microsoft Cobalt, Google Axion all in production
  Weakens if: Intel recaptures efficiency gap with new process node

Save these 3 legs to thesis-memory? (y/n): y

✓ 3 legs saved to thesis-memory for ARM
✓ Session transcript saved as personal note (ARM, type: thesis_observation)
```

### Implementation

New file: `thesis-memory/src/cli/cli-brainstorm.ts`

- Uses Node.js `readline` for interactive terminal input
- Maintains `messages: { role, content }[]` array in memory — no API calls during conversation
- Loads company LanceDB chunks at start via `createLanceStore().filterByTicker(ticker)`
- On `done`: one `Anthropic.messages.create()` call with:
  - `model: 'claude-sonnet-4-6'`
  - System prompt: company context + instruction to extract thesis legs
  - Messages: full conversation transcript
- Parses legs from response and saves to thesis-memory SQLite
- Saves transcript as personal note via the ingestion CLI

---

## Cost Efficiency: 4 Built-In Methods

These are implemented alongside the notes layer, not separately.

### 1. Prompt Caching in Briefing Agent

**Where:** `investment-analyst-agents/src/briefing/briefing-agent.ts`

**Change:** Add `cache_control: { type: "ephemeral" }` to the stable portions of the system prompt — specifically the investor profile and watchlist section, which doesn't change daily.

**Impact:** Anthropic charges 10% of the normal input token price for cache reads. The briefing system prompt is ~2,000–4,000 tokens. Running daily, this saves ~80% of system prompt cost.

```typescript
// Before:
{ role: 'user', content: systemPrompt }

// After:
{
  role: 'user',
  content: [
    {
      type: 'text',
      text: stableProfileSection,
      cache_control: { type: 'ephemeral' },  // cached across calls
    },
    {
      type: 'text',
      text: dynamicDailyContext,  // not cached — changes every day
    }
  ]
}
```

### 2. Model Tiering Enforcement

**Where:** All projects with Claude API calls.

| Task | Current (assumed) | Target |
|------|------------------|--------|
| Daily briefing synthesis | Sonnet | Sonnet ✓ |
| Thesis leg update relevance check | Sonnet | Haiku |
| News article pre-filter | — (not yet) | Haiku |
| Wave narratives | Haiku | Haiku ✓ |
| Scenario action narratives | Haiku | Haiku ✓ |
| Brainstorm final synthesis | — (new) | Sonnet |
| Regime analysis | Sonnet | Sonnet ✓ |

### 3. Conditional Skip in Thesis Update

**Where:** `thesis-memory/src/cli/cli-update.ts` (or equivalent)

**Change:** Before running a thesis update for a ticker, query `fetch_log` in `capital-intelligence-ingestion/data/sqlite.db`:

```sql
SELECT SUM(doc_count) FROM fetch_log
WHERE ticker = ? AND fetched_at >= datetime('now', '-1 day')
```

If result is 0, skip the Claude call for that ticker entirely. Log `[thesis-memory] SKIP ARM — no new documents`.

**Impact:** On low-news days, could skip 50–80% of thesis update calls.

### 4. News Pre-Filter Before Embedding

**Where:** `capital-intelligence-ingestion/src/pipeline.ts` — after news fetch, before `processDocuments()`

**Change:** For each news article, make one Haiku call:

```typescript
const relevant = await haiku.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 5,
  messages: [{
    role: 'user',
    content: `Is this article materially relevant to ${company}'s business fundamentals? Answer only yes or no.\n\n${article.content.slice(0, 500)}`
  }]
})
if (!relevant.content[0].text.toLowerCase().startsWith('yes')) continue
```

**Cost:** ~$0.0001 per article. Saves embedding + LanceDB storage on noise articles.
**Impact:** Estimated 30–50% reduction in articles embedded, keeping LanceDB focused.

---

## File Map

| File | Project | Action |
|------|---------|--------|
| `src/types.ts` | `capital-intelligence-ingestion` | Add `'personal_note'` to SourceType, `'note'` to DocType |
| `src/cli/cli-note.ts` | `capital-intelligence-ingestion` | New — quick note capture CLI |
| `intake/personal-notes/.gitkeep` | `capital-intelligence-ingestion` | New — create folder |
| `package.json` | `capital-intelligence-ingestion` | Add `"note"` script |
| `src/app/notes/page.tsx` | `capital-intel-dashboard` | New — notes page UI |
| `src/app/api/notes/route.ts` | `capital-intel-dashboard` | New — POST endpoint |
| `src/cli/cli-brainstorm.ts` | `thesis-memory` | New — brainstorm CLI |
| `package.json` | `thesis-memory` | Add `"brainstorm"` script |
| `src/briefing/briefing-agent.ts` | `investment-analyst-agents` | Add prompt caching |
| `src/pipeline.ts` | `capital-intelligence-ingestion` | Add news pre-filter |
| `src/cli/cli-update.ts` (or equiv) | `thesis-memory` | Add conditional skip |

---

## What This Enables

Once built, the compounding loop is complete:

```
Your thoughts (notes + brainstorm)
        ↓
LanceDB knowledge base
        ↓
Daily briefing + /ask + thesis evaluation
        ↓
New insights → more notes → richer brainstorms
```

Every position in your portfolio will eventually have:
- Your original thesis legs (from brainstorm)
- Your running observations (from notes)
- Market data (from ingestion)
- AI synthesis (from briefings)

All searchable together, all grounding each other.
