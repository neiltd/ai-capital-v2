# thai-tax-advisor — Thai Tax & Investment Advisor (review mockup)

A new screen: **"senior Thai personal-income-tax agent who is also a senior investor"** —
plans the year's tax-advantaged purchases against the user's REAL portfolio, shows live
bracket math, and presents agent-generated fund suggestions that weigh tax savings against
long-term investment quality. NOT the existing /portfolio/tax page (that is capital-gains
loss **harvesting** — unrelated to personal income tax).

Files: `page.tsx` (wrapper + nav note) · `planner.tsx` ('use client' — the whole
interactive screen) · `tax-engine.ts` (pure 2026 Thai PIT math — brackets, caps, cap
interactions; the ONE file to audit) · `data.ts` (sample profile/advisor output + real
holdings tie-in).

Live preview (temporary route, sample data only): **http://localhost:3000/tax-advisor-preview**

---

## 1. Nav placement — Portfolio → "Tax Planner", and rename the old "Tax" → "Harvesting"

Proposed sidebar (AppShell.tsx `SECTIONS`):

```
Portfolio
  Holdings
  Risk
  Tax Planner   ← NEW  /portfolio/tax-planner   (this screen)
  Harvesting    ← RENAME existing /portfolio/tax (loss harvesting)
  Theses
```

Why not top-level: the sidebar is organized by the morning question, and "how do I cut my
Thai tax bill with what I hold and what I can buy" is a portfolio-money question — it
consumes portfolio state (ThaiESG/tax_locked positions, THB cash) and produces a value the
Portfolio section needs (see §5). Why the rename: two nav items both called "Tax" doing
completely different taxes is a collision; "Harvesting" is what that page's own H1 already
half-says ("Tax & Harvesting"). If the rename is rejected, "Thai PIT Planner" still works
as a distinct label.

## 2. Interaction model — an agent's worksheet, not a form

- **One state, everything live.** Income (editable in the first stat tile), household
  chips (spouse/children/parents steppers), and per-category planned amounts all re-run
  `evaluatePlan()`; tiles, capacity meters, the ฿500k combo meter, the bracket ladder, and
  each advisor pick's "saves ~฿X" delta update together. This is the "help me plan the
  portions" quality — you drag amounts, tax moves.
- **Committed vs planned.** Each category meter shows *contributed* (accent, from the
  book/payroll — can't be undone) vs *planned* (lighter blue step) vs remaining room —
  two lightness steps of the app's validated sequential blue, 2px gaps, values always also
  printed as text (never color-alone).
- **Advisor picks are agent output, not UI copy.** Each card: BUY badge + category chip +
  fund + ConvictionBadge, the amount with a live computed tax saving, then two labeled
  rationale lines — **tax —** and **investing —** — plus a caveat line. "Add to plan"
  pushes the amount into the planner (and "Apply plan" / "Reset" do the set). The
  investing line is deliberately capable of *arguing against* maxing a category (the
  ThaiESG pick is sized below available room because the book is already
  Thailand-concentrated) — that's the "senior investor, not deduction-maximizer" behavior.
- **Agent flags** carry the senior-agent judgment that isn't a number: residency risk,
  PFM009 classification, the SSF lapse, the Por. 161/2566 remittance rule, Easy E-Receipt
  watch. Levels use status colors with text labels.
- **Honesty baked in:** info AlertBanner up top ("tool-generated estimate — not licensed
  advice"), per-card caveats, a Method & assumptions footer card with the bracket table,
  and sample figures explicitly labeled sample.

## 3. Real-portfolio tie-in (values from simulation.json, 2026-07-08)

- `K-ESGSI-THAIESG` ฿12,345 + `K-TNZ-THAIESG` ฿14,512 (both `tax_locked`) seed the
  ThaiESG "contributed" segment — **as a proxy**: room is consumed by 2026 *purchase
  cost*, which the snapshot doesn't carry. Surfaced as a warning flag, and it's a real
  backend gap (needs per-ticker trade history).
- `PFM009` ฿457,141 ("Social Security Fund (KBank)", `tax_locked`) is shown but
  deliberately **unclassified** — PVD vs SSO decides whether its 2026 inflows consume the
  ฿500k retirement combo. One question for the human (flags card).
- THB cash ฿421,813 is the "dry powder" line; the plan total is checked against it and
  warns when a plan would require USD conversion (which trips the remittance flag).
- The advisor's diversification reasoning uses the real book shape (~66% THB assets,
  ~12% US equity) to justify a global RMF over more Thai paper.

## 4. Agent architecture intent (for implementation)

Same pattern as `src/lib/studio/agent.ts`: a `buildSystemPrompt()` fed (a) the rule table
from `tax-engine.ts`, (b) the portfolio snapshot + trade history, (c) a fund-facts table
(expense ratios, returns — new ingestion), producing structured recs
(`AdvisorRec`-shaped JSON) + flags. The mockup's `ADVISOR_RUN` is exactly that shape. The
deterministic math NEVER comes from the LLM — `tax-engine.ts` computes; the agent chooses
and explains. Present like /discover (autonomous run with a stamp), not a chatbot.

## 5. Marginal-bracket handoff

`/portfolio/tax` (harvesting) defers its "Plan harvest" dialog because the marginal Thai
PIT bracket is "currently nowhere in the system". This screen computes it live
(`after.tax.marginalRate`) and the tile footnote says so. Implementation should persist
the profile + computed marginal rate (user-config store, backend gap) so the harvest page
can read it.

## 6. Tax-figure assumptions — VERIFY DURING IMPLEMENTATION

All figures live in `tax-engine.ts` (constants `PIT_BRACKETS_2026`, `LIMITS`) with VERIFY
markers. Encoded from knowledge current to Jan 2026 — no live sources were consulted from
this sandbox; Sonnet must check against the Revenue Department / a current-year source:

| Item | Encoded value | Confidence |
|---|---|---|
| PIT brackets | 0/5/10/15/20/25/30/35%, thresholds 150k/300k/500k/750k/1M/2M/5M | High (unchanged since 2017) — verify no 2026 restructure |
| Employment expense | 50% capped ฿100k | High |
| Personal / spouse | ฿60k / ฿60k | High |
| Child | ฿30k (฿60k for 2nd+ born 2018+ **not modeled** — UI footnote) | High, simplification flagged |
| Parental care | ฿30k × ≤4 qualifying parents | High |
| Social security | max ฿9,000 (5% × ฿15k/mo ceiling) | Medium — a wage-ceiling raise was long-debated; verify 2026 ceiling |
| PVD | ≤15% of wages, inside combo | High |
| RMF | ≤30% of income, inside combo | High |
| Pension insurance | ≤15%, max ฿200k, inside combo | High |
| Retirement combo | ฿500k (RMF+PVD+pension; NSF not modeled) | High |
| **SSF** | **No 2026 row — lapsed after tax year 2024** | High on lapse; verify no successor scheme for 2026 |
| ThaiESG | ≤30%, max ฿300k, 5-yr lock, outside combo | **Medium — original window 2024–2026; verify still open + whether ThaiESGX affects 2026** |
| Life / health insurance | ฿100k / ฿25k, combined ≤ ฿100k | High |
| Parents' health insurance | ฿15k | High |
| Mortgage interest | ฿100k | High |
| Donations | ≤10% of net; education ×2 then general on remainder | Medium — ordering is a simplification of RD rules |
| Easy E-Receipt | Not counted; watch-flag only | 2026 round unannounced as of encoding |

Other deliberate simplifications: §40(1) employment income only; no NSF; no withholding
credit / mid-year projection; THB-native display (Thai tax is THB — deviates from the
app's USD-first convention, with FX shown in the header).

## 7. Open questions for review

1. **Nav rename** — OK to rename "Tax" → "Harvesting"?
2. **PFM009** — is it a provident fund (consumes the ฿500k combo) or SSO? One answer
   unlocks ฿500k of cap math.
3. **Residency 2026** — will you be in Thailand ≥180 days in 2026? If not, the whole page
   needs a non-resident mode (deductions vs Thai-source income only). Should mockup v2
   design that mode?
4. **Income source** — is a manual income field right for v1, or should the agent estimate
   from KBank payroll data you'd feed it?
5. **Fund tickers** — sample picks use KAsset funds (KGARMF, K-TNZ top-up) since the book
   is K-heavy; real implementation needs a fund-facts ingestion (expense ratio, returns).
   Is a per-fund facts table a build you want, or should the agent reason from fund class
   only?
6. **Interactivity depth** — number inputs + ±10k/Max chips here; want sliders instead?
7. **Where does the profile live** — new user-config store (also serves harvest page §5)?
