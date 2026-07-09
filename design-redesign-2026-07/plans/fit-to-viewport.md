# Fit-to-viewport: Holdings (and every dense screen) at 100% zoom

**Complaint (user, paraphrased):** "when we zoom in/out the page it doesn't rescale to fit
the page and keep all detail showing — like this page in Holdings — if I make zoom 100%
it will not show clearly." Screenshot: `/portfolio` at 100% zoom on a laptop; the viewport
cuts off mid-table (last visible row is the "THAI FUNDS" group header), everything below
requires scrolling inside the main pane.

## Diagnosis

This is not a bug — it's a density mismatch. The new-design screens use a fixed,
generous spacing scale (`p-6` page padding, `space-y-6` section gaps, `py-2` table
cells, 28px stat numerals) tuned for tall viewports. On a laptop at 100% zoom the main
pane has roughly **790–880 logical px** of height (900–982px display minus menu bar,
browser chrome, and the StatusStrip). The Holdings page's above-the-Agent-view content
(header ~44px + stat row ~100px + gaps + a ~15-row grouped table at ~37px/row plus 4–5
group headers and a tfoot) needs ~1000–1100px. So ~200px of the primary content falls
below the fold, and the cut lands mid-table with no affordance that more exists.

The same fixed-density pattern exists on every dense screen built this session (Risk,
Tax, Theses, Macro & Prices, Wave Signals, Gov Contracts, Pipeline, Dependency Graph,
Discovery) — the fix must live in shared tokens/primitives, not in `/portfolio` markup.

## Options weighed

**A. Literal `transform: scale()` fit-to-viewport ("zoom to fit").** The user said
"rescale," so weigh it honestly: a wrapper that measures content height and scales the
page down uniformly. Rejected as the primary fix:

- It *compounds with* browser zoom rather than cooperating with it — the user's
  complaint is literally about zoom behavior; scale-on-top-of-zoom makes text size a
  product of two factors the user can't reason about.
- On dense pages (a 40-row Gov Contracts table) the required scale factor drops below
  ~0.75 and 13px body text becomes illegible — it trades "must scroll" for "can't read,"
  which is worse for a working dashboard where real money decisions ride on the numbers.
- Fractional scaling blurs text on non-retina displays, breaks `position: sticky`,
  misaligns tooltip/hover hit targets, and every page needs its own measurement wiring.
- It's a presentation-mode idiom (slides, dashboards on wall TVs), not a
  read-and-act idiom.

**B. Manual "compact density" toggle.** Right values, wrong trigger: adds UI state the
user must discover and flip per machine. Rejected as primary; the token architecture
below leaves the door open to add a manual override later at near-zero cost.

**C. Fluid `clamp()`-on-`vh` tokens.** Continuously fluid spacing/type sounds elegant
but produces fractional cell paddings that break optical row-height consistency in
tabular data, and is much harder to visually QA ("what does this look like at 843px?").
A discrete two-tier switch gives the same benefit and is deterministic.

**D. Viewport-height-aware density tokens + first-viewport discipline.** ← chosen.

## Recommendation (the one primary fix)

**Make vertical density a token that responds to viewport height: a "comfortable" tier
(today's values) and a "compact" tier that activates via `@media (max-height: 940px)`,
wired through Tailwind so the shared primitives and page containers pick it up
everywhere. Plus two supporting layout rules: sticky table headers on dense tables, and
"primary content above the fold" ordering (Holdings already complies — Agent view is
last).**

Why this is the right model:

- **It honors the actual words "rescale to fit" via CSS physics.** Browser zoom changes
  the CSS viewport size — at 125% zoom a 980px pane becomes ~784px, which trips the
  `max-height` query and switches to compact automatically. Zooming in makes the page
  *denser*, keeping more detail visible; zooming out relaxes it. That is "rescaling to
  fit the page" without any transform hacks, and it works identically on every screen.
- **It fixes the class of problem, not the instance.** Density lives almost entirely in
  4 shared primitives (`Th`/`Td`, `SectionCard`, `StatTile`) and one repeated page
  container class string. Change those, and all ~11 dense screens tighten at once.
- **It never sacrifices legibility.** Body/table text stays 13px in both tiers; only
  whitespace and display numerals shrink. Compact-tier savings on Holdings ≈ 150–190px
  (math below), which brings the full grouped table into the first viewport for a
  mid-teens-position portfolio at 100% laptop zoom.
- **When content still doesn't fit** (it can't always — Gov Contracts with 50 rows has
  no honest no-scroll rendering), sticky table headers keep column context while
  scrolling, and the cut is never silent.

**Tradeoff (say this to the user):** the app will render at two densities depending on
window height/zoom — screenshots differ between a laptop and an external monitor, and
both tiers must be QA'd. Also, this does **not** guarantee zero scrolling on every page
forever; it guarantees the *primary decision content* of each screen fits a 100%-zoom
laptop viewport and that scrolling past it is cheap and obvious. If the user truly wants
presentation-style shrink-everything-to-one-screen, that's option A and we should
explicitly not build it for the reasons above.

## Changes, file by file

All paths under `/Users/thanapold/Desktop/Projects.nosync/apps/unified-platform/`.

### 1. `src/app/tokens.css` — add density variables

Append after the existing color blocks (density is theme-independent, so a standalone
block, not per-theme):

```css
/* Vertical density — comfortable by default, compact on short viewports.
 * max-height responds to browser zoom too (zoom shrinks the CSS viewport),
 * so zooming in automatically tightens the layout. */
:root {
  --page-pad: 24px;      /* page container padding (was p-6) */
  --sec-gap: 24px;       /* gap between sections / grid cells (was space-y-6 / gap-6) */
  --card-px: 16px;       /* SectionCard horizontal padding (was px-4) */
  --card-py: 16px;       /* SectionCard bottom padding (was pb-4) */
  --cell-py: 8px;        /* table cell vertical padding (was py-2) */
  --stat-hero: 28px;  --stat-hero-lh: 34px;
  --stat-value: 22px; --stat-value-lh: 28px;
}
@media (max-height: 940px) {
  :root {
    --page-pad: 16px;
    --sec-gap: 16px;
    --card-px: 14px;
    --card-py: 12px;
    --cell-py: 5px;
    --stat-hero: 24px;  --stat-hero-lh: 30px;
    --stat-value: 18px; --stat-value-lh: 24px;
  }
}
```

Breakpoint rationale: 940px puts a 1080p external monitor (~950–990px pane) in
comfortable and every laptop-at-100%-zoom (~790–880px) in compact. Do NOT shrink
`text-[13px]` body/table text or `text-[11px]` labels — legibility floor.

### 2. `tailwind.config.ts` — wire tokens

Extend the existing `theme.extend`:

```ts
spacing: {
  'page-pad': 'var(--page-pad)',
  'sec-gap': 'var(--sec-gap)',
  'card-px': 'var(--card-px)',
  'card-py': 'var(--card-py)',
  'cell-py': 'var(--cell-py)',
},
fontSize: {
  'stat-hero':  ['var(--stat-hero)',  'var(--stat-hero-lh)'],
  'stat-value': ['var(--stat-value)', 'var(--stat-value-lh)'],
},
```

### 3. `src/components/next/ui.tsx` — shared primitives (this is most of the fix)

- `Td`: `px-3 py-2` → `px-3 py-cell-py` (keep `text-[13px] leading-5`).
- `Th`: `px-3 py-2` → `px-3 py-cell-py`. Also add an opt-in sticky prop:
  `sticky?: boolean` → appends `sticky top-0 z-10 bg-surface` (bg required — sticky
  header floats over rows; `bg-surface` matches the card).
- `SectionCard`: header `px-4 pt-3.5 pb-2` → `px-card-px pt-3 pb-2`; body `px-4 pb-4`
  → `px-card-px pb-card-py`.
- `StatTile`: `px-4 py-3` → `px-card-px py-2.5`; value classes
  `text-[28px] leading-[34px]` → `text-stat-hero` and `text-[22px] leading-[28px]`
  → `text-stat-value`.

### 4. Page containers — mechanical sweep of `src/app/(next)/**/page.tsx`

Every dense page uses the same container idiom. Replace:

- `p-6` (page `<main>` padding) → `p-page-pad`
- `space-y-6` (section stack) → `space-y-sec-gap`
- `gap-6` (primary grids) → `gap-sec-gap`, and `gap-4` on the stat-tile row → `gap-sec-gap`
  only if it reads fine; otherwise leave `gap-4` (horizontal gaps matter less).

Find them with: `grep -rn "space-y-6 p-6\|p-6 space-y-6\|gap-6" src/app/\(next\)/`.
Apply to: portfolio, portfolio/risk, portfolio/tax, portfolio/theses, markets,
markets/waves, markets/gov, world, discover, discover/graph, system/pipeline, today.
Leave intra-card micro-spacing (`mt-1`, `py-1`, `space-y-2`) alone — it's already tight.

### 5. `src/app/(next)/portfolio/holdings-table.tsx` — Holdings specifics

- Header row: pass `sticky` to each `Th` (`<Th sticky>Ticker</Th>` etc.).
- **Sticky gotcha:** the current wrapper `<div className="overflow-x-auto">` creates a
  scroll container that defeats vertical `position: sticky` (the header would stick to
  the wrapper, which itself scrolls away). Change it to
  `overflow-x-auto xl:overflow-visible` — at `xl` widths the 8-column table fits its
  ~940px card so horizontal scroll isn't needed and sticky then anchors to AppShell's
  scrolling main pane, exactly where the complaint lives. Below `xl`, horizontal scroll
  wins and stickiness degrades gracefully (acceptable).
- Group-header rows: `py-1.5` → `py-1`; tfoot cells `py-2.5` → `py-2`. (Small, but 4–5
  group rows × every page view adds up.) Do NOT make group rows sticky — stacked-sticky
  offsets are fragile and not needed once the table fits.
- Position rows inherit the `Td` change (no edit needed).

### 6. No AppShell changes

`h-screen overflow-hidden` + inner `overflow-y-auto` is the correct dashboard shell and
is load-bearing for sticky headers. Do not switch to page-level scroll.

### Budget check (why this is enough for Holdings)

At compact tier, per laptop viewport: page padding −16, three section gaps −24,
stat tiles ≈ −14 (padding + numeral), table cells −6px/row × ~15 rows ≈ −90, group
headers −4 × 4 ≈ −16, card chrome ≈ −12 → **≈ 170px reclaimed**, on top of ~880px
available vs ~1050px needed today. Result: stat row + Allocation + the full grouped
Holdings table (through Cash + Total) visible in the first viewport at 100% zoom for
the current portfolio size; Agent view intentionally below the fold as secondary
content. If the portfolio grows past ~22 rows it scrolls again — with sticky headers,
by design, not by accident.

## Verification (implementer must do)

1. `pnpm --filter unified-platform typecheck` and `lint`.
2. Dev server + browser at window sizes 1440×815 and 1512×870 (laptop-like): confirm
   `/portfolio` shows the Total row without scrolling; confirm compact tier is active
   (inspect `--cell-py` = 5px).
3. Same page at ≥1000px pane height: comfortable tier (today's look) unchanged.
4. At 125% and 150% browser zoom on a laptop-size window: compact tier engages
   (this is the user's literal complaint — verify it specifically).
5. Scroll the Holdings card past the top: column headers stay pinned with opaque
   `bg-surface`, no row bleed-through.
6. Spot-check 3 other swept pages (risk, markets, system/pipeline) in both tiers for
   broken layout — especially anything that hard-coded heights around the old paddings.
7. Both color themes (sticky header bg uses a theme token, so should be automatic).
