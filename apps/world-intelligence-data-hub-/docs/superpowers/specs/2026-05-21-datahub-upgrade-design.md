# Datahub Upgrade — Design Spec
**Date:** 2026-05-21
**Status:** Approved

---

## Scope

Three deliverables:

1. **Human-Intel Channel** — conversational + file-inbox submission pipeline with agent critique, extraction, and export integration
2. **Economist Agent** — auto consequence analysis on every human submission + on-demand scenario drilling
3. **Git privacy** — switch GitHub repo visibility from public to private (no code change required)

---

## 1. Human-Intel Channel

### Purpose

Allow the user to submit intelligence from sources the AI cannot reach (TikTok, YouTube, podcasts, private web links, personal observations). The agent cross-references submissions against existing storylines, assesses credibility, extracts structured intel, and asks follow-up questions when verification is needed from an inaccessible source.

### Input paths

**Primary — Claude Code conversation:**
The user invokes the `human-intel` Claude Code skill inside a session. The skill loads current exports for context, then accepts freeform input (pasted text, URL description, podcast summary, anything). No topic restriction — any domain is valid.

**Fallback — inbox file:**
The user drops freeform text into `intelligence/human/inbox.md`. Running `npm run human-intel` calls the Claude API non-interactively with the same extraction logic and writes to the same store. After successful processing, the script appends a `<!-- processed: ISO-8601 -->` comment to the top of `inbox.md` and removes the processed content, leaving an empty file ready for the next drop.

### Agent behaviour on each submission

1. **Extract** — title, topic, countries, actors, event_type (nullable), confidence, tags
2. **Assess credibility** — source tier (unverified / social / news / primary), bias flags, plausibility given current geopolitical context
3. **Cross-reference** — match against existing storylines and events in exports; note confirmations and contradictions
4. **Follow-up** — if a claim needs verification from a source the agent can't reach, it asks the user explicitly: "Can you check X on [source]?"
5. **Store** — write final record to `intelligence/human/store.json` with `exported: false`
6. **Trigger economist quick analysis** — auto-runs before returning to the user
7. **Re-export** — runs export script so downstream projects see the new record immediately

### Storage — `intelligence/human/store.json`

Array of records, one per submission:

```json
{
  "id": "human-<8-char-hash>",
  "submitted_at": "ISO-8601",
  "source_platform": "tiktok | youtube | podcast | web | other",
  "source_url": "optional string",
  "raw_text": "freeform user input",
  "extracted": {
    "title": "string",
    "topic": "geopolitical | economic | technology | social | energy | other",
    "countries": ["ISO-3166 alpha-3"],
    "actors": ["string"],
    "event_type": "existing taxonomy value or null",
    "confidence": 0.0–1.0,
    "tags": ["string"]
  },
  "credibility": {
    "source_tier": "unverified | social | news | primary",
    "bias_flags": ["state_narrative | unverified_claim | single_source | ..."],
    "cross_references": ["storyline-id or event-id"],
    "assessment": "free text — plausibility and contradiction notes"
  },
  "follow_up_requests": ["string — what the agent asked the user to go verify"],
  "economist_quick_analysis": "string — auto-generated consequence chain",
  "exported": false
}
```

### Export integration

The existing export runner (`intelligence/exports/export-runner.ts`) is extended to:

- Read `intelligence/human/store.json` for records where `exported: false`
- Tag each record `source_type: "human"` in the output
- Merge records that have a valid `event_type` into the main `events[]` array in the relevant export files
- Place records with `event_type: null` into a new `human_intel[]` array in each export file (added field — no breaking change per existing schema stability guarantee)
- Set `exported: true` after successful write

### New npm script

```
npm run human-intel   # process inbox.md non-interactively
```

---

## 2. Economist Agent

### Purpose

Reason through economic and geopolitical consequence chains — second and third-order effects of any scenario the user describes. Not domain-restricted. Aware of current exports (storylines, energy prices, macro indicators, human intel).

### Quick analysis (auto, every human-intel submission)

After extraction and credibility assessment, the agent generates a 3–5 step consequence chain and stores it in `economist_quick_analysis`. Format:

```
"If [event] → [immediate effect] → [secondary effect] → [tertiary effect, who gets hit]"
```

Directional and short — flags what to watch, not a full analysis.

### Deep scenario drilling (on-demand)

A separate `economist` Claude Code skill the user invokes any time, independent of intel submission.

**Input:** any scenario described in plain language
**Context loaded:** all current exports (storylines, energy data, macro indicators, human intel store)

**Output structure:**
- **Base / bull / bear case** — three outcome paths with rough directional probability
- **Affected sectors and countries** — who is exposed and how
- **Key variables to watch** — 3–5 signals that determine which case plays out
- **Data gaps** — sources the agent cannot reach that the user could check manually (feeds back into human-intel loop)

The economist skill never calls external APIs directly — it reasons from export context and asks the user to fetch what it cannot reach.

---

## 3. Git Privacy

**Action:** Change GitHub repository visibility from public to private.

This is a GitHub settings change only — no code changes, no history rewrite, no `.env` audit needed (`.env` is already git-ignored per existing security notes).

Steps (user performs manually):
1. GitHub → repository → Settings → Danger Zone → Change visibility → Private
2. Verify: `git remote -v` still works, pushes continue normally

---

## New files introduced

| Path | Purpose |
|------|---------|
| `intelligence/human/store.json` | Persistent store of all human-submitted intel |
| `intelligence/human/inbox.md` | Drop-in fallback input file |
| `scripts/human-intel.ts` | Non-interactive inbox processor (Claude API) |
| `.claude/skills/human-intel.md` | Claude Code skill for conversational submission |
| `.claude/skills/economist.md` | Claude Code skill for scenario drilling |

## Modified files

| Path | Change |
|------|--------|
| `intelligence/exports/export-runner.ts` | Read human store, merge into exports |
| `package.json` | Add `human-intel` script |
| `exports/world-map/intelligence.json` | Add `human_intel[]` array to schema |
| `exports/oil-project/intelligence.json` | Add `human_intel[]` array to schema |
| `exports/stock-project/intelligence.json` | Add `human_intel[]` array to schema |

---

## What this is NOT

- No new external API integrations
- No memory-agent or graph DB (still deferred per observation mandate)
- No breaking schema changes — `human_intel[]` is additive
- The economist agent does not produce structured data that feeds exports — it is conversational only
