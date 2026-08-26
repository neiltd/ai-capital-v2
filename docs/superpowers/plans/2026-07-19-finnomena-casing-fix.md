# Fix Finnomena Fund-ID Casing Bug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the case-sensitive Finnomena fund-ID lookup that silently fails for tickers whose official fund code isn't all-caps (K-ESGSI-THAIESG, K-TNZ-THAIESG), revert an earlier data fix that mistakenly disabled the (actually-working) Finnomena fallback for three other tickers, and add the same price-sanity guard the Yahoo path already has to the Finnomena path.

**Architecture:** All code changes are in one file, `apps/scenario-simulator/src/portfolio/price-fetcher.ts`: a case-insensitive index built once at module load, plus extracting an existing plausibility-check closure into a shared function used by both the Yahoo and Finnomena code paths. One Postgres data fix (not code) reverts three `price_symbol` overrides back to their unset convention.

**Tech Stack:** TypeScript, vitest, PostgreSQL.

Full design context: `docs/superpowers/specs/2026-07-19-finnomena-casing-fix-design.md`.

---

### Task 1: Case-insensitive Finnomena fund-ID lookup

**Files:**
- Modify: `apps/scenario-simulator/src/portfolio/price-fetcher.ts:10-16`
- Modify: `apps/scenario-simulator/tests/price-fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/scenario-simulator/tests/price-fetcher.test.ts`, inside the
existing `describe('fetchPrices', ...)` block, after the last test:

```ts
  it('resolves a Finnomena fund via case-insensitive ticker matching', async () => {
    // K-ESGSI-ThaiESG -> F00001M4QH is a real entry in finnomena-fund-ids.json.
    // This system stores the ticker upper-cased as K-ESGSI-THAIESG, which
    // must still resolve to the same fund_id despite the casing mismatch.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any) // Yahoo — not exchange-listed
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.8548, d_change: 0 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.8548 })
    const finnomenaUrl = (global.fetch as any).mock.calls[1][0] as string
    expect(finnomenaUrl).toContain('F00001M4QH')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/scenario-simulator && npx vitest run tests/price-fetcher.test.ts`

Expected: FAIL — `prices` is `{}` instead of `{ 'K-ESGSI-THAIESG': 10.8548 }`,
because the current case-sensitive lookup (`FUND_ID_BY_TICKER['K-ESGSI-THAIESG']`)
misses the table's `'K-ESGSI-ThaiESG'` key.

- [ ] **Step 3: Build a case-insensitive index**

In `apps/scenario-simulator/src/portfolio/price-fetcher.ts`, change:

```ts
import finnomenaFundIds from './finnomena-fund-ids.json' with { type: 'json' }

const FUND_ID_BY_TICKER = finnomenaFundIds as Record<string, string>

async function fetchFinnomenaPrice(ticker: string): Promise<number | null> {
  const fundId = FUND_ID_BY_TICKER[ticker]
  if (!fundId) return null
```

to:

```ts
import finnomenaFundIds from './finnomena-fund-ids.json' with { type: 'json' }

const FUND_ID_BY_TICKER = finnomenaFundIds as Record<string, string>

// Finnomena's official fund codes use inconsistent casing (e.g.
// "K-ESGSI-ThaiESG"), while this app's tickers are stored all-caps
// ("K-ESGSI-THAIESG") — a case-sensitive lookup silently misses for any
// fund whose real code isn't already all-caps. Build a case-insensitive
// index once at module load so ticker casing never matters here.
const FUND_ID_BY_TICKER_UPPER: Record<string, string> = {}
for (const [key, value] of Object.entries(FUND_ID_BY_TICKER)) {
  FUND_ID_BY_TICKER_UPPER[key.toUpperCase()] = value
}

async function fetchFinnomenaPrice(ticker: string): Promise<number | null> {
  const fundId = FUND_ID_BY_TICKER_UPPER[ticker.toUpperCase()]
  if (!fundId) return null
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/scenario-simulator && npx vitest run tests/price-fetcher.test.ts`

Expected: all 5 tests PASS (4 pre-existing + 1 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/scenario-simulator/src/portfolio/price-fetcher.ts apps/scenario-simulator/tests/price-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(scenario-simulator): case-insensitive Finnomena fund-ID lookup

FUND_ID_BY_TICKER was a case-sensitive lookup keyed by Finnomena's
official fund codes, which use inconsistent casing (e.g.
"K-ESGSI-ThaiESG"). This app's tickers are stored all-caps
("K-ESGSI-THAIESG"), so K-ESGSI-THAIESG and K-TNZ-THAIESG silently
never resolved a fund_id and never got a live NAV — the position
tracker was carrying a stale manually-set price for both, understating
K-ESGSI-THAIESG's real loss by more than 3x (-4.56% tracked vs.
-17.59% real). Building a case-insensitive index fixes both tickers
immediately (neither has a price_symbol override, so their raw ticker
already flows into this lookup) and makes this correct for any future
Thai fund ticker regardless of how Finnomena happens to case its code.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared plausibility guard, applied to the Finnomena path too

**Files:**
- Modify: `apps/scenario-simulator/src/portfolio/price-fetcher.ts:19-97` (post-Task-1 line numbers)
- Modify: `apps/scenario-simulator/tests/price-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/scenario-simulator/tests/price-fetcher.test.ts`, after the
test added in Task 1:

```ts
  it('rejects an implausible Finnomena NAV move (>60% vs previous)', async () => {
    // d_change: 90 on a value of 100 implies a previous NAV of 10 — a 900%
    // jump, the same class of bad-fetch bug that corrupted the KLAC
    // discovery position on 2026-06-02.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 100, d_change: 90 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({})
  })

  it('accepts a plausible Finnomena NAV move', async () => {
    // d_change: 0.05 on a value of 10.85 implies a previous NAV of 10.80 —
    // a small, ordinary daily move.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.85, d_change: 0.05 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.85 })
  })

  it('accepts a Finnomena NAV when d_change is missing (nothing to compare against)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { value: 10.85 } }) } as any)

    const prices = await fetchPrices(['K-ESGSI-THAIESG'])

    expect(prices).toEqual({ 'K-ESGSI-THAIESG': 10.85 })
  })
```

- [ ] **Step 2: Run the tests to verify the rejection test fails**

Run: `cd apps/scenario-simulator && npx vitest run tests/price-fetcher.test.ts`

Expected: 7 of 8 tests PASS. The **"rejects an implausible Finnomena NAV
move..."** test FAILS — `prices` is `{ 'K-ESGSI-THAIESG': 100 }` instead of
`{}`, because the Finnomena path doesn't check plausibility yet. (The other
two new tests already pass, since accepting a plausible/uncheckable move is
also what happens with no guard at all — they'll still be valid once the
guard exists.)

- [ ] **Step 3: Extract the plausibility check and apply it to both paths**

In `apps/scenario-simulator/src/portfolio/price-fetcher.ts`, the file (after
Task 1) looks like this from the case-insensitive index through the end of
`fetchPrice`:

```ts
const FUND_ID_BY_TICKER_UPPER: Record<string, string> = {}
for (const [key, value] of Object.entries(FUND_ID_BY_TICKER)) {
  FUND_ID_BY_TICKER_UPPER[key.toUpperCase()] = value
}

async function fetchFinnomenaPrice(ticker: string): Promise<number | null> {
  const fundId = FUND_ID_BY_TICKER_UPPER[ticker.toUpperCase()]
  if (!fundId) return null
  const url = `https://www.finnomena.com/fn3/api/fund/v2/public/funds/${encodeURIComponent(fundId)}/latest`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' } })
    if (!res.ok) {
      console.warn(`Finnomena price fetch failed for ${ticker} (fund_id ${fundId}): HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { status: boolean; data?: { value?: number } }
    const nav = data.status ? data.data?.value : undefined
    if (typeof nav === 'number' && nav > 0) return nav
    console.warn(`Finnomena price fetch returned no usable NAV for ${ticker} (fund_id ${fundId})`)
    return null
  } catch (error) {
    console.warn(`Finnomena price fetch error for ${ticker}:`, error)
    return null
  }
}

async function fetchPrice(ticker: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      // Yahoo has no listing for Thai mutual/RMF/ThaiESG fund codes — try
      // Finnomena's NAV feed before giving up.
      const finnomenaPrice = await fetchFinnomenaPrice(ticker)
      if (finnomenaPrice !== null) return finnomenaPrice
      console.warn(`Price fetch failed for ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: {
        result: Array<{
          meta: { regularMarketPrice?: number; previousClose?: number }
          timestamp: number[]
          indicators: { quote: Array<{ close: (number | null)[] }> }
        }> | null
        error?: { code: string; description: string }
      }
    }
    if (data.chart.error) {
      console.warn(`Price fetch error for ${ticker}: ${data.chart.error.description}`)
      return null
    }
    const result = data.chart.result?.[0]
    if (!result) return null
    const previousClose = result.meta.previousClose

    // Sanity check — Yahoo occasionally returns a garbage regularMarketPrice
    // (bad upstream tick, stale cache, ticker collision). A >60% single-day
    // move against the same response's previousClose is implausible for the
    // kind of equities this system trades; reject rather than silently book
    // it. This is exactly the class of bug that corrupted the KLAC discovery
    // position on 2026-06-02 (avg_cost $2003 vs a real price near $230) —
    // caught only a month later because nothing validated the fetch.
    function plausible(price: number): boolean {
      if (!previousClose || previousClose <= 0) return true // nothing to compare against
      return Math.abs(price - previousClose) / previousClose <= 0.6
    }

    // Prefer live market price, fall back to last close
    const live = result.meta.regularMarketPrice
    if (live && live > 0) {
      if (!plausible(live)) {
        console.warn(`Price fetch rejected for ${ticker}: regularMarketPrice ${live} implausible vs previousClose ${previousClose}`)
        return null
      }
      return live
    }
    const closes = result.indicators.quote[0]?.close ?? []
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        const c = closes[i] as number
        if (!plausible(c)) {
          console.warn(`Price fetch rejected for ${ticker}: last close ${c} implausible vs previousClose ${previousClose}`)
          return null
        }
        return c
      }
    }
    return null
  } catch (error) {
    console.warn(`Price fetch error for ${ticker}:`, error)
    return null
  }
}
```

Replace that entire block with:

```ts
const FUND_ID_BY_TICKER_UPPER: Record<string, string> = {}
for (const [key, value] of Object.entries(FUND_ID_BY_TICKER)) {
  FUND_ID_BY_TICKER_UPPER[key.toUpperCase()] = value
}

// A >60% single-fetch move is implausible for the kind of assets this
// system prices (equities, Thai mutual funds) — reject rather than
// silently book it. See the KLAC discovery-position incident, 2026-06-02
// (avg_cost $2003 vs a real price near $230, caught a month later because
// nothing validated the fetch). Shared by both the Yahoo and Finnomena
// price paths below.
function isPlausiblePriceMove(price: number, previous: number | undefined | null): boolean {
  if (!previous || previous <= 0) return true // nothing to compare against
  return Math.abs(price - previous) / previous <= 0.6
}

async function fetchFinnomenaPrice(ticker: string): Promise<number | null> {
  const fundId = FUND_ID_BY_TICKER_UPPER[ticker.toUpperCase()]
  if (!fundId) return null
  const url = `https://www.finnomena.com/fn3/api/fund/v2/public/funds/${encodeURIComponent(fundId)}/latest`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' } })
    if (!res.ok) {
      console.warn(`Finnomena price fetch failed for ${ticker} (fund_id ${fundId}): HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { status: boolean; data?: { value?: number; d_change?: number } }
    const nav = data.status ? data.data?.value : undefined
    if (typeof nav !== 'number' || nav <= 0) {
      console.warn(`Finnomena price fetch returned no usable NAV for ${ticker} (fund_id ${fundId})`)
      return null
    }
    const dChange = data.data?.d_change
    const previousNav = typeof dChange === 'number' ? nav - dChange : undefined
    if (!isPlausiblePriceMove(nav, previousNav)) {
      console.warn(`Finnomena price fetch rejected for ${ticker}: NAV ${nav} implausible vs previous ${previousNav}`)
      return null
    }
    return nav
  } catch (error) {
    console.warn(`Finnomena price fetch error for ${ticker}:`, error)
    return null
  }
}

async function fetchPrice(ticker: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      // Yahoo has no listing for Thai mutual/RMF/ThaiESG fund codes — try
      // Finnomena's NAV feed before giving up.
      const finnomenaPrice = await fetchFinnomenaPrice(ticker)
      if (finnomenaPrice !== null) return finnomenaPrice
      console.warn(`Price fetch failed for ${ticker}: HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as {
      chart: {
        result: Array<{
          meta: { regularMarketPrice?: number; previousClose?: number }
          timestamp: number[]
          indicators: { quote: Array<{ close: (number | null)[] }> }
        }> | null
        error?: { code: string; description: string }
      }
    }
    if (data.chart.error) {
      console.warn(`Price fetch error for ${ticker}: ${data.chart.error.description}`)
      return null
    }
    const result = data.chart.result?.[0]
    if (!result) return null
    const previousClose = result.meta.previousClose

    // Prefer live market price, fall back to last close
    const live = result.meta.regularMarketPrice
    if (live && live > 0) {
      if (!isPlausiblePriceMove(live, previousClose)) {
        console.warn(`Price fetch rejected for ${ticker}: regularMarketPrice ${live} implausible vs previousClose ${previousClose}`)
        return null
      }
      return live
    }
    const closes = result.indicators.quote[0]?.close ?? []
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        const c = closes[i] as number
        if (!isPlausiblePriceMove(c, previousClose)) {
          console.warn(`Price fetch rejected for ${ticker}: last close ${c} implausible vs previousClose ${previousClose}`)
          return null
        }
        return c
      }
    }
    return null
  } catch (error) {
    console.warn(`Price fetch error for ${ticker}:`, error)
    return null
  }
}
```

The only behavioral difference from before: `isPlausiblePriceMove` is now a
module-level function (was a per-call closure named `plausible` inside
`fetchPrice`) and `fetchFinnomenaPrice` now also calls it. The Yahoo path's
behavior is otherwise unchanged — same threshold, same comparison, same
warning messages.

- [ ] **Step 4: Run the tests to verify all pass**

Run: `cd apps/scenario-simulator && npx vitest run tests/price-fetcher.test.ts`

Expected: all 8 tests PASS.

- [ ] **Step 5: Run the full app test suite and typecheck**

Run: `cd apps/scenario-simulator && npx vitest run && npx tsc --noEmit`

Expected: all tests PASS, no type errors. (This confirms the refactor didn't
break any other test file that might exercise `fetchPrice`/`fetchPrices`
indirectly, e.g. `portfolio-store.test.ts`.)

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/scenario-simulator/src/portfolio/price-fetcher.ts apps/scenario-simulator/tests/price-fetcher.test.ts
git commit -m "$(cat <<'EOF'
fix(scenario-simulator): apply the >60%-move plausibility guard to Finnomena too

The Yahoo price path has rejected implausible single-fetch price moves
since the KLAC discovery-position incident (2026-06-02), but the
Finnomena NAV path added later (be9717c) had no equivalent guard.
Extracted the check (previously a closure trapped inside fetchPrice)
into a shared isPlausiblePriceMove function and applied it to both
paths. Finnomena's API returns a d_change field alongside the NAV
value, giving a previous-value reference point analogous to Yahoo's
previousClose.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Revert the `.NOFEED` sentinel and verify the live feed resumes

**Files:** none modified in code — a Postgres data fix plus manual
verification, no commit (matches the pattern used for real-data
verification tasks in prior plans in this repo).

- [ ] **Step 1: Confirm current state before changing anything**

Run:
```bash
psql "postgres://thanapold@localhost:5432/ai_capital" -c "SELECT ticker, price_symbol FROM portfolio.positions WHERE ticker IN ('SCBCEH','K-VIETNAM','KFINDIA-A');"
```

Expected: all three show `price_symbol` ending in `.NOFEED` (e.g.
`SCBCEH.NOFEED`).

- [ ] **Step 2: Revert to the unset convention**

Run:
```bash
psql "postgres://thanapold@localhost:5432/ai_capital" -c "
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'SCBCEH';
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'K-VIETNAM';
UPDATE portfolio.positions SET price_symbol = '' WHERE ticker = 'KFINDIA-A';
"
```

Expected: `UPDATE 1` printed three times.

- [ ] **Step 3: Verify the live Finnomena feed resumes for all 5 affected tickers**

Run:
```bash
cd apps/scenario-simulator
DATABASE_URL="postgres://thanapold@localhost:5432/ai_capital" npx tsx src/cli/cli-portfolio.ts show 2>&1 | grep -E "SCBCEH|K-VIETNAM|KFINDIA-A|K-ESGSI-THAIESG|K-TNZ-THAIESG|Ticker|----"
```

Expected: no `Price fetch failed` warnings for any of these 5 tickers (only
`PFM009` should still warn, since it's genuinely not on Finnomena — that's
correct, expected behavior per the design doc, not a bug). All 5 rows show a
live-looking `Price` value with a non-zero `P&L` that reflects real NAV
movement rather than the frozen manual value from before this fix.

- [ ] **Step 4: Regenerate the dashboard snapshot**

Run:
```bash
cd apps/scenario-simulator
DATABASE_URL="postgres://thanapold@localhost:5432/ai_capital" npx tsx src/cli/cli-run.ts
```

Expected: completes without error, writes `data/simulation.json`.
