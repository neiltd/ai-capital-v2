# Investment Ledger Foundation (Phase 1)

Status: code-only foundation awaiting independent verification and production deployment approval.

## Boundary

`investment_ledger` is the evidence ledger. It is separate from:

- `portfolio.positions`, the manually curated current-position projection;
- `portfolio.trade_log`, the lightweight decision-review log;
- `cash_ledger`, an intentionally empty schema reserved for a later additive bank, savings, and broker-cash ledger.

Phase 1 does not synchronize or project data into either existing portfolio table. It does not calculate cost basis, returns, current positions, FX valuation, dividends, corporate actions, Binance cash flows, or statement-derived holdings.

## Evidence model

The ledger uses immutable transactions plus typed amount components, not mandatory balanced double-entry accounting.

- `accounts` includes resolved broker accounts and explicit unresolved placeholders. Where a source document identifies no investment account — a fee invoice, or a mutual-fund confirmation that omits it — the row is mapped to a per-platform `UNRESOLVED_…` placeholder rather than guessed at, and each such row receives a validation finding.
- `instruments` contains canonical identities; `instrument_aliases` preserves broker-specific symbols/descriptions and exchange context.
- `transactions` records date, account, instrument, type, units, unit price/currency, broker reference, source, and a non-unique business fingerprint.
- `transaction_amount_components` records gross, fee, VAT, withholding tax, net, and cash flow independently with mandatory currency.
- Dime's THB equivalents are `broker_converted`/`informational`. Only `native` components are `economic`, preventing USD and THB representations from being counted together.
- `transaction_groups` binds switch legs, multi-fills, and future correction groups.
- Corrections are reversal-plus-replacement rows in a correction group. Both append rows link to the original through `correction_of_id` and declare `correction_role`; the original is never changed or deleted.

## Import and source provenance

A single consolidated transaction CSV, named by the operator on the command line, is the only Phase-1 import source. The spreadsheet it was derived from is validation evidence only. Neither file is committed, and neither is named by any path in this repository.

An import batch is identified by
`(workspace_id, series_key, source_kind, source_sha256)`. The importer:

1. defaults to inspect mode and opens no database connection;
2. validates the file's structure and invariants, and reports the digest it computed — it holds no expectation of what that digest should be;
3. requires `--apply` plus a code-level `withProductionWrite` scope for publication;
4. publishes the batch, every raw row, normalized evidence, findings, and document links in one PostgreSQL transaction;
5. rolls back the whole batch on any error;
6. returns the existing batch without inserting transactions for an exact hash rerun;
7. publishes a changed hash as a new batch linked through `changed_from_batch` and opens an append-only reconciliation case.

Each CSV row is preserved as JSONB in `raw_import_rows` with its row number and canonical-row SHA-256. PostgreSQL receives decimal strings directly as `NUMERIC`; the importer never converts monetary or unit values through JavaScript `number`.

The business fingerprint hashes broker, account key, date, side, instrument, exchange, currency, units, price, gross, net, cash flow, and broker reference. It is indexed but deliberately not unique: it creates duplicate candidates rather than destroying evidence. A broker reference alone is never identity. Seven archive broker/source/reference groups legitimately contain multiple rows.

## Documents and extraction versions

`logical_documents` represents one broker document. `document_file_variants` represents the archive's raw/encrypted and unlocked paths as separate observations. Phase 1 records paths only when present and neither copies nor extracts PDFs.

`document_extractions` is versioned and append-only for later email/PDF work. `transaction_document_links` joins economic evidence to its documents without making a filename the transaction identity.

## Reconciliation

Cases and their events are append-only. `reconciliation_case_current_state` derives the current state from the latest event.

```text
none --OPEN--> open
open --MATCH--> matched
open --FLAG_MISMATCH--> mismatch
open --REQUEST_REVIEW--> review
open --RESOLVE--> resolved
open --DISMISS--> dismissed
matched --REOPEN--> open
matched --RESOLVE--> resolved
mismatch/review --MATCH|RESOLVE|DISMISS--> matched|resolved|dismissed
resolved/dismissed --REOPEN--> open
```

The database rejects illegal transitions. Future reconciliation cases cover missing manual records, missing confirmations, field mismatches, duplicate documents, duplicate transactions, low-confidence extraction, and changed archives.

## Immutability and current-state views

UPDATE and DELETE triggers protect all Phase-1 evidence and reconciliation tables. Changes are new rows and events. `current_transactions` excludes batches superseded by a changed archive while retaining append-only correction economics. `economic_amount_components` includes current-batch components whose counting role is economic; it cannot create a cross-currency total and no such view exists.

## Archive identity is asserted by the operator

There is **no approved snapshot inside this package**. The importer computes and
reports facts about the file it is given — digest, row and document counts,
per-currency row counts and cash-flow totals, missing-value tallies, switch
groups, and derived short positions — and asserts nothing about what those
values ought to be.

Identity is supplied at the boundary instead, by the operator:

- `--csv <path>` names the file. There is no default and none is inferred.
- `--expect-sha256 <digest>` names the exact bytes. `--apply` refuses without it,
  and refuses again if it does not match what was just inspected.
- `--series <namespace:name>` names the dataset being revised.

This is deliberate, and it is a privacy property as much as a design one. An
internal expectation would have to carry the private record's digest and its
exact financial totals in committed source, and it would also decide on the
operator's behalf which bytes are legitimate — so a properly revised archive
could never be published at all. The inspect output is what the operator reads
before choosing the digest to vouch for.

**No transaction-level private content is committed.** No account identifier,
broker reference or confirmation number, source-document filename, derived
holdings list or position key, archive fingerprint, or exact financial total
from the real archive appears anywhere in this repository — not in source,
tests, fixtures, comments, or documentation. The portable test suites run
against a committed synthetic fixture whose every value is fabricated; the
suites that read the real archive assert only properties recomputed from it at
run time.

**One disclosed exception, and why it stands.** A comment in
`packages/db/migrations/012_investment_ledger_remediation.sql` states the number
of placeholder accounts in the archive. Migration files are checksum-pinned:
editing an applied migration makes every environment that has already run it
refuse to migrate, so the comment cannot be corrected in place — only superseded
by a later migration, under separate authorization. The disclosure is an
aggregate count of the same kind as the row and document totals recorded
elsewhere in this document, and it names no transaction, account, instrument or
amount. It is recorded here rather than left for a reader to discover.

## Deployment blockers

1. `packages/db/src/migrate.ts` executes migrations through raw `getPool()` without calling the production write-intent gate. The `migration` operation exists but is unenforced. Phase 1 does not repair that generic deployment path; applying migration 011 to production is blocked until it receives an independently reviewed, explicit migration authorization mechanism.
2. Migration 011 and the importer require independent verification in an isolated PostgreSQL test database.
3. Production roles/grants for the new schemas require review. Phase 1 changes no roles, credentials, launch configuration, runtime, or deployment state.
4. The unresolved account placeholders require future user resolution. Missing net values stay null by design.
5. Current-position, performance, and cash-ledger projections remain later phases and must not be inferred from this archive alone.

## Operational commands

`--csv <archive.csv>` is **mandatory in every mode and has no default.** There is
no fallback path and none is inferred from `HOME`, the working directory, the
repository location, or any environment variable — an omitted `--csv` is refused
before a byte is read and before any database is opened. The archive is one
operator's private financial record, so its location never appears in committed
source; name it explicitly, or export it once as `INVESTMENT_ARCHIVE_CSV` and
pass that.

Read-only inspection (opens no database):

```bash
pnpm --filter @common/investment-ledger inspect -- --csv "$INVESTMENT_ARCHIVE_CSV"
# or, naming the file directly:
pnpm --filter @common/investment-ledger inspect -- --csv <archive.csv>
```

### Test suites

Four commands, each run explicitly, ordered by what they require. The default is
portable: it passes with no environment set at all, opens no database, and reads
no private data. Requirements only ever increase down this list.

| Command | Needs a database | Needs the real archive |
|---|:--:|:--:|
| `test` (and `test:unit`) | no | no |
| `test:archive` | no | **yes** |
| `test:integration` | **yes** | no |
| `test:master-archive` | **yes** | **yes** |

```bash
# portable: CLI gates, parsing, CSV primitives, switch/position rules —
# synthetic fixture only. This is `vitest.config.ts`, the package default.
pnpm --filter @common/investment-ledger test

# the operator's real archive, file-level assertions only; requires
# INVESTMENT_ARCHIVE_CSV and fails loudly without it
INVESTMENT_ARCHIVE_CSV=<archive.csv> pnpm --filter @common/investment-ledger test:archive

# ordinary PostgreSQL integration. TWO credentials for the SAME allowlisted
# disposable test database, and NO archive: every case here publishes fabricated
# rows. Never production; leave DATABASE_URL unset.
BOOTSTRAP_DATABASE_URL=postgres://<owner>@<host>:<port>/<allowlisted_test_db> \
TEST_RUNTIME_DATABASE_URL=postgres://ai_capital_test_runtime:<password>@<host>:<port>/<allowlisted_test_db> \
  pnpm --filter @common/investment-ledger test:integration

# the full-scale publication proof — the only suite needing both
BOOTSTRAP_DATABASE_URL=postgres://<owner>@<host>:<port>/<allowlisted_test_db> \
TEST_RUNTIME_DATABASE_URL=postgres://ai_capital_test_runtime:<password>@<host>:<port>/<allowlisted_test_db> \
INVESTMENT_ARCHIVE_CSV=<archive.csv> \
  pnpm --filter @common/investment-ledger test:master-archive
```

The default suite is the package's `vitest.config.ts` rather than a redirect
target, because the workspace-wide isolation guard resolves every package's
`vitest.config.ts` and refuses a `test` script that names a different one. That
guard is unchanged by this work.

**Both credentials are required, and both must name the same database.**
`BOOTSTRAP_DATABASE_URL` is privileged and is used only for the existence check
and migration verification; `globalSetup` deletes it before any test runs, so
ordinary tests authenticate as the restricted `ai_capital_test_runtime` role.
The runtime credential alone is **not** sufficient, even against a database whose
migrations are already current: bootstrap always runs `runMigrations()`, whose
`CREATE SCHEMA IF NOT EXISTS db` needs `CREATE` on the database, which the
restricted role does not hold.

`test:integration` refuses to run unless the database name is one of the
harness's explicitly allowlisted disposable databases, and it never falls back to
`DATABASE_URL` — an unusable test database stops the suite rather than silently
redirecting it at production.

The archive and integration suites are **not skipped** when unconfigured — they
fail with an explicit message, because a silent pass is indistinguishable from
verified coverage.

`--apply` is intentionally not a deployment instruction. It is a code path for independent verification against an explicitly selected non-production database. Do not run it against production during Phase 1.

## Phase-1 remediation (2026-08-31)

Migration `012_investment_ledger_remediation.sql` is additive; `011` is applied
and is never edited.

**Account resolution is append-only.** The placeholder accounts were
permanently unresolvable: `accounts` rejects UPDATE and DELETE and nothing else
existed. `account_resolutions` is a separate append-only chain. "Active" is
derived — a row with no successor — so supersession needs no UPDATE. A wrong
resolution is corrected by an explicit superseding row or cancelled by a
`retract`; both prior rows survive as the audit trail, each carrying actor,
time, reason and evidence. Self-resolution, cycles and two simultaneously active
resolutions are rejected by trigger. `effective_accounts` and
`transaction_effective_accounts` project the current answer; no historical
transaction is ever rewritten.

**Correction integrity is enforced by the database.** `011` labelled
reversal/replacement rows without enforcing the semantics. A deferred constraint
trigger now validates each correction group at COMMIT: exactly one original, no
mixed correction targets, at least one reversal, and every reversal's economic
components the exact inverse of the original's. `current_transactions` has
defined correction behaviour — a reversed original and its reversals drop out;
replacements remain.

**Reconciliation transitions are serialized.** The transition trigger now takes
`FOR UPDATE` on the case row before reading state, so two writers cannot both
transition from the same prior state.

**Document identity is explicitly incomplete.** `existsSync` observes a PATH,
never content. Phase 1 opens, parses, copies and hashes NO archive PDF, so every
`document_file_variants` row is `verification_status = 'unverified'`, and the
schema refuses to record `verified` without a `content_sha256`. **Source-document
integrity is therefore NOT established in Phase 1** — content verification is
deferred to a separately authorized pass. `document_extractions` can record an
`unparseable` outcome, and `unparseable` is an available reconciliation case
type, so a document that cannot be read is sayable rather than silently absent.

**Instrument identity carries market evidence.** The canonical key is
`CURRENCY:EXCHANGE:SYMBOL` (`NO_EXCHANGE` when the broker publishes none).
It deliberately excludes the broker: one security held at two brokers is one
instrument, and keying on the broker would split it. It equally cannot be the
bare symbol, which would merge unrelated securities that share a ticker across
markets. Currency plus exchange separates the markets without splitting the
legitimate pairs. Per-broker aliases remain in `instrument_aliases`; where no
exchange is published the weaker identity basis is visible in the key itself.

**Imports are idempotent under concurrency.** The pre-check closes the common
case and the unique `(workspace_id, series_key, source_kind, source_sha256)`
index — `import_batches_series_source_unique`, established by 015 — closes the
race; losing that race is reported as an idempotent re-run rather than an
unexplained error. 013's three-column
`(workspace_id, source_kind, source_sha256)` key is dropped by 015 and is not
the current identity.

**`import_batches.status` no longer offers an unreachable value.** The table
rejects UPDATE, so `superseded` could never be set; supersession is expressed by
`changed_from_batch` on the successor row.

**Still deferred.** PDF content verification and extraction; cash/savings ledgers
(`cash_ledger` remains intentionally empty); resolving the 29 placeholders
themselves, which needs broker evidence rather than schema.

## Phase-1 remediation, round 2 (2026-08-31)

Migration `013_investment_ledger_series_and_corrections.sql` is additive; `011`
and `012` are applied and are never edited. Round 2 closes eight findings raised
by independent verification, two of which were live defects rather than
theoretical ones.

**Every import belongs to a SERIES, and supersession is scoped to it.** This was
a real defect, observed in `ai_capital_test`: the 621-row master archive
returned **0 of 621** rows from `current_transactions`, because publication chose
the batch to supersede as "the most recent `archive_csv` batch" regardless of
which file it came from, and a 6-row `fixture.csv` had become the master's
successor. `import_batches.series_key` now names the dataset
(`namespace:name`, e.g. `archive:master`). Exact-rerun identity is
`(workspace_id, series_key, source_kind, source_sha256)`; `changed_from_batch`
is a workspace-scoped composite foreign key and may link only
batches of the same series, enforced by trigger; a predecessor may be superseded
at most once, so a series is a linear chain with one head; and
`current_import_batches` holds the head of every series independently, which is
what `current_transactions` now reads. A partial broker export or an unrelated
CSV therefore cannot hide the master. Rows imported before series identity
existed are labelled `legacy:unclassified` and are not a publish target.

`--apply` now requires `--series` as well as `--expect-sha256`, with no default
in either the CLI or `publishArchive`. Which series a given file belongs to is
the operator's declaration, checked for shape but never inferred from the bytes.
Publication also takes a per-series advisory lock, so the head a publication
supersedes cannot move underneath it.

**A correction may only live in a correction group.** `011` required a
correction row to have *some* group but never constrained the group's TYPE,
while `012`'s validator returns early unless the group is `correction`. A
reversal parked in a `switch` or `multi_fill` group escaped every correction
check while `current_transactions` still dropped its target. A trigger now
rejects that at INSERT.

**The reversal-inverse check compares both directions.** `012` applied its
`WHERE o.transaction_id = original_id` after a `FULL OUTER JOIN`, discarding
every row the reversal alone contributed, so the join degenerated to a left join
from the original and a reversal carrying an *extra* economic component passed as
"the exact inverse". Each side is now reduced to its own economic component set
before the join, so a missing component, an extra component, a wrong currency, a
wrong representation kind and a component demoted to `informational` are all
rejected, with the offending component named in the error. An original with no
economic components is refused outright, so absence cannot satisfy the check.

**Document verification is an append-only observation chain.** `012` could say
`unverified` honestly but could never move on: the table rejects UPDATE,
`content_sha256` is settable only at INSERT, and the uniqueness constraint
blocked a second observation of the same path.
`document_verification_events` records `verified` / `failed` / `retracted` with
checksum, actor, time, reason and evidence, superseding explicitly and
serialized per variant;
`current_document_verification` is the authoritative projection, and
`document_file_variants.verification_status` is frozen at first observation.
**Phase 1 still opens, parses, copies and hashes NO archive PDF** — this is the
shape a separately authorised verification pass will write into.

**Tests are non-vacuous and repeatable.** The round-1 621-row test asserted only
that 621 transactions existed for the returned batch id, never that *this call*
inserted them; once the batch existed it took the exact-rerun branch and passed
in 52 ms without publishing anything. It now publishes into a series nothing has
ever used and asserts `insertedTransactions === 621` and `exactRerun === false`,
and a CONTROL test demonstrates that the old assertion shape is satisfied by a
call that published nothing. Integration tests run inside a transaction that is
always rolled back — `publishArchive` accepts a `nested` transaction mode that
brackets its work with a SAVEPOINT, and the deferred correction triggers are
fired with `SET CONSTRAINTS ALL IMMEDIATE` rather than by committing. Nothing is
weakened to achieve this: no trigger is disabled and the runtime role is granted
no DELETE or TRUNCATE. One full suite run now leaves 52 rows behind rather than
621+ transactions, all of them from the four tests that genuinely cannot roll
back (three cross-connection races and the out-of-process CLI run).

**Test dependency resolution no longer depends on the linker.**
`packages/db/testing/vitest-db-resolution.ts` computes the Vite alias for
`pg-connection-string` with Node's own resolver anchored to `@common/db`,
returning the package's ESM export-map entry. It replaces a hard-coded
`../db/node_modules/pg-connection-string/index.js` path that worked only under
pnpm's isolated layout and bypassed the export map. No production module
changed, so no application bundler sees a new construct.

**Remaining evidence added.** The changed-archive path is now driven end to end
through `bin/import-archive.ts` as a process against the test database, asserting
the linked successor batch, the open `changed_archive` reconciliation case and
the resulting projection. Isolation from the legacy book is proven with seeded
sentinel rows in `portfolio.positions` and `portfolio.trade_log`, whose contents
are byte-identical before and after a full 621-row publication.

## Phase-1 enforcement, round 3–4 (2026-08-31 / 2026-09-01)

Round 2's eight defects passed independent verification. Two database-enforcement
gaps survived it, and closing them took two attempts. Migration
`014_investment_ledger_enforcement.sql` is the consolidated result. **A
migration `015` was drafted and then withdrawn before ever being committed or
deployed; the corrected behaviour lives entirely in 014, and there is no repair
migration behind it.** 011, 012 and 013 are untouched.

**TRUNCATE erased append-only evidence.** 011 installs `reject_mutation` as a
`BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger, and **row-level triggers do
not fire for TRUNCATE**. Reproduced directly: a table carrying only that trigger
refuses UPDATE and accepts `TRUNCATE … CASCADE`, leaving zero rows. 014 installs
`reject_truncate` as a `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger on **all
seventeen** base tables, from the catalogue, and then asserts that no base table
was missed. Every table is guarded individually because `TRUNCATE … CASCADE`
follows references *to* the truncated table and never reaches a parent, so
truncating an unguarded child succeeds on its own.

**Classification.** Every base table in `investment_ledger` is append-only
evidence or append-only history. There is no deliberately mutable reference data:
`accounts` and `instruments` look like it but are append-only by design, which is
why 012 had to add `account_resolutions` as a separate supersession chain.

### The threat model, stated accurately

An earlier draft of this section claimed the ledger was protected by "two
independent layers" and that the runtime role needed only insert-only
privileges. **Both claims were wrong**, and the corrected statement is:

| statement | what actually refuses it |
|---|---|
| `UPDATE` | the `reject_mutation` trigger — for every principal |
| `DELETE` | the `reject_mutation` trigger; additionally the ACL, for non-owner principals |
| `TRUNCATE` | the `reject_truncate` trigger; additionally the ACL, for non-owner principals |

- **Triggers are the guarantee.** They fire for the table owner and for a
  superuser alike, so they hold in every topology.
- **A table owner is not constrained.** It can `DISABLE TRIGGER`, `DROP TRIGGER`,
  or grant any privilege back to itself.
- **A superuser cannot be constrained by ordinary ACLs at all**, and
  `has_table_privilege` returns true for one regardless of the stored ACL — so
  that function can never prove a restriction. 014 uses `aclexplode(relacl)` for
  its negative checks instead, and the withdrawn 015 aborted precisely because it
  did not.
- The configured production migration user is `thanapold`
  (`DATABASE_URL=postgres://thanapold@localhost:5432/ai_capital`), the chain runs
  without `SET ROLE`, and that principal is a superuser. **On the production
  topology the REVOKE is inert and the triggers are the only protection.**

**UPDATE is required and is never revoked.** PostgreSQL charges every row-locking
clause to the UPDATE privilege, and the ledger depends on two: foreign-key
inserts take `FOR KEY SHARE` on the parent row, and
`validate_account_resolution`, `validate_reconciliation_event` and
`validate_document_verification_event` each take `SELECT … FOR UPDATE`. The
withdrawn draft revoked UPDATE as "surplus authority" and failed 64 tests. A
non-owner runtime writer therefore needs **SELECT, INSERT and UPDATE** — and
still cannot mutate anything, because the triggers reject the statements.

**Production deployment remains blocked** pending a separately approved
non-superuser runtime-writer role and its grants. 014 creates no role and issues
no GRANT; it documents the intended shape and stops there.

**One root per real series.** The single-successor constraint —
`import_batches_single_successor`, `UNIQUE (workspace_id, changed_from_batch)`,
added by **015**, not 013 — forbids two successors for one predecessor, but
permits unlimited NULLs, so a series could have many roots and
`current_import_batches` many heads. Only the TypeScript
advisory lock prevented it. 014 adds a partial unique index on `series_key` where
`changed_from_batch IS NULL`, making the invariant a database fact. The
`legacy:unclassified` residue is exempted from the index and closed to new
inserts by a `NOT VALID` CHECK, so it is never rewritten and nothing can join it.

### Validation topology

The chain is validated on a database whose ledger tables are owned by a
**superuser**, matching production, because the previous round's test database
happened to be owned by a non-superuser and that difference is exactly what hid
the defect. The suite itself runs as a **non-owner** writer holding only
`SELECT, INSERT, UPDATE`, so every privilege claim it makes is about a principal
an ACL can actually constrain.
