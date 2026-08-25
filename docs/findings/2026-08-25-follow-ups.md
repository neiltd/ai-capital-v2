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
