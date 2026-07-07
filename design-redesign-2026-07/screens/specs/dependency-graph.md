# /discover/graph — Dependency graph (spec)

**Data:** `dependency-graph-engine/data/graph.json` — 34 nodes
`{ticker, company, themes[]}`, 42 edges
`{from, to, type, strength, description, evidenceQuote}` + trade-graph edges.

## Layout

```
┌ Toolbar: theme filter (combobox) · edge-type filter · [Focus: ticker ⌄] ┐
├ Graph canvas (8-9 cols)                     │ Inspector rail (3-4 cols)  ┤
└──────────────────────────────────────────────────────────────────────────┘
```

## Graph rendering

- Force layout (d3-force or `@xyflow/react`), **ego-network first**: default
  view is NOT the hairball — it's "pick a holding" prompt state; selecting a
  ticker (or arriving via `?ticker=NVDA` from any screen) shows that node +
  1-hop neighbors, expandable to 2-hop. Full-graph view available behind a
  toggle for exploration.
- **Nodes**: held positions get a filled disc in their asset-class
  categorical color + always-on label; non-held graph members are outline
  discs in `--ink-3`. Node size = portfolio weight (held) or fixed small
  (non-held). Never color-by-theme (themes are many; identity would cycle).
- **Edges**: type carried by line style + icon in tooltip, not hue —
  `supply_chain` solid, `customer` dashed, `competitor` dotted,
  `macro_theme` hairline. Strength = stroke width (1/2/3px). Directional
  arrowheads. Hover → tooltip with `description` + `evidenceQuote`.
- **Selection sync**: clicking a node fills the inspector rail: company,
  themes chips, all edges as a list (sortable by strength), held-position
  stats if held, and "signals through this node" from
  `analysis.json.latestSignals` matching source/target.
- **Theme lens**: choosing a theme (e.g. "AI infra") dims non-members and
  shows a footer stat: "holdings exposed: 4 positions · $9.0K · 12.1% of NW"
  — this is the screen's money question ("how much of me moves if this theme
  breaks?").

## Backend gaps

- Theme-exposure aggregation (sum of held USD value per theme) — computable
  client-side from graph.json + simulation.json, but belongs in the envelope.
- Edge recency/provenance: edges carry no `asOf`; stale relationships can't
  be flagged.
- Merge decision pending (ROADMAP Phase 4) — this design works whether the
  engine stays standalone or becomes a relationship table.
