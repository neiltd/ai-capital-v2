# AI Capital — Design System (Redesign 2026-07)

A clean-slate design for `unified-platform`. One technical user, real money,
read daily before market open. The design goal is **an instrument panel you
trust**: dense but hierarchical, zero decoration that doesn't carry
information, and honest about data quality (freshness, calibration, currency
basis) because this system has already been burned by silently-wrong numbers
(the 2026-07-06 FX bug).

---

## 1. Information architecture

Organized by **the question Neil is asking**, ordered top-to-bottom in the
sequence he actually asks them each morning — not by which backend app
produces the data.

```
AI CAPITAL                              [⌘K  Ask anything…]

TODAY
  Briefing ......................... /today            ← default route

PORTFOLIO        "How am I positioned?"
  Holdings ......................... /portfolio
  Risk ............................. /portfolio/risk
  Tax .............................. /portfolio/tax
  Theses ........................... /portfolio/theses

MARKETS          "What's moving?"
  Macro & Prices ................... /markets
  Wave Signals ..................... /markets/waves
  Gov Contracts .................... /markets/gov

WORLD            "What's happening out there?"
  Events & Map ..................... /world            (list ⇄ map ⇄ storylines tabs)

DISCOVER         "What should I own next?"
  Discovery Agent .................. /discover
  Dependency Graph ................. /discover/graph

SYSTEM
  Pipeline ......................... /system/pipeline

──────────────────────────────────────
  ◧  Creator Studio                                    ← app switcher, separate shell (§8)
```

Decisions and rationale:

- **Briefing is the home route.** The system's entire purpose funnels into one
  daily artifact; everything else is drill-down from it. Every briefing claim
  links to its source screen (a TRIM action links to that position's risk row;
  a world event links to `/world`).
- **Risk, Tax, and Theses live under Portfolio**, not as top-level peers.
  They are all views *of the same holdings*; keeping them siblings under one
  section means the position is the shared unit of navigation — clicking any
  ticker anywhere opens the same position panel (holdings + risk + tax +
  thesis in tabs).
- **Dependency Graph moved under Discover**, not Portfolio. Its actual use is
  "what else is exposed to this theme?" — a research/ideation act, and it
  shares the theme vocabulary with the discovery agent.
- **Ask is not a nav destination.** It's a global affordance: `⌘K` opens a
  command/ask palette from any screen; long answers expand into a `/ask`
  full-page thread. Q&A is a *mode*, not a *place*.
- **Wave Signals and Gov Contracts sit under Markets** as signal layers —
  they are inputs you scan, not places you manage.
- **World Intelligence is one section with three tabs** (event list, map,
  storylines) rather than three pages — they are three lenses on the same
  event set, and the selection (an event/storyline) persists across tabs.
- **Pipeline health is quarantined under System** — operational, not
  financial; but its *freshness summary* is surfaced globally (§5, status
  strip) so a stale pipeline can never silently feed a stale briefing.
- **Creator Studio is an app switch, not a sibling nav item** — see §8.

### Global status strip (top bar, every screen)

Right-aligned, persistent, ~28px tall:

```
NW $74,574  ▲ $312 today   ·   USD/THB 33.29   ·   ⚠ CRWD wash-sale 1d   ·   ● data 06:12 (fresh)
```

- Net worth (USD-normalized) + day change — the one number always in view.
- FX rate in use — after the FX bug, the conversion basis is never hidden.
- Wash-sale countdown chips appear automatically when any window < 7 days.
- Freshness dot: green = pipeline succeeded < 24h ago; amber = stale;
  red = last run failed (links to `/system/pipeline`).

---

## 2. Color

Dark-mode-first. Warm graphite surfaces (not blue-black), hairline borders
instead of shadows, one accent hue. All palettes below were run through the
dataviz six-check validator against both surfaces (2026-07-06).

### Surfaces & ink

| Token            | Dark      | Light     | Use |
|------------------|-----------|-----------|-----|
| `--page`         | `#0d0d0d` | `#f9f9f7` | app background |
| `--surface`      | `#1a1a19` | `#fcfcfb` | cards, tables, charts |
| `--surface-2`    | `#222220` | `#f3f2ee` | hover rows, insets, code |
| `--ink`          | `#ffffff` | `#0b0b0b` | primary text, key numbers |
| `--ink-2`        | `#c3c2b7` | `#52514e` | body, secondary |
| `--ink-3`        | `#898781` | `#898781` | labels, axis, captions |
| `--hairline`     | `rgba(255,255,255,.10)` | `rgba(11,11,11,.10)` | borders, dividers |
| `--grid`         | `#2c2c2a` | `#e1e0d9` | chart gridlines |
| `--accent`       | `#3987e5` | `#2a78d6` | links, focus, primary actions, BUY |

### Semantic P&L (reserved — never used for anything else)

| Token        | Dark      | Light     |
|--------------|-----------|-----------|
| `--gain`     | `#0ca30c` | `#006300` |
| `--loss`     | `#e66767` | `#c73535` |

Gain/loss color is applied **only to realized/unrealized P&L and deltas**,
always accompanied by an explicit sign (`+`/`−`) and, where space permits, a
▲/▼ glyph — never color alone. A flat/zero delta renders in `--ink-3`.

### Status (alerts, pipeline health, severity) — fixed, never themed

| Role     | Hex       | Pairing rule |
|----------|-----------|--------------|
| good     | `#0ca30c` | always icon + label |
| warning  | `#fab219` | always icon + label |
| serious  | `#ec835a` | always icon + label |
| critical | `#d03b3b` | always icon + label |

Used for: wash-sale windows, concentration breaches, pipeline stage state,
world-event severity, thesis status (weakening = warning). Never used as a
chart series color.

### Categorical (asset classes, chart series) — validated

Fixed assignment, **color follows the entity, never rank**:

| Slot | Entity            | Dark      | Light     |
|------|-------------------|-----------|-----------|
| 1    | US equity         | `#3987e5` | `#2a78d6` |
| 2    | Thai equity       | `#199e70` | `#1baf7a` |
| 3    | Gold              | `#c98500` | `#eda100` |
| 4    | Thai funds        | `#9085e9` | `#4a3aa7` |
| —    | Cash              | `#898781` | `#898781` |

Validator: dark set PASS all checks (worst adjacent ΔE 41.3, all ≥3:1 on
`#1a1a19`). Light set PASS with contrast WARN on slots 2–3 → **relief rule:
allocation charts always carry direct labels** (they do anyway, see §6).
Cash is deliberately the sub-chroma neutral — "not an active bet" — and sits
outside the validated categorical set; it is always direct-labeled.

Sequential (heatmaps, magnitude): single-hue blue ramp `#cde2fb → #0d366b`.
Diverging (correlation, target-vs-actual drift): blue ↔ red with neutral gray
midpoint (`#383835` dark / `#f0efec` light). Never a rainbow.

---

## 3. Typography

One family: **Inter** (falls back `system-ui, -apple-system, "Segoe UI",
sans-serif`). No display face, no serif. Numbers are the protagonist:

- `font-variant-numeric: tabular-nums` on **every** table cell, stat value,
  axis tick, and delta — anything that aligns vertically or gets re-scanned.
- Tickers render in `font-medium tracking-tight` at body size — no monospace
  font needed; tabular figures do the alignment work.

| Token       | Size/leading | Weight | Use |
|-------------|--------------|--------|-----|
| `display`   | 28/34        | 600    | hero number (net worth, one per screen max) |
| `title`     | 20/28        | 600    | page title |
| `section`   | 15/22        | 600    | card/section headers |
| `body`      | 14/21        | 400    | prose, rationales |
| `table`     | 13/20        | 400    | table cells, dense lists |
| `stat`      | 22/28        | 600    | stat-tile values, tabular |
| `label`     | 11/16        | 500    | uppercase, `tracking-[0.08em]`, `--ink-3` — column headers, tile labels, "as of" stamps |

Numeric emphasis is weight + size, never color (color is reserved for sign
and status).

---

## 4. Spacing, layout, density

- Base unit **4px**. Card padding `16px` (`20px` on ≥1440w). Section gap
  `24px`. Page gutter `24px`. Max content width `1520px`, tables fluid.
- **12-column grid** per page; screens compose from full-, 8-, 6-, and
  4-column cards. No cards inside cards — a card is one flat surface with
  hairline-divided regions.
- Table rows: `36px` default, `44px` for rows with two-line content
  (value + native-currency subline). Row hover = `--surface-2`. Numeric
  columns right-aligned, text left-aligned, first column sticky on overflow.
- Radius: `8px` cards, `6px` inputs/chips, `4px` chart data-ends. No shadows
  in dark mode (hairline borders); light mode may add `0 1px 2px rgba(0,0,0,.04)`.
- Every card that renders pipeline data shows an **"as of" stamp** (label
  style, top right) sourced from the envelope's `exportedAt`/`generatedAt`.

---

## 5. Core component patterns

Implemented in `screens/_shared/ui.tsx` + `charts.tsx` (drop-in code); shadcn
primitives (`Tooltip`, `Tabs`, `Dialog`, `DropdownMenu`, `Command`) are used
underneath where interaction demands it.

| Component | Contract |
|---|---|
| `StatTile` | label (label style) / value (stat, tabular) / optional `Delta` / optional sparkline / optional footnote. Grid of 3–6 across the top of most screens. |
| `Delta` | signed, colored gain/loss, ▲/▼ glyph, tabular. `pct` and `usd` variants. Zero renders muted, no glyph. |
| `Money` | USD-normalized display; if the underlying position is THB, shows `$9,651` with muted `฿321,250` subline (or tooltip in dense tables). The FX rate used is always discoverable — click any converted figure to see `× 33.29 THB/USD (2026-07-06)`. |
| `ConvictionBadge` | outline chip: `HIGH / MED / LOW` **plus calibrated accuracy** when available, e.g. `TRIM · 76.5% 7d`. The system knows its own hit rate — the UI must show it next to every recommendation, not hide it in a footnote. |
| `ActionBadge` | BUY = accent-filled, TRIM = warning-outline, EXIT = critical-outline, HOLD = neutral-outline, DCA = categorical-slot-4-outline. Fixed mapping everywhere. |
| `StrategyTag` | `tactical` (plain) / `dca` (violet outline) / `tax_locked` (🔒 + neutral, and the row's action affordances are disabled). |
| `JurisdictionTag` | `TH exempt` / `TH taxable` / `US taxable` / `locked` — muted chip on tax rows; explains *why* something is or isn't harvestable inline. |
| `AlertBanner` | full-width in-card banner, status color + icon + label + optional countdown (`CRWD — do not rebuy before 07-15 · 8d`). Critical banners are the only saturated fills in the app. |
| `FreshnessDot` | ● green <24h / amber stale / red failed, with `title` tooltip of the timestamp. Appears in status strip and per-card "as of" stamps when stale. |
| `DataTable` | header in label style, sticky; tabular-nums; right-aligned numerics; row hover; expandable rows (chevron) for rationale/detail; `overflow-x-auto` wrapper. |
| `SectionCard` | title + "as of" + body; the universal container. |
| `ProbBar` | horizontal probability bar (scenario outlook): label left, % right, thin 6px track, filled in `--accent`; scenario type shown by icon+label, not bar color. |
| `ScoreBadge` | discovery 0–100 score: number in a small square chip, sequential-blue background stepped by score band, white/ink text, always beside the bear score (`88 bull / 41 bear`). |

### Chart rules (apply dataviz method)

- Sparkline: 2px line, no axes, no fill, last-point dot, muted `--ink-3`
  when informational / gain-loss colored only when the chart *is* the P&L.
- Donut (allocation): thin ring (14px), 2px surface gaps between segments,
  **direct labels with values** (relief rule), center = total. Max 5 segments
  + cash-gray.
- Bars: 4px rounded data-ends anchored to baseline, 2px gaps, direct label on
  ends when ≤ 8 bars, hairline grid only.
- One axis, always. Two measures → two charts or indexed series.
- Every plotted chart ships a hover layer (crosshair + tooltip on lines,
  per-mark tooltip on bars/dots). Every chart has a "view as table" affordance.
- Legends: present for ≥2 series, none for one; text in ink tokens with a
  colored mark, never colored text.

---

## 6. Interaction principles

- **Read-first, act-rarely.** Mutating actions (refresh prices, promote pick,
  accept thesis change, log trade) are explicit buttons that open a confirm
  dialog showing exactly what will be written; every write shows the wash-sale
  check result before confirming.
- **Ticker is the universal link.** Any ticker anywhere → position side-panel
  (overview / risk / tax / thesis / trades tabs) without losing page context.
- **⌘K everywhere**: fuzzy-jump to screens and tickers, plus free-text ask.
- Keyboard: `j/k` row navigation in tables, `enter` expand, `g` then letter
  for section jumps (gt = today, gp = portfolio…). Cheap to add, respects a
  daily power user.
- Loading states are skeletons of the real layout; error states name the
  failing pipeline stage and link to `/system/pipeline`.

---

## 7. Light mode

Fully supported (`prefers-color-scheme` default + manual toggle stamped as
`data-theme` on `<html>`; both directions must win). Light values specified in
every token table above; the light categorical set carries the direct-label
relief rule. Charts re-validate against `#fcfcfb`.

---

## 8. Creator Studio — deliberately distinct design language

**Decision: Creator Studio does NOT share the investment dashboard's visual
language.** It shares the *token infrastructure* (spacing scale, type scale,
radius, shadcn primitives) but gets its own theme: light-first, warmer paper
background (`#faf7f2`), a magenta/orange accent pair, larger type, rounded
cards with soft shadows, and board/kanban layouts instead of dense tables.

Rationale: the dashboard's authority comes from restraint — graphite, one
accent, numbers first. Content planning is a generative, visual, mood-driven
task; forcing it into instrument-panel chrome makes it worse at its job, and
letting its playfulness leak into the dashboard makes the dashboard worse at
*its* job. The shell is also separate (own top-nav, no status strip — net
worth has no business on a TikTok planning board). Switching apps is a
deliberate context change via the sidebar footer switcher, and the URL space
stays `/studio/*`. Full spec: `screens/specs/creator-studio.md`.

---

## 9. Tailwind wiring

Tokens live as CSS variables (`screens/_shared/tokens.css`) and map into
Tailwind via `theme.extend.colors` with `rgb(var(--…) / <alpha>)` or plain
hex-var references — see the file header for the exact `tailwind.config.ts`
snippet. All screen code in this proposal uses semantic classes
(`bg-surface`, `text-ink-2`, `text-gain`, `border-hairline`, …) so the theme
swaps in one place.
