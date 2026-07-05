# Thesis Memory System

Tracks investment theses as structured assumptions + living narratives. Uses Claude to propose updates from ingestion data. Requires your approval before committing any change.

## Setup

```bash
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY
# INGESTION_STORE_PATH defaults to ../capital-intelligence-ingestion/data
```

## Usage

```bash
# Create a thesis (AI drafts from ingestion data)
npm run thesis -- create --ticker=NVDA --position=core

# Create manually (interactive prompts)
npm run thesis -- create --ticker=NVDA --manual

# Create a theme thesis
npm run thesis -- create --theme=ai-infrastructure --position=core

# View a company thesis
npm run thesis -- show --ticker=NVDA

# View a theme rollup
npm run thesis -- show --theme=ai-infrastructure

# List all theses with conviction summary
npm run thesis -- list

# View full narrative history
npm run thesis -- history --ticker=NVDA

# Generate update proposals from ingestion data (calls Claude)
npm run update -- --ticker=NVDA
npm run update -- --theme=ai-infrastructure
npm run update                          # all company theses

# Review and approve pending proposals
npm run review

# Run tests
npm test
```

## How It Works

1. **`npm run thesis -- create`** — Claude reads real data from the ingestion store (SEC filings, earnings transcripts, news) and drafts an initial thesis: 4–6 assumptions with statuses, a narrative, and a starting position.

2. **`npm run update`** — For each assumption in your thesis, Claude retrieves the most relevant new evidence from the ingestion store since the last update, analyzes whether it strengthens, weakens, or breaks each assumption, and writes a proposal.

3. **`npm run review`** — You see each proposed change and approve or reject it. Nothing updates until you approve. Full audit trail kept regardless.

## Assumption Statuses

| Status | Meaning |
|---|---|
| `strengthening` | More confidence the assumption will hold |
| `stable` | No significant change in conviction |
| `weakening` | Less confidence, but thesis intact |
| `broken` | Assumption no longer valid |

## Data

All data lives in `data/thesis.db` (gitignored — never pushed to GitHub).
