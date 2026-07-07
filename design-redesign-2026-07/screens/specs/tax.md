# /portfolio/tax — Tax & Harvesting (spec)

**Data:** `investment-analyst-agents/tax/harvest.json` (realizedYTD,
harvestOpportunities, washSaleAlerts, fxRateUsdThb).

## Layout (12-col)

```
┌ StatTiles: YTD realized gains · YTD losses · Net taxable · Harvestable now ┐
├ Wash-sale windows (full width, AlertBanners w/ countdown)                  ┤
├ Harvest opportunities table (8)          │ Jurisdiction explainer (4)      ┤
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components & behavior

- **StatTiles**: `Net taxable $4,971` is the hero; `Harvestable now $859`
  gets a footnote "excludes Thai-exempt, tax-locked, wash-sale-blocked".
- **Wash-sale banners**: one `AlertBanner` per window, `critical` when ≤2
  days, `warning` otherwise; trailing countdown `1d`. These duplicate the
  global status-strip chips deliberately — this page is the source of truth.
- **Harvest table** (DataTable): ticker · `JurisdictionTag` · `StrategyTag`
  · unrealized loss (native + USD subline via `Money`) · harvestable ✓/✗ ·
  notes (truncated, expand on row click). Rows where `harvestable: false`
  render the loss amount in `--ink-3` (muted, NOT loss-red) — a
  non-harvestable loss is context, not an action; color only marks
  actionable rows. Sort: harvestable first, then |loss| desc.
- **Jurisdiction explainer card** (right rail): static four-row legend —
  `TH exempt` (SET equity: gains/losses invisible to tax), `TH taxable`
  (funds: losses offset fund gains), `US taxable` (wash-sale rules apply),
  `locked` (THAIESG/PFM009: never sell). This is the screen where the Thai/US
  asymmetry is *taught*, so every other screen can just use the tag.
- **Row action**: harvestable rows get a "Plan harvest…" button → dialog
  showing offset math (`loss −$286 × your marginal fund-gain rate`) and a
  repurchase-timing note; confirms into the trade log like Promote.

## Empty/edge states

- No wash-sale windows → section hidden entirely (not an empty card).
- `realizedYTD.lossesUSD` known-bug caveat: while backend gap #14 is open,
  footnote "removed positions may under-count losses (avg_cost lost at
  removal)".

## Backend gaps

- #14 realized-loss undercount fix (persist avg_cost at sell time).
- "Plan harvest" needs marginal-rate config (user's Thai PIT bracket) —
  currently nowhere in the system.
- Harvest history (what was harvested when, realized benefit) for a small
  "harvested this year" tally.
