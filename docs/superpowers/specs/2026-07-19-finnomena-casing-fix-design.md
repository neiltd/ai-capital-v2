# Fix Finnomena fund-ID lookup casing bug + harden the fallback

## Context

`apps/scenario-simulator/src/portfolio/price-fetcher.ts` has a Finnomena NAV
fallback (added in commit `be9717c`, 2026-07-10) for Thai mutual/RMF/ThaiESG
fund tickers that aren't on Yahoo Finance at all. It resolves a ticker to a
Finnomena `fund_id` via a lookup table (`finnomena-fund-ids.json`, ~7,153
entries pulled from Finnomena's public fund master list), then hits
Finnomena's public (no-auth) NAV endpoint.

This fallback is real and already wired into `fetchPrices()` — the function
`cli-portfolio.ts show` and the daily `scenario-refresh` pipeline stage both
already call. It was never broken in the sense of "missing code"; it's
broken for a subset of tickers due to a data-shape mismatch, discovered while
investigating why `K-ESGSI-THAIESG`'s tracked price had drifted far from its
real NAV (10.8548 THB per Finnomena's live page, vs. ~12.60 THB in our
tracker — a difference that changes the position's reported loss from
-4.56% to -17.59%).

## Root cause

`FUND_ID_BY_TICKER` is a case-sensitive `Record<string, string>` keyed by
Finnomena's **official fund codes**, which use mixed case for some funds:

```
'K-ESGSI-ThaiESG' -> F00001M4QH
'K-TNZ-ThaiESG'   -> F00001INBI
'SCBCEH'          -> F00000POMH
'K-VIETNAM'       -> F000011F2W
'KFINDIA-A'       -> F00000ZIKF
```

Our Postgres `portfolio.positions.ticker` values are stored all-caps
(`K-ESGSI-THAIESG`, `K-TNZ-THAIESG`). When a position has no `price_symbol`
override, `portfolio-store-pg.ts`'s `getPositions()` falls back to using the
raw `ticker` as the fetch symbol (`priceSymbol: r.price_symbol || r.ticker`).
That raw, all-caps ticker gets passed into `fetchFinnomenaPrice(ticker)`,
which does a plain object-key lookup — case-sensitive, so
`FUND_ID_BY_TICKER['K-ESGSI-THAIESG']` misses even though
`FUND_ID_BY_TICKER['K-ESGSI-ThaiESG']` (correct casing) would hit.

SCBCEH, K-VIETNAM, and KFINDIA-A "work" today only because their *official*
Finnomena codes happen to already be all-caps — no casing mismatch for those
three specifically. K-ESGSI-ThaiESG and K-TNZ-ThaiESG have "ThaiESG" in
mixed case in their real codes, so they miss.

## A prior fix in this codebase made this worse for 3 tickers

Earlier in this project's history, SCBCEH/K-VIETNAM/KFINDIA-A returning
small, real-looking NAV numbers (7.9931, 13.9913, 12.0394) when queried by
their raw ticker string was misdiagnosed as "a coincidental Yahoo match on
the literal ticker string" — a plausible-sounding but incorrect theory, since
nobody had yet traced through to `be9717c`'s Finnomena fallback. The fix
applied was to override `price_symbol` to intentionally-invalid sentinel
values (`'SCBCEH.NOFEED'` etc.) so the fetch would 404 cleanly instead of
returning "bogus" data — but the data was never bogus. It was the correct,
working Finnomena fallback. That fix needs to be reverted as part of this
work (see Design section 2).

## Verified evidence

- `python3` check against `finnomena-fund-ids.json` confirms: `'SCBCEH'`,
  `'K-VIETNAM'`, `'KFINDIA-A'` are present as exact keys;
  `'K-ESGSI-THAIESG'` (our casing) and `'K-TNZ-THAIESG'` (our casing) are
  **not** present; `'K-ESGSI-ThaiESG'` and `'K-TNZ-ThaiESG'` (Finnomena's
  casing) **are** present, mapping to `F00001M4QH` and `F00001INBI`
  respectively.
- Live `curl` against `https://www.finnomena.com/fn3/api/fund/v2/public/funds/F00001M4QH/latest`
  confirms the response shape includes a `d_change` field (today's NAV
  change, currently `0` in the sample pull) alongside `value` (the NAV
  itself) — this gives a "previous value" reference point
  (`value - d_change`) analogous to Yahoo's `meta.previousClose`, useful for
  section 3 below.
- PFM009 has no entry anywhere in `finnomena-fund-ids.json` under any casing
  — confirmed correctly out of scope; it's an employer-specific provident
  fund, not a public retail fund, and `be9717c`'s own commit message already
  documents this as expected, not a bug.

## Design

### 1. Case-insensitive fund-ID lookup

In `apps/scenario-simulator/src/portfolio/price-fetcher.ts`, build a second,
uppercase-keyed index from `FUND_ID_BY_TICKER` once at module load:

```ts
const FUND_ID_BY_TICKER_UPPER: Record<string, string> = {}
for (const [key, value] of Object.entries(FUND_ID_BY_TICKER)) {
  FUND_ID_BY_TICKER_UPPER[key.toUpperCase()] = value
}
```

`fetchFinnomenaPrice` looks up via `FUND_ID_BY_TICKER_UPPER[ticker.toUpperCase()]`
instead of `FUND_ID_BY_TICKER[ticker]`. This is a one-time O(n) index build
(n≈7,153, negligible) done once when the module loads, not per-call.

This fixes K-ESGSI-THAIESG and K-TNZ-THAIESG with **no Postgres change**
required — their `price_symbol` is already empty, so the raw ticker already
flows into this function; it just needs to match regardless of case. It also
makes this correct for *any future* Thai fund ticker added to the tracker
without needing a hand-set `price_symbol` override, which is the durable
fix the casing bug calls for — Finnomena's fund-code casing is inconsistent
across funds, so relying on our own ticker casing to happen to match is not
a sound long-term assumption.

### 2. Revert the `.NOFEED` sentinel data fix

A Postgres data change (not code), undoing the earlier mistaken fix.
Verified directly against the database: the column's "unset" convention is
an **empty string**, not `NULL` — e.g. `K-ESGSI-THAIESG` and `K-TNZ-THAIESG`
(both untouched by the earlier mistaken fix) currently have
`price_symbol = ''`, while `SCBCEH`/`K-VIETNAM`/`KFINDIA-A` currently have
the `.NOFEED` sentinel values. Revert to match the established empty-string
convention:

```sql
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'SCBCEH';
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'K-VIETNAM';
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'KFINDIA-A';
```

Once reverted, these three positions' `price_symbol` again falls back to
their raw ticker, which — unlike the two ThaiESG funds — already matches the
lookup table's casing exactly. The live Finnomena feed resumes working on
the next `fetchPrices()` call (e.g. the next `cli-portfolio.ts show` or the
next `scenario-refresh` pipeline run), which will overwrite the current
stale manually-set `current_price`/`current_value`/`unrealized_pnl` with
real data automatically — no separate manual DB correction needed for these
three beyond the `price_symbol` revert itself.

### 3. Plausibility guard on the Finnomena path

`fetchPrice()` (the Yahoo path, same file) already has a `plausible()`
closure that rejects a price if it differs from `previousClose` by more than
60% — added after a real incident (the KLAC discovery-position corruption on
2026-06-02, where a bad fetch went unvalidated for a month). That closure is
currently trapped inside `fetchPrice()`'s function body, not reusable.

Extract it to a shared top-level function:

```ts
// A >60% single-fetch move is implausible for the kind of assets this
// system prices (equities, Thai mutual funds) — reject rather than
// silently book it. See the KLAC discovery-position incident, 2026-06-02
// (avg_cost $2003 vs a real price near $230, caught a month later because
// nothing validated the fetch).
function isPlausiblePriceMove(price: number, previous: number | undefined | null): boolean {
  if (!previous || previous <= 0) return true // nothing to compare against
  return Math.abs(price - previous) / previous <= 0.6
}
```

Use it in both places:
- `fetchPrice()`'s existing two call sites (`live` price check, last-close
  fallback check) — same behavior as today, just calling the extracted
  function instead of an inline closure.
- `fetchFinnomenaPrice()` — widen the parsed response type to include
  `d_change?: number` alongside the existing `value?: number`, compute
  `previousNav = typeof dChange === 'number' ? nav - dChange : undefined`,
  and call `isPlausiblePriceMove(nav, previousNav)` before returning. If
  implausible, `console.warn` (matching the Yahoo path's warning style) and
  return `null` (falls through to the caller's existing null-handling, same
  as any other unpriceable fetch — no new failure mode introduced).

### Out of scope

- PFM009 — confirmed correctly unpriceable via Finnomena (not a public
  fund); no change.
- Building a UI/alerting layer for rejected/implausible price fetches —
  the existing `console.warn` pattern is what both paths already do; this
  task doesn't add new observability beyond matching that existing
  convention.
- Re-auditing `finnomena-fund-ids.json` itself for other casing
  mismatches beyond the two confirmed in this investigation (K-ESGSI-ThaiESG,
  K-TNZ-ThaiESG) — the case-insensitive lookup fix (section 1) makes this
  moot going forward for any ticker in the table, so no manual audit of the
  other ~7,150 entries is needed.
