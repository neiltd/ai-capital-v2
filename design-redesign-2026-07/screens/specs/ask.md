# Ask — global ⌘K + /ask (spec)

Natural-language Q&A over everything the system knows: envelopes, briefing
archive, LanceDB/pgvector chunks, thesis history, trade log.

## Interaction model

- **⌘K palette (global):** one input, three result modes ranked live —
  (1) navigation ("risk" → /portfolio/risk), (2) tickers ("aot" → position
  panel), (3) free-text question → "Ask: …" row that submits to the agent.
  The palette is shadcn `Command`; questions escalate to the full page.
- **/ask (full page):** chat thread, left history rail (past threads,
  searchable — answers about money are worth keeping).

## Answer anatomy (the design's core)

Answers are **composed of the dashboard's own components, not paragraphs**:

- A question like "why am I down this week?" returns: a one-paragraph
  answer, then `StatTile`s / position rows / `Delta`s rendered from the
  actual data the agent queried, then **citations** — every number links to
  its source screen and envelope (`risk.json · 2026-07-07`), every claim to
  a briefing date or document chunk.
- Uncited numbers render with a `~` and muted tone; the UI never lets a
  hallucinated figure look as authoritative as a pipeline figure. This is
  the trust contract of the whole feature.
- Follow-up chips under each answer ("show as table", "compare to last
  month", "what changed since the 07-03 briefing?").

## Suggested prompts (empty state)

"What should I do today and why?" · "How exposed am I to a Hormuz
disruption?" · "Which theses weakened this month?" · "What did the discovery
agent buy and how is it doing vs SPY?"

## Backend gaps (#12 — this screen is mostly backend)

- Retrieval API over pgvector/LanceDB chunks with metadata filters.
- Tool-calling agent endpoint with read-only tools: `get_portfolio`,
  `get_risk`, `get_harvest`, `query_chunks`, `get_briefing(date)`,
  `get_events` — returning **typed payloads + provenance** so the frontend
  can render components and citations rather than parse prose.
- Thread persistence (SQLite/Postgres table) for history rail.
- Streaming (SSE) for answer tokens with component payloads interleaved.
- Cost guard: per-question token budget + monthly cap surfaced in the UI
  (the $8.40/mo discipline applies here most of all).
