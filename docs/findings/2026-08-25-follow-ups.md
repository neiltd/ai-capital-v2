# Follow-up findings — opened 2026-08-25

Deliberately **not** fixed during the test-contamination incident. Each is real,
each is separable, and bundling them into a safety fix would have made that fix
harder to review. Recorded here so they are not lost.

---

## F1 — The workspace test command cannot give a trustworthy signal

**Severity: medium. Systemic consequence, not a single bug.**

Two independent defects combine so that `pnpm -r --if-present test` — the
command documented in `CLAUDE.md` — can never exit green:

**F1a. `dependency-graph-engine`: three suites never execute.**
`tests/store.test.ts:5`, `tests/exporter.test.ts:5` and
`tests/seed-loader.test.ts:5` all import `../src/store/sqlite.js`, which does
not exist. The June polymorphic-store refactor renamed it; the directory now
holds `graph-store.ts`, `graph-store-pg.ts`, `graph-store-sqlite.ts`,
`graph-store-types.ts`, and `createGraphStore` is exported from
`graph-store.ts:9`. The three files report as "failed to load", so **the graph
store currently has no test coverage at all** — a silent-hole shape this project
has been bitten by before.
*Fix:* repoint the imports. Note from the 2026-08-19 session that this is not
purely mechanical — the refactor also made `GraphStore` async, so the tests need
a sync→async rewrite, and `createGraphStore()` routes to Postgres whenever
`DATABASE_URL` is set, so the tests should import `createSqliteGraphStore` from
`graph-store-sqlite.js` directly.

**F1b. `apps/trade-graph`: a `test` script with zero test files.**
`vitest run` exits 1 with "No test files found". Because the script exists,
`--if-present` does not skip it.
*Fix:* add tests, or drop the `test` script so `--if-present` does the right
thing.

**Why this matters more than either bug alone:** a top-level command that is
permanently red trains developers *and agents* to ignore its exit code. During
the 2026-08-25 incident Warden's first verification attempt bailed after four
seconds on F1a and would have been reported as a pass by anyone not checking.
An always-red signal is worse than no signal.

Also worth capturing: `pnpm -r --if-present test` **bails on the first failing
package** and never runs the rest. `--no-bail` is required to exercise the
workspace. `CLAUDE.md` should say so.

---

## F2 — Watchlist reconstruction / provenance gap

**Severity: medium. Architectural, needs a design discussion, not a patch.**

Ten tickers live in `capital.watchlist` with **no version-controlled canonical
source**: `ABBV, BAC, GS, JNJ, JPM, MARKET, MRNA, NOW, V, VOO`. They were added
manually through the `addCompany` CLI. `themes.config.ts` / `themes-map.json`
contain the other 111, and `WatchlistManager.sync()` can reconstruct only those.

**Consequence, demonstrated rather than theoretical:** when JPM was corrupted by
a test fixture on 2026-08-25, there was no source of truth to restore from. No
WAL archive, no backup, and the SQLite fallback (last written 2026-07-17)
contains only the config tickers. The repair had to be a *reconstruction* from
the `addCompany` formula, not a restoration — high confidence, but not the
recovered historical value.

**Related unresolvable question from the same incident:** `sync()` sets
`active = true` unconditionally, so if anyone had previously run `removeCompany`
on a config-managed ticker, the test-driven sync would have silently
reactivated it with no trace. All 121 rows are currently active and no baseline
exists to check against.

**Options to weigh later** (not a decision now): promote manual additions into
version-controlled config; add durable provenance columns (who/when/why); keep
an append-only watchlist change log; or accept the gap and add periodic
snapshots. The design question is what the canonical source of truth for the
watchlist actually is — today it is the database, and the database has no
history.

---

## F3 — `capital.chunks.content` has two coexisting normalisations

**Severity: low-medium. Pre-existing, unrelated to the incident, flagged in passing.**

The same column holds both whitespace-preserved and whitespace-stripped text:
6,681 rows say `NVIDIA Corporation`, 1,327 say `NVIDIACorporation`; likewise
`GlobalMarketIntelligence`, `AdvancedMicroDevices`, `BankofAmerica`. Real
article text is affected too — `Jabilraisesannualprofitforecastamidstrongdatacenterdemand`.

Two consequences already observed:
1. It produced false positives during contamination hunting — legitimate June
   news matched a fixture-shaped `%datacenterdemand%` probe. That is why the
   incident cleanup deleted strictly by primary key.
2. It smells like the lookup-table/case-sensitivity failure class that has bitten
   this project before (the Finnomena fund-ID bug, and the claim parser's
   `type:` casing found the same day).

Worth a separate look at which ingestion path strips whitespace and whether
retrieval quality is affected.

---

## F4 — `news_search_terms` is dead data on the production read path

**Severity: medium. Found by Warden while verifying the JPM repair.**

Nothing in production reads `newsSearchTerms`. Monorepo-wide the identifier
appears only in `src/types.ts`, the two writers (`watchlist-manager.ts`,
`cli-watchlist.ts`), the two stores, and tests. The actual news query is built
from other fields entirely:

`apps/capital-intelligence-ingestion/src/clients/google-news.ts:48-49`
```ts
const ticker = company.ticker.replace(/\.BK$/, '')
return `"${company.company}" OR ${ticker} stock`
```
`yahoo-news.ts:79` uses `company.ticker` only.

**Consequences:**
1. Every curated `extraSearchTerms` entry in `themes.config.ts` is silently
   unused. Someone wrote those deliberately and they do nothing.
2. It lowers the *urgency* of the JPM repair in hindsight — a contaminated
   search-term field could not have degraded ingestion, because the field is not
   consulted. JPM ingestion was healthy throughout (1,975 documents, latest
   fetch 2026-08-24, in line with BAC 2,044 and GS 2,088). Repairing a corrupted
   column to its correct value remains right regardless.

Worth deciding whether the read path should use the curated terms, or whether
the column and its config entries should be removed. Carrying a field that looks
authoritative and is ignored is its own hazard.

---

## F5 — Stale SQLite fallback diverges from the live watchlist

**Severity: low. Pre-existing.**

`apps/capital-intelligence-ingestion/data/sqlite.db` was last written
2026-07-17 and holds 106 rows against the live 121 — missing 15 tickers
including JPM. Any ad-hoc CLI run **without** `DATABASE_URL` operates on that
stale copy. It is not a contamination risk (it cannot reintroduce the fixture
value, and it has no JPM row at all), but it is a silent-wrong-data path of the
same family as the 2026-07-05 CRWD split incident.

---

## F6 — Incident #1's blast radius was larger than recorded

**Severity: record-keeping. Found by Warden 2026-08-26. Nothing survives.**

`desk.agent_claims` was created by migration `008` at 2026-08-25 04:45:13-07.
Its lifetime `pg_stat` counters show **79 insert events, 45 updates and 73
deletes against the production table** — far more than the 16 rows attributed to
the 2026-08-26 claim-writer incident.

Migration `009` (20:57:15) added `recorded_by NOT NULL` plus
`CHECK (capture_method <> 'self' OR lower(recorded_by) = lower(claimant))`. Any
pre-existing row would have been backfilled `recorded_by='unknown'`,
`capture_method='self'` and failed that CHECK. It applied cleanly — which
**proves the table was empty at 20:57:15**.

So roughly 63 insert events and most of the 45 updates hit
`desk.agent_claims` **in production on 2026-08-25**, from the original
`agent-claims.test.ts` running through `getPool()`/`DATABASE_URL` before test
isolation existed. Warden's second audit did note "63 claim rows inserted into
the live book, 57 deleted by the test's own cleanup, 6 rolled back" — but that
never made it into the incident record, and an earlier draft comment in `009`
asserted the opposite ("the table has never held a row").

**Nothing survives** — the table is empty and verified so by exhaustive regex
search across every text column in every production table. This is a correction
to the historical account, not live contamination.

**Method note worth keeping:** `n_tup_ins − n_tup_del` counts *tuples*, not
surviving rows. A rolled-back `INSERT` still increments `n_tup_ins`, and
`TRUNCATE` removes rows *without* incrementing `n_tup_del`. Warden validated
both on a throwaway database rather than assuming. So `79 − 73 = 6` here means
six tuples from transactions that rolled back, not six missing rows.

## F7 — An unreconciled count in the 2026-08-26 incident narrative

One execution of `claim-governance.test.ts` writes 11 successful claim inserts
and 3 run records. Six run records were found, implying two executions and
therefore ~22 claim rows — but 16 were deleted. Both runs failed partway
(8 and 1 failing tests respectively), which plausibly accounts for the
shortfall, but that is inference rather than evidence.

It does not affect cleanliness: the table is empty, the arithmetic balances, and
no fixture signature survives anywhere in production. Recorded because the
narrative does not fully reconcile and should not be presented as if it does.
