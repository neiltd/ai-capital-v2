# world-map-v2 — /world Map tab redesign

Scope: the **Map tab only** of the World Intelligence screen. List and Storylines are the
shipped implementation and unchanged (page.tsx reproduces the shell so the Map tab can be
judged as their sibling). This is a review mockup — sample data inline, real registry
metadata, no production wiring.

Files: `page.tsx` (shell + tabs) · `map-view.tsx` (state + layout) · `layer-rail.tsx`
(search / lenses / shading / layer groups) · `map-canvas.tsx` (SVG map + legend strip) ·
`inspector.tsx` (detail rail) · `data.ts` (layer registry, indicators, sample geodata,
inspector payloads).

---

## 1. Design rationale — the UX problems in the current map

The current Map tab embeds the `src/worldmap/` sub-app verbatim. Verified against the live
app (localhost:3000/world → Map) and `App.tsx` / `WorldMap.tsx`:

1. **It's a foreign object.** The sub-app ships its own navy palette (`#070B14`,
   `#0A0F1E`, `#1E2D4A` borders, blue-600 switches), its own branded header ("🌍 World
   Intelligence v2", divider-separated toolbar, a **GitHub link**), and an
   `ImportStatus` chip — inside a dashboard that already has a header, an as-of stamp,
   and the graphite token system. Two competing "World Intelligence" titles are visible
   at once.
2. **It's literally clipped.** The sub-app roots itself at `h-screen` (100vh) inside the
   tab's `h-[80vh] overflow-hidden` card — the bottom ~20vh of the map UI is cut off.
   Live check: the ConflictCard (bottom-left floating) renders partially out of frame.
3. **21 layers behind one dropdown.** All layers live in a single tall dropdown that
   (a) covers the map while open, (b) closes on outside click, so you can't keep it open
   while comparing states, (c) renders every description at full height so you scroll a
   wall of text to find one layer, and (d) offers no shortcut for the combinations you
   actually use every morning.
4. **Controls disappear responsively.** `LayerToggle` is `hidden md:flex` and
   `HeatmapSelector` is `hidden lg:flex` — below those breakpoints layers and heatmap are
   simply unreachable.
5. **Three competing detail surfaces.** Country detail slides in right (400–460px),
   conflict detail floats bottom-left **over the map marks**, events/facilities get
   cursor tooltips. Each styled differently; the floating card covers what you clicked
   near.
6. **External basemap.** `MAP_STYLE = 'https://basemaps.cartocdn.com/...'` — live check
   showed the left hemisphere blank for seconds while CDN tiles loaded. External
   dependency in a daily-use tool (and against the repo's no-external-CSP direction).
7. **Rainbow scales.** Heatmap legend is red→amber→green; ScoreBar uses
   red/amber/green fills — status colors doing scale work, against the design system.

## 2. What the redesign does

**Layout: rail · canvas · rail** — the same "canvas + inspector" convention as the
Dependency Graph screen, so spatial screens in the app share one shape:

```
┌ layer rail 240px ┬────────── map canvas (hero) ──────────┬ inspector 300px ┐
│ omnisearch       │ graphite basemap, drag-pan, +/- zoom  │ selection-synced │
│ lenses           │ marks per layer, heatmap chip (top-R) │ detail panel     │
│ country shading  │ legend strip for ACTIVE layers (btm)  │ (never covers    │
│ 7 layer groups   │                                       │  the map)        │
│ n/21 on · reset  │                                       │                  │
└──────────────────┴───────────────────────────────────────┴──────────────────┘
```

- **Lenses (new).** Five one-click curated combos — Morning brief (default), My
  portfolio, Energy security, Logistics, Digital sovereignty — built from the registry's
  own `themes: ThematicScope[]` field, which `layers/_core/types.ts` documents as the
  intended "thematic view mode". The 90% path becomes one click; manual toggling still
  works and flips the lens indicator to "custom".
- **Progressive disclosure for 21 layers.** Groups are collapsible accordions with
  active-count badges; descriptions move to tooltips (with data source) instead of
  permanent rows. The rail is persistent — no dropdown covering the map.
- **Omnisearch.** One box finds countries (jump + inspect; production keeps the existing
  Fuse.js index over country-index.json) *and* layers (toggle from the search result) —
  fixing "hard to find a specific layer among 21".
- **One inspector.** Everything clickable — event, conflict, country, chokepoint, any
  facility — opens the same right rail. Nothing floats over the map. Esc closes
  (preserved from App.tsx). Idle state teaches the mark grammar.
- **Token-native visuals.** `--page/--surface/--hairline/--ink-*` throughout; landmass in
  `--surface-2`; sequential accent-blue ramp for all graded scales (direction flips for
  inverted indicators, labeled "high = worse"); status colors reserved for
  severity/intensity. Light theme works for free.
- **Self-contained basemap.** SVG stand-in here; production renders the self-hosted
  MapLibre dark style (countries-110m.json) restyled to the graphite tokens — no CDN.
- **Honest marks kept.** Hollow event = country-centroid coordinates; thin ring =
  escalation ≥ 0.7; size = severity. Provenance (source path) on every layer tooltip.

## 3. Layer inventory — all preserved

The production registry has **22 entries: 21 individually toggleable layers + the
Country Heatmap mode** (the current LayerToggle likewise excludes `heatmap`, which is
driven by its own selector — same split here, as "Country shading").

| # | Layer (registry id) | Group | In redesign |
|---|---|---|---|
| 1 | Active Conflicts (`conflicts`) | Geopolitical | toggle + click → conflict panel |
| 2 | Conflict Zones (`conflict-zones`) | Geopolitical | own toggle (de-ganged, see note) |
| 3 | Trade Routes (`trade-routes`) | Economic | toggle, volume-colored lines |
| 4 | Strategic Chokepoints (`chokepoints`) | Economic | toggle + click → chokepoint panel |
| 5 | Portfolio Trade Exposure (`portfolio-trade`) | Economic | toggle; chokepoint click → lanes + exposed tickers |
| 6 | Major Airports (`airports`) | Infrastructure | toggle + click → facility panel |
| 7 | Seaports (`seaports`) | Infrastructure | toggle + click → facility panel |
| 8 | Datacenters (`datacenters`) | Infrastructure | toggle + click → facility panel |
| 9 | Submarine Cables (`submarine-cables`) | Infrastructure | toggle, dashed lines |
| 10 | Rail Hubs (`rail-hubs`) | Infrastructure | toggle + click → facility panel |
| 11 | Major Hospitals (`hospitals`) | Infrastructure | toggle + click → facility panel |
| 12 | Power Infrastructure (`power-plants`) | Utilities | toggle + click → facility panel |
| 13 | Refineries & LNG (`refineries`) | Utilities | toggle + click → facility panel |
| 14 | Critical Mineral Mines (`critical-minerals`) | Utilities | toggle + click → facility panel |
| 15 | Water Infrastructure (`water-infra`) | Utilities | toggle + click → facility panel |
| 16 | Digital Connectivity MCI (`mci`) | Utilities | toggle, sized bubbles |
| 17 | Energy Mix (`energy-mix`) | Utilities | toggle, dominant-source dots |
| 18 | Intelligence Events (`intelligence-events`) | Intelligence | toggle + click → event panel w/ analysis |
| 19 | Water Stress (`water-stress`) | Environment | toggle, graded shading |
| 20 | Food Security (`food-security`) | Environment | toggle, graded shading |
| 21 | Investment Signals (`investment-signals`) | Investment | toggle, signal diamonds |
| — | Country Heatmap (`heatmap`) | Intelligence | "Country shading" selector — all 12 indicators (7 geopolitical + 3 energy + 2 food/water), inverted-scale legend flip preserved |

**Coupling note:** in the current app `conflict-zones` visibility is ganged to
`conflicts` (registry COUPLING NOTE; `WorldMap.tsx` passes only
`isLayerVisible('conflicts')`). The redesign gives each its own switch — the registry's
stated intent; keeping the gang is a one-line change if preferred.

## 4. Comparison to current (Step-3 audit)

Changed, and why:

| Current | Redesign | Why it's better |
|---|---|---|
| Sub-app embedded verbatim: own navy theme, own branded header, GitHub link, emoji | Native three-panel view in app tokens | Feels like a sibling of List/Storylines and the Graph screen; kills the double header and clipped 100vh-in-80vh layout |
| Layers in one tall dropdown covering the map, closes on outside click | Persistent left rail: lenses + grouped accordions + omnisearch | Controls and map visible simultaneously; 21 layers scannable in 7 groups; common combos are one click |
| Layer/heatmap controls hidden below md/lg breakpoints | Rail stacks above the canvas on small screens | Every capability reachable at every width |
| Country panel (right, 400–460px) + ConflictCard (floating over map) + cursor tooltips | One 300px inspector for every selection kind | One consistent place to look; nothing occludes the map; more canvas width net |
| CARTO CDN basemap (blank hemisphere while tiles load) | Self-hosted MapLibre dark restyled to tokens (SVG stand-in here) | No external dependency, no flash-of-empty-ocean, CSP-clean |
| Heatmap red→green ramp; ScoreBar red/amber/green | Sequential accent-blue ramp, direction-flipped + labeled for inverted indicators | Design-system § scales; colorblind-safe; status colors keep meaning "alert" |
| Heatmap selector detached from layer story | "Country shading" section in the rail + active-shading chip on canvas | The exclusive-mode behavior is explicit; current indicator always visible |
| Hint pill "Click any country · Toggle layers above" | Idle inspector teaches mark grammar; legend strip shows active layers only | Discoverability without covering the map |

Capability audit — everything reachable in the new design:

- **All 21 toggleable layers** — table above; every row individually switchable in the
  grouped rail, findable via omnisearch, states preserved through lens changes marked
  "custom".
- **Country search** — omnisearch, same select-country contract (`selectCountry(id)`),
  jumps pin + opens country panel with the 7 ScoreBar indicators
  (score/trend/confidence/note), summary, investment strengths/risks/sectors.
- **Heatmap mode** — all 12 indicators in grouped select, `none` default, inverted
  indicators flip the ramp and say "high = worse", clear button, exclusive as today.
- **Click-to-inspect** — conflicts (full ConflictCard content: intensity, status,
  parties, situation, casualties, international involvement, summary), events (severity,
  type, confidence, source count, centroid caveat, collapsible intelligence analysis with
  actor goals / bloc-style breakdown / what-to-watch / confidence reasoning),
  chokepoints (risk, lanes through, exposed tickers — the portfolio-trade click
  contract), countries, and a generic facility panel so every infrastructure mark on all
  point layers is clickable (the current app gives these tooltip-only detail).
- **Esc to close**, zoom controls, drag pan — preserved.

Caught and fixed during this audit: Esc-closes-selection existed in `App.tsx` and was
missing from the first draft (added to `map-view.tsx`); the rich hover tooltips
(route value/goods, infrastructure importance tier, event coordinate-quality badges)
are downgraded to `<title>` in the SVG mockup — **production should keep the existing
tooltip content contract**, restyled to surface tokens. One deliberate simplification to
flag: the current country-relationship fill colors (ally/neutral/rival tints when a
country is selected) are represented by a selection pin in the mockup; production keeps
the fill mechanic with token-aligned tints — reviewer call on whether relationship
coloring stays default-on.

## 5. For review

1. **Lens set and default** — is "Morning brief" (conflicts + zones + events) the right
   wake-up state? Which lens combos would you actually use?
2. **Conflict-zones de-ganging** — independent toggle (as designed) or keep zones
   following the conflicts switch?
3. **Sequential-blue ramp** replacing red→green for the heatmap — comfortable reading
   "investment attractiveness" without green=good?
4. **Inspector width (300px)** vs the current 400–460px country panel — enough for the
   analysis content, or should it expand on demand?
5. **Relationship fill colors** (ally/rival) on country selection — keep, move behind a
   toggle, or drop?

## 6. Round-2 fixes (2026-07-08)

Applied after live-preview testing; questions 1–5 above are unchanged and still open.

- **Antimeridian zigzag fixed** — routes/lanes crossing ±180° (Trans-Pacific,
  TWN→USA and KOR→USA semiconductor lanes) previously drew one straight segment
  wrapping backwards across the whole canvas. `map-canvas.tsx` now splits any
  `Line.path` segment with |Δlng| > 180° at the antimeridian (latitude
  interpolated at the crossing) and renders one `<path>` per sub-segment, so
  Pacific crossings hug the left/right map edges. Production equivalent: MapLibre
  handles wrapping natively, but any GeoJSON route data should still be
  antimeridian-split per RFC 7946 §3.1.9.
- **Place-name labels added** — new `MAP_LABELS` in `data.ts` (countries from
  `COUNTRY_INDEX` + the oceans/seas the routes traverse), rendered in `--ink-3`
  above landmass silhouettes and below all marks, `pointer-events: none`.
  Water labels are italic + letterspaced; positions hand-tuned to clear layer
  marks at default zoom; labels scale with SVG zoom. Mockup-only: the production
  MapLibre basemap ships its own label layer, so this list is not part of the
  design contract (though the *set* of waters labeled is a decent starting spec).

## 7. Round 3 — review feedback applied (2026-07-08)

All five round-1 questions were answered, plus one new problem raised. Per item:

**1. Facility layers show too few marks (new issue) → Facility detail control.**
The reviewer collected full registries (hundreds of facilities per layer) and wants to
see them: *"I want to see it all … you might have function for me to select that show
only importance one or show all."* Implemented as one global **"Facility detail: Key /
All"** segmented control in the rail (between Country shading and the layer groups):

- **Key** (default) shows each layer's curated importance tier — the readable morning
  picture.
- **All** shows the full registry, combined with zoom-based decluttering: extra
  (tier-2) facilities render at 60% size / 55% opacity at world view so the map stays
  readable, and grow to full marks once you zoom into a region (zoom ≥ 2×).

Why this mechanism: a single global toggle, not per-layer switches (10 more toggles
would bury the rail, and "how much detail do I want" is one mental setting); not
clustering (cluster blobs hide the individual facilities the reviewer explicitly wants
to see — decluttering keeps every mark individually visible and clickable). Mockup
demonstrates with `tier: 2` sample rows on all nine facility layers (airports go
6 → 16, etc.); production maps tier to each registry's own importance/significance
field and adds grid-collision decluttering for the densest layers (300–500 points).

**2. Default lens — confirmed, no change.** "Morning brief" stays the default.

**3. Conflict-zones de-ganging — confirmed, no change.** Independent toggle stays.

**4. Real country borders + shading that fills the actual country.** The reviewer
wants border lines to learn world geography from the map, and country-level color
that unambiguously covers a specific country (*"heatmap I want to see on the color
level, not like circle around area cause I don't know which country that include"*).
Done — and better than the hand-drawn-handful plan: the hand-drawn continent blobs
are **replaced with real country polygons for all 176 countries**, generated from the
repo's own production geodata (`apps/unified-platform/public/countries-110m.json`,
Natural Earth 110m — the exact file the production MapLibre basemap renders) by
`bake-countries.mjs` (Douglas–Peucker 0.35°, antimeridian-split, 67 KB output in
`countries-geo.ts`). Consequences:

- Every country has a visible hairline border; hovering shows its name; **clicking
  any country selects it** and opens the country panel (previously only search could
  select a country) — directly serves the "train me to memorize the map" goal.
- Country Heatmap / Water Stress / Food Security now fill the country's real shape
  (choropleth), not a soft circle. The soft-circle `Shading` mark is gone.
- Ally/rival tints (item 6) also fill real shapes.
- Selected country gets an accent border on its shape; countries absent from the
  110m set (Singapore) fall back to the round-1 pin.
- Production note: production does **not** import `countries-geo.ts` — it renders
  the same source file at full resolution in MapLibre. The generated file only
  proves the interaction/visual model at review fidelity.
- Found while testing: Russia/Fiji/Aleutian polygons cross ±180° and drew a
  horizontal band across the map (the polygon version of the round-2 route zigzag);
  the bake script now unwraps and clips rings at the antimeridian.

**5. Inspector too narrow → expandable, Google-Maps style.** The reviewer asked to
"expand more … like Google Maps". Implemented the Google-Maps place-panel pattern:
the inspector stays a slim **300px docked rail by default** (simple selections —
chokepoint, facility — never crowd the map), and every panel header now has an
expand control (« / ») that grows it to **min(560px, 65%) as an overlay sliding over
the canvas from the right** — the map keeps its full width underneath and stays
usable to the left, exactly like Google Maps. Wide mode reflows content-heavy
sections to two columns (event actor-goals, country indicator bars). Closing the
selection auto-collapses so the next selection opens unobtrusive. Why not drag-to-
resize: a two-state toggle is predictable, remembers nothing, and matches the
Google Maps reference; free-form resize adds fiddly state for no reviewer-visible
benefit. (Small screens keep the stacked full-width inspector; expansion is
desktop-only.)

**6. Ally/rival coloring — confirmed, kept, now on real shapes.** Selecting a country
tints its allies (`--gain`) and rivals (`--loss`) over their actual polygons, with a
"Relations · <country> — ally / rival / unshaded = neutral" chip top-left while
active. Sample relationship data for THA / TWN / USA / CHN / RUS in
`COUNTRY_RELATIONS`; production reads the alliances block already present in
`data/countries/<ISO3>.json`. Relationship tints take priority over heatmap fills
while a country is selected (an explicit selection act outranks ambient shading).

**Dark-basemap ramp refinement (found in live testing, relates to open question
below):** with the design-system light→dark ramp, LOW scores glowed brightest on the
graphite map (Sudan 1/10 outshone USA 9/10 — light-on-dark = maximum salience). Fills
now map **brightness to the raw value** ("big number glows": 9/10 attractiveness and
4.8 extreme water stress both read as bright), and the legend gradients render
dark→bright to match. The "(high = worse)" label still carries interpretation for
inverted indicators.

**Still open — heatmap ramp hue.** The round-1 question about the ramp *color*
(sequential accent-blue, as implemented, vs. the old red→green) was **not** settled
by this feedback round: the reviewer's answer was about *where* the color goes
(country shapes), not *which* color. Blue stays per the round-1 recommendation
(colorblind-safe, status colors reserved for alerts); flag for a future round if
red→green is preferred after seeing the country fills.
