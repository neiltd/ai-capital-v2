# studio-v2 — Creator Studio on the unified graphite theme

Redesign mockups for the three remaining Creator Studio screens:

| Folder | Screen | Route |
|---|---|---|
| `dashboard/` | Growth analytics (followers, video performance, engagement, sessions) | `/studio/dashboard` |
| `archive/` | Browsable history of saved ideation sessions | `/studio/archive` |
| `chat/` | Daily-topic AI chat (**live feature** — visual redesign only) | `/studio/chat` |

Each folder follows the established convention: `page.tsx` (server-component
mockup, sample data inline via the loader) + `data.ts` (loader contract with
real-field mapping). `chat/` additionally has `ChatThread.tsx` — the one
genuinely client-interactive sub-component.

**`screens/studio/` (the sibling folder with `studio-tokens.css`) is
SUPERSEDED by this folder.** Do not build from it.

---

## 1. Theme unification — reversal of design-system.md §8

§8 originally gave Creator Studio a deliberately distinct language
(light/warm paper `#faf7f2`, magenta+orange accents, own shell) on the
rationale that "switching apps should feel like switching apps" and that
instrument-panel chrome would hurt a generative, mood-driven task.

**That decision is reversed as of 2026-07 at the user's direction.** Creator
Studio now uses the exact same graphite system as the other 13 screens:
`tokens.css` custom properties (`bg-page`, `bg-surface`, `text-ink*`,
`border-hairline`, `--accent`, `--gain`/`--loss`), the shared primitives in
`components/next/ui.tsx` (SectionCard, StatTile, Label, AsOf, Th/Td,
AlertBanner) and `components/next/charts.tsx` (Sparkline, HBar). One app,
one visual language; Studio is a sibling section, not a sub-brand.

For the record, the counter-rationale that won: it is one person's tool, and
the cost of maintaining a second token set, second shell, and second set of
primitives for three screens outweighs the mood argument. Consistency also
means Studio inherits every future system improvement (theme toggle, light
mode relief rules, chart specs) for free.

Implementation consequences beyond these three screens:

- **`src/app/(next)/studio/page.tsx` (the board, rebuilt earlier this
  session on the magenta theme) must be normalized to graphite too** — same
  tokens/primitives as these mockups. Its data/sections stand; only styling
  changes.
- **`src/app/(next)/studio/studio-tokens.css` should be deleted** once no
  screen imports it.
- **design-system.md §8 should be rewritten** to document the unification
  (this section is the draft for it).
- The separate Studio top-nav shell goes away. These mockups use a small
  right-aligned sub-nav (`Today's topic · Dashboard · Archive`) inside the
  standard page header, matching how other screens carry their meta. If the
  main sidebar gains a Studio section instead, drop the `StudioNav` helper
  (it's duplicated per-file deliberately so each mockup stands alone).

## 2. Backend gaps discovered

1. **Chat transcripts are not persisted.** `Session` stores topic /
   storyArc / visuals / notes — there is no messages column, and
   `saveSession()` doesn't send them. The archive can therefore only show
   what a session *produced*, never the conversation. If replaying the
   conversation matters, add a `messages` JSON column (or a Message table)
   and include the thread in the save payload.
2. **`storyArc` is never written.** The save endpoint receives only
   `{ topic, visuals }` from `ChatInterface.saveSession()`, so
   `Session.storyArc` (and `notes`) will be `null` on every real row even
   though the schema supports them. Either add an LLM extraction step at
   save time ("distill this thread into hook/beats/personalAngle/cta") or a
   small pre-save form. The archive mockup designs both states (arc card vs.
   muted "No story arc saved").
3. **No Prisma relation for Session↔Video.** `Session.videoId` and
   `Video.sessionId` are bare strings; the archive's "outcome" column
   (linked video performance) needs an app-side join today. Consider real
   `@relation` fields; also nothing currently *sets* `videoId` — the
   VideoForm doesn't offer session linking, so the outcome column will show
   "not filmed" for everything until that exists.
4. **Follower delta needs history.** The dashboard's "+N 7d" delta requires
   a snapshot ≥7 days old; with 0–1 snapshots it renders nothing (handled).
   Snapshots are manual (`source: 'manual'`) — fine, just noting there's no
   automated TikTok ingestion.
5. **GrowthForm / VideoForm restyle.** The legacy client modals
   (`components/studio/dashboard/*.tsx`) provide the "Log snapshot" / "Log
   video" behavior behind the mocked buttons — keep them, restyle to
   graphite (they currently use `components/studio/ui/*` shadcn variants and
   legacy palette classes).
6. **Chat first-paint blocks on Claude.** The legacy server component awaits
   `anthropic.messages.create()` for the opening line before rendering
   anything. Recommend rendering the topic card immediately and streaming
   the opening message into the thread (same streaming path as normal
   replies). Not a schema gap, but the single biggest perceived-quality win
   on this screen.

## 3. Functionality flagged for the implementing engineer

- **Chat behavior is load-bearing.** `ChatThread.tsx` here is a visual shell
  with the plumbing deliberately omitted; the behavior source of truth is
  `src/components/studio/chat/ChatInterface.tsx` — streamed replies,
  ```visual fence parsing → `/api/studio/visuals/:type` → attachment after
  the requesting message, fence-stripping before display, Enter/Shift+Enter,
  auto-scroll, save-once semantics. Port all of it.
- **Empty states are the launch states.** All three tables have zero rows in
  production. Each mockup has an explicit empty branch (`SHOW_EMPTY` /
  `SHOW_NO_TOPIC` toggles in `data.ts`) — wire those branches to real
  zero-row results, don't treat them as dev-only.
- **Archive expansion** uses native `<details>`/`<summary>` to stay
  server-only; the filter row (search + type chips) is a non-functional
  visual spec — wiring it via searchParams or a client wrapper is the
  engineer's call (it only earns its keep at ~20+ sessions).
- **Engagement formula** is the legacy one: `(likes+comments+shares)/views`,
  per-video and overall. The ≥8% green threshold in the videos table is a
  placeholder heuristic — tune once real data exists.
- **`Empty` component is duplicated** across the mockups so each file stands
  alone; promote it into `components/next/ui.tsx` when implementing.
- Charts follow the system's dataviz rules: Followers is the only true time
  series (single accent series, direct-labeled last point, no legend);
  views-by-topic is magnitude → single-hue HBars with labels carrying
  identity; no new colors were introduced, only the already-validated
  tokens.
