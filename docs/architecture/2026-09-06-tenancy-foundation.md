# Multi-user ledger V3 foundation

Status: **source only.** No role has been created, no database has been touched,
no migration has been applied. Production activation is a separate, unapproved
gate.

## What this is

The investment ledger, rebuilt so that more than one person can use it with
completely private portfolios, with PostgreSQL enforcing the isolation even when
application code forgets a filter.

The V2 ledger was single-owner in a way that was worse than a leak. Five
globally-unique keys were semantically per-person, so two operators did not merely
see each other's rows — they **shared** them. `accounts.account_key` is the
clearest case: `Bualuang:UNRESOLVED_ACCOUNT` is identical for everyone, so every
unresolved placeholder in the system would have been one row belonging to
everybody at once.

## What is deliberately not here

OIDC, sessions, cookies, unified-platform middleware, friend invitation,
document HTTP delivery, filesystem reads, queue and scheduler changes, per-workspace
pipeline fan-out, `portfolio.positions` / `portfolio.trade_log` tenancy, export
relocation, and every form of production activation. Later migrations start at
**020** and never backfill below 018.

`portfolio.positions` keeps `ticker` as its primary key and carries no
`workspace_id` and no row-level security. That is checked by test, not promised.

## The model

```
identity.principals            supertype: kind ∈ {human, service}
  ├── identity.users                  human specialisation
  └── identity.service_principals     service specialisation
        └── identity.service_principal_roles   one PG login ↔ one principal

identity.workspaces
  ├── identity.workspace_memberships      HUMANS only
  └── identity.workspace_service_grants   SERVICES only, temporal
```

`kind` is a generated stored column on each specialisation and the foreign keys
target `principals(id, kind)`, so a service principal in `workspace_memberships`
is a foreign-key violation rather than a code review finding.

Capabilities: `archive-import`, `manual-entry`, `reconciliation`,
`document-verification`, `ledger-read`.

## The rule everything rests on

> A caller-set GUC **selects** a workspace. `session_user` **authorizes** it.

`app.workspace_id` says which workspace the caller would like to act in.
`identity.authorize_service_workspace_any` decides whether it may, by resolving
the caller from `session_user` — the role that authenticated at connect time —
and checking the live grant table. A hand-written `SET LOCAL app.workspace_id =
'<someone else>'` followed by `INSERT` raises `42501`.

`session_user` and not `current_user`: inside a `SECURITY DEFINER` function
PostgreSQL sets `current_user` to the **function owner**, so a `current_user`
check would compare the authority role against itself and identify nobody.
`session_user` survives both definer entry and `SET ROLE`; the only statement
that rewrites it needs superuser, which no runtime role has.

## Isolation, in four independent layers

1. **`workspace_id`** — `NOT NULL`, no `DEFAULT`, on all 17 tenant tables.
2. **Composite foreign keys** on `(workspace_id, id)` — enforced by the planner,
   so they still hold if a policy is wrong.
3. **`ENABLE` + `FORCE ROW LEVEL SECURITY`** with policies that route the GUC
   through an authorization function.
4. **Table-specific grants**, never `ON ALL TABLES`. `ai_capital_agent` receives
   no `investment_ledger` access at all — no grant, no policy, no view — see the
   round-7 note below.

`instruments` is the one global table: a canonical security is the same security
for everyone. Its per-tenant naming lives in `instrument_aliases`, which is
workspace-owned. No runtime role may `INSERT` into `instruments`;
`resolve_or_create_instrument` is the only path, and it reproduces V2's
canonical keys exactly — including `FEE:BINANCE_TH`, which a
currency/exchange/symbol resolver could not produce.

## Append-only, and what UPDATE is for

All 17 base tables carry V2's `reject_mutation` trigger, so nothing is ever
updated or deleted. The `UPDATE` **privilege** is nevertheless retained, because
PostgreSQL charges `SELECT … FOR UPDATE` row locking against it and the
concurrency tests depend on locking. Every `UPDATE` **policy** therefore carries
`WITH CHECK (false)`: a bare lock modifies no row, so `WITH CHECK` is never
evaluated for it, while a real mutation can never satisfy it.

Two independent denials — but **not in that order**. PostgreSQL evaluates the
`UPDATE` policy's `USING` clause, fires BEFORE ROW triggers, and only then
applies `WITH CHECK` to the proposed row. `reject_economic_mutation` is a BEFORE
UPDATE trigger, so it raises first and what a caller actually observes is its
P0001, never the policy's 42501. `WITH CHECK (false)` is the backstop that would
refuse the write if the trigger were ever dropped, not the front line.

## Current state, stated plainly

Four facts that earlier drafts of this document got wrong, corrected here so a
reader does not have to reconstruct them from migration diffs:

- **Tenant relationship backstops are workspace-scoped composite foreign keys.**
  Every reference from one tenant table to another is
  `FOREIGN KEY (workspace_id, <column>) REFERENCES <parent> (workspace_id, id)`,
  including the three self-links that shipped id-only —
  `import_batches.changed_from_batch`, `account_resolutions.supersedes_id` and
  `document_verification_events.supersedes_id`. RLS cannot substitute for this:
  a child row whose own tenancy is correct satisfies the policy, so only the key
  refuses a parent in another workspace. `instruments` is the sole exception,
  being global reference data with no `workspace_id` at all.
- **The append-only trigger is reached before the RLS denial.** See above: a
  BEFORE UPDATE trigger precedes `WITH CHECK`, so mutation is observed as P0001.
- **Import identity is workspace- and series-scoped:**
  `(workspace_id, series_key, source_kind, source_sha256)`. Neither
  `(source_kind, source_sha256)` nor `(series_key, source_kind, source_sha256)`
  is the current key; both omit the tenant.
- **Migration-ledger INSERT exists only while the migration window is open.**
  `ops/bootstrap/010_database_bootstrap.sql` grants
  `INSERT ON db.schema_migrations` as part of opening a window and
  `ops/bootstrap/090_post_migration_lockdown.sql` revokes it. `USAGE ON SCHEMA
  db` and `SELECT` are permanent, so a closed ledger stays readable. Reopening
  is one deliberate act — re-running 010 — and needs no separate repair.

## Human authority is deferred

`ai_capital_app` holds **no tenant privilege at all** — not INSERT, not UPDATE,
not SELECT. Stricter than required, for a reason: a SELECT policy for a person
would have to key on a bare GUC, which is exactly the unauthenticated pattern
this design rejects, and there is no session mechanism to derive one from until
the OIDC gate. `manual-entry.ts` exists as a domain API that accepts an
already-authorized transaction and never constructs one.

## Grant lifecycle

A grant has a scheduled start, may expire naturally, and can be terminated two
different ways that are never conflated:

- **cancelled** — only *before* `valid_from`. It never took effect, so its
  `effective_range` is **empty**. No timestamp is invented to satisfy a
  constraint.
- **revoked** — only *at or after* `valid_from`. The range truncates to the
  interval the grant genuinely had.

`EXCLUDE USING gist` covers **all** rows, so a re-grant cannot overlap a
*historical* interval. Empty ranges overlap nothing, so a cancelled grant never
blocks its replacement. Both timestamps, the reason and the terminating
principal are immutable once set, enforced by trigger.

## Documents

Physical deduplication (`document_blobs`, unique on `(workspace_id,
content_sha256)`) is separate from evidentiary observation. Duplicate variants
are **preserved** — a broker legitimately re-sending a confirmation is two facts,
and a unique constraint on the observations would destroy audit evidence.
Duplicates surface as a `duplicate_document` reconciliation case.

There is no global index on `content_sha256`, so no cross-workspace existence
oracle. Nothing in this foundation reads, writes or serves a file: only the
relative `object_key` and its validation.

## Privacy

No transaction-level private content is committed: no account identifier, broker
reference, source-document filename, holdings list or position key, no archive
fingerprint, and no exact financial total from the real archive — not in source,
tests, fixtures, comments or documentation.

One disclosed exception: a comment in
`packages/db/migrations/014_investment_ledger_remediation.sql` states the number
of placeholder accounts in the archive. Applied migrations are checksum-pinned,
so it can only be superseded, never edited in place. It is an aggregate count of
the same kind as the row and document totals recorded elsewhere, and it names no
transaction, account, instrument or amount.

## Source remediation, round 1 (2026-09-06)

Seven independently verified defects in the first source cut, and what each one
actually was. They are recorded because six of the seven were disagreements
between a comment and the executable text beside it, which is the class of
defect this design is most exposed to: almost every guarantee here is stated in
SQL that nobody executes until a migration runs.

**A — a duplicate index.** `013` created
`idx_reconciliation_case_events_case` twice, four lines apart, differing only in
its column list. The second `CREATE INDEX` raises 42P07 on a fresh database, so
nothing from 013 onward would have applied. The workspace-leading form is kept;
it is also the one the planner wants, since every tenant read filters on
`workspace_id` first. `tests/unit/migration-duplicate-objects.test.ts` now scans
every migration for repeated schema-scoped names, and for policy and trigger
names repeated on one table.

**B — `RESET ROLE` does not mean "back to the owner".** The runner enters each
file as `ai_capital_owner`; `012` and `017` then switch to
`ai_capital_identity_authority` to create SECURITY DEFINER functions that must
be *owned* by it, and both used `RESET ROLE` afterwards. SET ROLE is not a
stack: `RESET ROLE` returns to `session_user`, which during a migration is
`ai_capital_migrator` — whose memberships are granted `WITH INHERIT FALSE`
precisely so it holds nothing ambiently. Every `REVOKE ALL ON FUNCTION … FROM
PUBLIC` and `GRANT EXECUTE` after those resets would have raised 42501. Both
files now name every role transition explicitly, use no `RESET ROLE` at all, and
are walked as a state machine by `tests/unit/migration-role-state.test.ts`.

**C — the changed-archive capability contradiction.** The CLI authorizes
`archive-import`; `publishArchive` opens a `changed_archive` case and inserts
its `OPEN` event, which required `reconciliation`. A changed archive could
therefore never be published. Both easy fixes were wrong — granting the importer
`reconciliation` lets it resolve the case it just opened, and having the CLI
request both capabilities is the same thing spelled differently. Instead
`investment_ledger.assert_reconciliation_event_scope()` admits exactly one event
from a caller holding only `archive-import`: `OPEN`, on a `changed_archive`
case, in its own workspace, where the case has no events yet. It is SECURITY
INVOKER, so its lookups run inside the caller's own RLS and a case in another
tenant is not visible rather than merely forbidden. The "first event" test is a
read and could lose a race, so `uq_reconciliation_case_events_open` — at most
one `OPEN` per case, which is semantically right anyway — is the guarantee.
Every other transition still requires `reconciliation`: an importer can raise
the flag and can never lower it.

**D — incomplete attribution.** `actor_principal_id` was carried by the tables
that felt important and omitted from `accounts`, `instrument_aliases`,
`raw_import_rows`, `document_file_variants`, `document_extractions` and
`transaction_groups` — which are exactly where an unattributable change hides,
because renaming an account or rewriting the raw payload a transaction was
derived from changes what the ledger *means* while every transaction row stays
byte-identical. All seventeen tenant tables now carry the column NOT NULL, a
foreign key to `identity.principals`, and an `actor_is_authorized` trigger;
`017` asserts all three from the catalogue at migration time.

**E — a predicate that did not match its prose.** `016` said the reserved
`legacy:unclassified` series was exempt from the one-root index; the predicate
said only `changed_from_batch IS NULL`. On a database carrying real pre-series
residue the second legacy batch would have collided — the migration failing on
precisely the data it was written to accommodate, and only on the databases that
had it. The exemption is now in the predicate. The `NOT VALID` check that closes
the key to new inserts is unchanged.

**F — a cluster-wide advisory lock.** Publication keyed on
`hashtext('investment-ledger-series:' + series)`. Advisory locks are
cluster-wide, so two unrelated workspaces importing a series with the same name
serialized against each other — not a correctness bug, but a cross-tenant
availability coupling and an observable side channel. The two-key form takes the
workspace first.

**G — the integration suites.** Twelve files under
`packages/investment-ledger/tests/integration/tenancy/`, with their own config
and `test:tenancy` script because they need seven separate role logins rather
than one database URL. Separate logins and not `SET ROLE`: the authorization
functions resolve the caller from `session_user`, which `SET ROLE` does not
change, so a suite built on role switching would exercise a different mechanism
from the one production uses. They are **authored and not executed** — running
them is the next gate.

Two notes on their non-vacuity controls, both of which earlier drafts got wrong.
The append-only UPDATE test installs a temporary **permissive** owner-controlled
policy so the statement reaches the trigger; an earlier draft *dropped* the
restrictive policy instead, which leaves RLS default-denying and proves nothing.
And PUBLIC EXECUTE on trigger functions is read from `pg_proc.proacl`, not
probed by calling one: a direct call fails with 0A000 whatever the ACL says.

## Source remediation, round 2 (2026-09-06)

Round 1 corrected the migrations. Round 2 corrected the tests — which had, in
several places, been checking something adjacent to the thing they claimed to
check.

**1 — the resolver could be defined and never called.** `017` granted the
identity authority `CREATE` on `investment_ledger` and never `USAGE`. That is
exactly enough to define `resolve_or_create_instrument` and not enough to run
it: a SECURITY DEFINER function executes as its owner, and resolving
`investment_ledger.instruments` inside the body needs `USAGE` for that owner at
every call. The failure is invisible during migration — `CREATE FUNCTION` does
not resolve the body — and would have arrived at the first import, on a database
whose migration window lockdown had already closed. `ops/bootstrap/090` already
*said* "USAGE is retained"; until now there was no USAGE to retain. Both grants
are now issued by the owner before the role switch, the migration asserts the
privilege at apply time, and the whole lifecycle (017 grants both, 090 revokes
CREATE, 090 revokes USAGE from nobody) is checked statically.

**2, 3 — the fixture could not have run.** It inserted
`identity.principals DEFAULT VALUES` into a table with two `NOT NULL` columns
and no defaults; generated `service_key` values with no namespace, failing their
`CHECK`; bound several principals to `ai_capital_importer`, whose `db_role` is
`UNIQUE`; and omitted the `NOT NULL` `granted_by`. The corrected rule is one
sentence: **exactly one service principal per login role, resolved by that role,
created once** — plus one unbound grantor principal to be named by `granted_by`.
Capability differences are expressed by workspaces, which is also how production
works. No production constraint was relaxed.

**4 — the capability matrix tested the authorization function, not the tables.**
It called `authorize_service_workspace` and asserted the result, touching no
table — so a table with no policy at all would have passed it. It now executes a
real, valid INSERT into all seventeen tenant tables in five workspaces (85
cells), one workspace per capability. The parent-row graph is seeded per
workspace during a setup window that is then closed by revoking every capability
the workspace is not meant to keep; the parents stay referenceable because
PostgreSQL evaluates referential integrity in system triggers that bypass RLS,
which is exactly the difference between "cannot see" and "does not exist". Every
probe rolls back, successes included. Negative cells assert the SQLSTATE **and**
the message: both refusal paths say "holds none of", and nothing else in the
schema does, so that phrase is the proof the row was well-formed and was turned
away for the reason claimed.

**5 — two phases, two suites.** "The migrator holds CREATE" and "the migrator
does not hold CREATE" are both required and both true, at different moments.
`TENANCY_PHASE` selects which half runs and has no default. The pre-lockdown
file asserts `pg_auth_members.inherit_option = false` and `set_option = true` —
the exact columns; an earlier draft read `admin_option`, which says nothing
about inheritance and would have passed against a plainly-inherited grant. Its
idempotent-rerun test closes the pool, points `DATABASE_URL` and
`TEST_DATABASE_URL` at the migrator's disposable URL, and only then imports
`migrate.ts`, because `getPool()` memoises on first call and the shared setup
clears `DATABASE_URL`.

**6 — state machine separated from capability.** The first draft walked MATCH,
FLAG_MISMATCH, RESOLVE, REOPEN and DISMISS consecutively against one evolving
case: after RESOLVE the case is closed, so later probes failed on the *state*
rule while the test claimed to prove something about *capabilities*. Every
capability probe now starts from the same committed state and is rolled back;
the state-machine paths are a separate block that prepares an independent case
per path. They are told apart by SQLSTATE: capability refusals are 42501,
`validate_reconciliation_event` is a bare `RAISE EXCEPTION` and so P0001.

**7 — the disabled-actor test could not fail.** It wrapped the probe in
`.catch(() => INSUFFICIENT_PRIVILEGE)` on a client with no open transaction, so
the helper's own `SAVEPOINT` raised 25P01 and the catch converted any failure at
all — a dropped connection, a typo, a missing fixture row — into the asserted
value. It is now `probeDetached`, the exact SQLSTATE and the trigger's own
message are asserted, there is no catch, and the identical INSERT is run again
with the principal enabled to prove the statement was well-formed.

**8 — the fixture has its own tests, and they need no database.** They parse the
required columns out of `011` and check every fixture INSERT names them, check
every service key against the real `CHECK` regex, check `granted_by` is supplied
everywhere, check one `db_role` maps to one principal and that no suite file
seeds its own, and exercise the transaction-state guard with a stub client. That
guard is the reason the round-1 disabled-actor bug cannot recur: `probe()` on a
client with no open transaction now **throws**, emitting no SQL, rather than
returning a plausible-looking `25P01`.

**Also found while enumerating every table for item 4:** `document_blobs` is
created in `017`, after `016` asserts that every ledger table carries both
`reject_mutation` and `reject_truncate`, and it installed only the first — so
the newest table was the one place TRUNCATE was ungoverned. It now installs
both, `017` re-asserts the pair over all eighteen tables, and the append-only
suite checks both rather than one.

## Source remediation, round 3 (2026-09-06)

Four test defects, all in the tenancy suite, all of the same family: an
assertion that could not fail, or could not pass, for a reason unrelated to the
thing it named.

**1 — the resolver USAGE proof tested the authorizer instead.** The
post-lockdown check called `resolve_or_create_instrument` with the nil workspace
and asserted 42501 with a message that was not "permission denied for schema".
But the function's first statement is `authorize_service_workspace_any`, which
raises 42501 for an ungranted workspace — so it aborted before ever touching
`investment_ledger.instruments`. Deleting the USAGE grant entirely would not
have changed one character of the result. The test now grants `archive-import`
in a fresh workspace, authorizes normally, and resolves a key that has never
existed, so the function must reach the schema (USAGE, for the function owner),
read the table and insert into it. It verifies the created row and the
idempotent second call, and rolls back — the resolver still executed, which is
what the privileges gate, and `instruments` is global and append-only, so residue
there could never be removed. The ungranted-workspace case survives as a
separately labelled *authorization* test.

**2 — an assertion that could not pass on a fresh database.**
`app-role-no-access.test.ts` ended by asserting `ai_capital_app` still holds
SELECT on `portfolio.positions`. No SQL in this repository grants that:
migrations 001-010 predate the role and `ops/bootstrap/010` gives it CONNECT and
nothing else. The assertion described a production cluster's hand-made ACLs. It
is replaced by what was actually meant and can actually be checked — that the
tenancy work did not touch the portfolio access model: no statement naming
`portfolio` in 011-017 or in any `ops/` file, no tenancy role holding any
privilege there, no policy, RLS, trigger or tenancy column added. **Whether
`ai_capital_app` should hold portfolio read access on a database built this way
is a separate design and authorization decision, deliberately not made inside a
tenancy remediation.**

**3 — `has_schema_privilege('public', ...)`.** PUBLIC is a pseudo-role with no
`pg_roles` entry, so that call raises `role "public" does not exist` rather than
answering. The ACL is now read directly — `aclexplode(nspacl)` with
`grantee = 0` — and the schema row's existence is asserted so a typo cannot
produce a vacuous pass. `nspacl IS NOT NULL` is asserted separately and is
load-bearing: a NULL ACL means default privileges, under which PUBLIC *does*
hold USAGE on `public`, so "no grantee-0 rows" is only the right answer once
`010_database_bootstrap.sql`'s revoke has materialised the ACL.

**4 — ownership was checked in one catalogue of three.** The query read
`pg_class` only, so it would have reported a clean result on a database where a
LOGIN role owned the `identity` *schema* — the worst of the three, since a
schema's owner may CREATE in it and DROP it outright. Ownership is now asserted
over `pg_namespace`, `pg_proc` and `pg_class`, in both directions: no LOGIN role
owns anything, and the role that does own each thing is the intended one. That
exposed a further error of its own — the old test asserted every function in
`identity` was authority-owned and SECURITY DEFINER, but 011 creates
`grant_termination_is_one_way` and `reject_identity_mutation` before the role
switch, and neither is a definer function. The authority-owned set is now named
explicitly (the seven definer functions from 012 plus the resolver from 017) and
asserted to be exactly the set of SECURITY DEFINER functions, in both
directions; everything else must be owner-owned and an invoker.

## Migration-chain remediation, round 4 (2026-09-06)

The disposable-cluster gate failed at setup: `001–017` could not be applied to a
fresh database at all. Three rounds of static verification had passed over a
chain that had never been run. Seven blockers, in two families.

### Three in `ops/bootstrap/` — privileges needed at a moment nobody had executed

**B1 — `permission denied for schema db`, on the runner's first statement.**
`migrate.ts` opens with `CREATE SCHEMA IF NOT EXISTS db; CREATE TABLE IF NOT
EXISTS db.schema_migrations`. The bootstrap granted `CREATE` on the *database*
and reasoned that "both statements are no-ops once the objects below exist". The
first is. The second checks `CREATE` **on the schema**, before the
`IF NOT EXISTS` short-circuit — a no-op is still a statement, and PostgreSQL
resolves its creation namespace and checks `ACL_CREATE` there first. 010 now
grants schema `CREATE` too, and **090 revokes it**; without that second revoke
the window is not actually closed, because `CREATE TABLE db.anything` still
succeeds after lockdown. The migrator's `USAGE` and `SELECT, INSERT` on the
ledger survive on purpose, so reopening the window stays one deliberate act.

**B2 — `no schema has been selected to create in`.** Migration 006 is published
and immutable and says `CREATE EXTENSION IF NOT EXISTS vector` unqualified. That
resolves into `public`, where `ai_capital_owner` has no `CREATE`; and extension
creation needs superuser, which the owner deliberately is not. The bootstrap
already pre-creates `btree_gist` for exactly this reason — it simply did not
know about the second extension. It does now, before the `public` revoke.

**B3 — `type "vector" does not exist`.** `REVOKE ALL ON SCHEMA public FROM
PUBLIC` removes the ability to *see* anything in `public`, including the
extension objects the bootstrap itself installs there. The fix is one grant:
`USAGE` on `public` to `ai_capital_owner` and no one else. The gate used a broad
diagnostic grant to all seven roles; that was a probe, not a design. Source
tracing over 011–017 finds exactly one reference from the tenancy schemas into
`public` — 011's `EXCLUDE USING gist` opclass lookup, performed at DDL time by
the owner — and no runtime role holds any grant on `capital.*` or `public`.
`CREATE` on `public` is still granted to nobody.

*Superseded in part on 2026-09-13:* `ai_capital_pipeline` does hold `USAGE` on
`public`, granted by 010. See "Runtime-role rehearsal remediation" below.

### Four in the migrations — each invisible to a static check that looked one way

**V3-1 — a constraint name that no longer existed.** 015 dropped
`import_batches_source_kind_source_sha256_key`. 013 declares
`UNIQUE (workspace_id, source_kind, source_sha256)`, and PostgreSQL names an
unnamed table constraint `<table>_<column>…_key` — so adding `workspace_id`
during the tenancy rewrite *renamed* it. Nothing tied the `DROP` to the
declaration that generates its name; the regression test now **derives** the
expected name from 013's own column list.

**V3-2 — a comment left behind by a relocation.** When the nine views moved into
017, `COMMENT ON VIEW … current_document_verification` stayed in 015. Unlike a
PL/pgSQL body, which resolves relation names at execution time, `COMMENT ON`
resolves immediately. `migration-order.test.ts` counted `CREATE VIEW` statements
and could never have seen it; it now examines every `COMMENT`/`ALTER`/`GRANT`/
`DROP` that *references* a ledger view before 017. The `COMMENT ON COLUMN`
stayed where it was: it names the view in its text but resolves a table created
in 013.

**V3-3 — "granted to nobody" was right about the wrong thing.** 012 revoked
`assert_actor_authorized` from `PUBLIC` and granted it to no one, on the
reasoning that a trigger function has no callers. True of *firing*, which checks
no privilege at all; false of `CREATE TRIGGER`, which checks `EXECUTE` against
the role issuing it. All seventeen attribution triggers failed. 012 now grants
`EXECUTE` to `ai_capital_owner` alone — issued while `current_user` is still the
authority, because only a function's owner may grant on it — and ownership and
`SECURITY DEFINER` are untouched.

**V3-4 — a blanket revoke that ran too late.** 017's `REVOKE ALL ON ALL
FUNCTIONS IN SCHEMA investment_ledger FROM PUBLIC` sat in section 6, by which
time the schema held `resolve_or_create_instrument` — owned by the authority and
already carrying an *explicit* ACL from its own revoke and grant. A function
still at default (NULL) ACL only produces `WARNING: no privileges could be
revoked`; one with an explicit ACL is a hard failure. The statement moved to
section 4, as the owner, before the authority creates the resolver. Every
owner-owned function exists by then, and the resolver still issues its own
owner-issued revoke and importer grant. No final ACL changed — only the order.
(One did change later, deliberately: see V3-5.)

**V3-5 — "firing checks no privilege" is true, and not the whole rule.** V3-3
established that trigger *firing* checks no `EXECUTE`, only `CREATE TRIGGER`
does. Both halves are correct, and together they read as "trigger functions need
no runtime grant" — which is false whenever a trigger body calls another
function ordinarily. `enforce_correction_integrity()` is a deferred constraint
trigger whose body performs `investment_ledger.validate_correction_group(gid)`.
Firing it checks nothing; that nested call checks `EXECUTE` against the role
that caused the trigger to fire. After 017's blanket revoke the validator's ACL
was `ai_capital_owner=X/ai_capital_owner`, so every correction group written by
`ai_capital_importer` reached the trigger and was then refused with

```
ERROR: permission denied for function validate_correction_group   (42501)
```

before the integrity rule could run. It failed closed — no bad data — but
corrections were unusable and the guarantee was never delivered. The 2026-09-07
fresh PostgreSQL gate reproduced it exactly and returned DEFECTIVE.

017 now issues one grant, `EXECUTE ON FUNCTION validate_correction_group(UUID)
TO ai_capital_importer`, after the blanket revoke and while the effective role
is `ai_capital_owner` (only a function's owner may grant on it). Both functions
stay **SECURITY INVOKER**, which is the point: a definer validator would read
`transactions` as the owner, escape the caller's RLS, and could validate a
correction group against rows in a workspace the caller cannot see. The
validator's reads stay bound to the importer's active `app.workspace_id` and the
same policies as every other read it makes. No other role receives it — only a
role that may INSERT a correction transaction can cause the trigger to fire, and
the importer is the only such login — and `enforce_correction_integrity()` is
granted to nobody, since granting it would let a runtime role call the trigger
body outside any trigger context.

### What this round does not establish

The chain has still never been applied end to end. Every correction above is
argued from the gate's captured errors and enforced by static tests; only a
re-run of the isolated PostgreSQL gate can show that `001–017` now apply, that
lockdown behaves, and that the tenancy suite passes.

### Round 5 (2026-09-06) — two corrections to the round-4 bootstrap

**Extension placement was left to the administrator's `search_path`.** Round 4
pre-created `btree_gist` and `vector` but did not say where. Both are
*relocatable*, so an unqualified `CREATE EXTENSION` installs into the first
schema of the creating session's effective `search_path` — and `--no-psqlrc`
does not settle that, because a `search_path` set with `ALTER DATABASE ... SET`
or `ALTER ROLE ... SET` is applied by the server at connect time, before psql
runs anything at all. Three separate things assume `public`: the single USAGE
grant, the lockdown that preserves it, and the post-lockdown assertion that both
extensions live there. Both statements now say `WITH SCHEMA public`, so
placement is a property of the file rather than of whoever runs it. The limit is
stated in the file: `IF NOT EXISTS` pins placement on a *fresh* database, which
is this script's contract; it does not relocate an extension a previous run put
elsewhere, and the runtime assertion is what catches that.

**A comment cited evidence that did not exist.** The explanation of why the
owner needs `USAGE` on `public` cited `chunk_embedding vector(1536)`. Migration
006 declares `embedding vector(384)` — neither the column name nor the dimension
was real, and the comment also missed a third name resolution in that schema
(006's `USING hnsw (embedding vector_cosine_ops)`). A comment is the only place
a reader learns *why* an exception to "nothing may use public" exists, so
inventing its evidence is worse than omitting it. The bootstrap contract test
now extracts every `` 006 `…` `` citation from the script and requires it to
appear in 006, whitespace-normalised.

### Round 6 (2026-09-06) — the migration session's search path

Round 5 made extension *placement* deterministic and fail-closed. It did not
make extension *visibility* deterministic, and those are different properties.

Two published, immutable migrations resolve names that live in `public` without
qualifying them — 006's `embedding vector(384)` and
`USING hnsw (embedding vector_cosine_ops)`, and 011's `EXCLUDE USING gist
(... WITH =)`, whose operators come from btree_gist. Whether they resolve is
decided by the migrator session's `search_path`, and the runner set none. That
path can be supplied by `ALTER DATABASE ... SET`, `ALTER ROLE ... SET`, a
connection parameter or `PGOPTIONS`, and the server applies it before any client
statement runs — so a deployment whose role or database carried
`search_path = app` would fail on migration 006 with `type "vector" does not
exist`: a privilege-shaped error with no privilege cause, on a chain
byte-identical to one that works elsewhere.

The bootstrap cannot close this. It governs the administrator's session; the
migrations run in the migrator's. So `runMigrations()` now pins its own, per
migration, immediately after `SET LOCAL ROLE` and immediately before the
migration body:

```
SET LOCAL ROLE ai_capital_owner
SET LOCAL search_path = pg_catalog, public
<migration SQL>
RESET ROLE
INSERT INTO db.schema_migrations(...)
```

Four properties, each deliberate. **`SET LOCAL`** — it reverts at COMMIT *and*
ROLLBACK, so nothing leaks into the ledger INSERT or onto the next borrower of
the pooled connection. **After the role**, because `"$user"` is evaluated
against whichever role is current. **No `"$user"`** — under `SET LOCAL ROLE` it
resolves to a schema named `ai_capital_owner`, which does not exist, and which
would silently outrank `public` if anyone ever created it. **No application
schema** — every migration writes fully-qualified object names (asserted), so
including one would only let a future unqualified name resolve silently instead
of failing loudly.

It is gated on `MIGRATION_OWNER_ROLE`, so a database migrated without that
variable behaves exactly as before. And a search path grants nothing: it decides
which schemas are searched for an unqualified name, never who may use what.
`public` remains revoked from `PUBLIC`, with `USAGE` held by the owner and —
since the 2026-09-13 runtime-role rehearsal, see below — by `ai_capital_pipeline`.

`packages/db/tests/migration-session.test.ts` proves the statement sequence
behaviourally, by running the real `runMigrations()` against a recording client
with `packages/db/src/pool.ts` mocked — no database, and no production code bent
into a testable shape. What it cannot prove is behaviour under a genuinely
hostile server-side `search_path`; that belongs to the next database gate.

### Round 7 (2026-09-06) — the RLS predicate, the operation split, and the agent

The disposable-cluster gate refused every tenant write. Three defects, and the
first made the other two invisible.

**The policy compared a workspace to a principal.** Every one of the 51 importer
policies read `workspace_id = identity.authorize_service_workspace_any(guc,
caps)` — but that function returns the **principal** id. Type-correct
(`uuid = uuid`), plausible on the page, and always false for a legitimate row.
The function's principal-return contract is consumed by
`packages/db/src/workspace-context.ts`, so the function is unchanged; the policy
now proves the two things separately — the row belongs to the *selected*
workspace, and that workspace is *authorized* for this `session_user` — with
`... IS NOT NULL` as the authorization conjunct. **The claim made here that "a
forged GUC still raises 42501" was wrong, and the next gate disproved it on a
live cluster — see Round 8 below.** Writing the two facts as a top-level `AND`
let PostgreSQL skip the throwing authorizer whenever the workspace comparison
was already false.

**Capabilities are per operation, not per table.** 017 derived one set per table
and used it for SELECT, INSERT and the locking UPDATE alike. Three `BEFORE
INSERT` trigger functions take `SELECT … FOR UPDATE` on a table *other* than the
one being written, under the capability of the write they validate:
`validate_account_resolution()` locks `accounts` under `reconciliation`,
`validate_document_verification_event()` locks `document_file_variants` under
`document-verification`, and `validate_reconciliation_event()` locks
`reconciliation_cases` under `archive-import|reconciliation`. A row lock is
charged to the UPDATE privilege *and* evaluates the UPDATE policy's `USING`
clause as well as the SELECT policy's — two policies, not one — so both
workflows failed at the trigger. Widening the shared set would have been worse
than the bug: it would have handed `reconciliation` the right to create accounts
and `document-verification` the right to create file variants. Reading and
creating are different authorities, so `select_caps`, `insert_caps` and
`lock_caps` are now derived independently. Only `accounts` and
`document_file_variants` diverge; a third divergence has to be written down.

**`ai_capital_agent` receives no ledger access.** An earlier design gave it
SELECT on ten base tables. `transactions` had to go — it carries superseded,
reversed and corrected rows with nothing distinguishing them from current
holdings, and the only correct projection reads raw import evidence — and with
transactions gone the rest carries no standalone analytical value while
`import_batches.source_name` and `transaction_groups.group_key` leak
archive-filename data to the one role whose boundary forbids source-document
paths. The agent is now treated as `ai_capital_app` is: nothing until a gate
designs it. A capability granted to its principal cannot make the login
writable, because it holds no grant and no policy — that is asserted, not
assumed. Analytical access is **deferred** pending a capability-coherent
current-state projection; `ledger-read` consequently has no consumer.

**Four view grants, five withheld.** Every `security_invoker` view needs a
working privilege path through its whole dependency closure, so a grant is
issued only where a traced consumer exists: `current_import_batches`
(`publish.ts`), and `reconciliation_case_current_state`,
`active_account_resolutions`, `active_document_verification_events` — each read
by a SECURITY INVOKER trigger function, which runs as the *writer*. The other
five are withheld with the reason recorded in the migration: no consumer, a
raw-evidence dependency, capability incoherence, or sensitive path exposure.

Also corrected: every reconciliation mutation in the tenancy tests now runs
through `ai_capital_importer` rather than `connectAs('agent')` — those INSERTs
could never have succeeded against a SELECT-only login — and both transaction
helpers roll back on any post-`BEGIN` failure, so a failed authorization no
longer strands the fixture and cascades into the next test.

**Still deferred, and named rather than quietly fixed:** `openReconciliationCase`
inserts a case *and* its first event, so `manual-entry` alone cannot use it
unless the case is `changed_archive`.

### Round 8 (2026-09-06) — evaluation order, and who counts as a runtime role

The second disposable-cluster gate got the whole chain through bootstrap,
migrations 001–017, 382 static tests, lockdown and the pre-lockdown tenancy
phase. The post-lockdown phase failed 27 of 434 (Gate #2 had failed 35 of 168),
and the failures reduced to two defects.

**An `AND` is not an ordering.** Round 7 wrote the predicate as

```sql
workspace_id = <guc> AND authorize_service_workspace_any(<guc>, caps) IS NOT NULL
```

and asserted, above, that a forged GUC would still raise. It does not. SQL makes
no promise about which side of an `AND` is evaluated first, and PostgreSQL took
the cheap side: for a row belonging to another workspace the comparison is
already false, so the throwing authorizer was never called. The gate showed the
same principal, in the same workspace, asking for the same capability, getting
two different answers — a direct call raised `service principal holds none of
{archive-import}`, while the identical check reached through the policy returned
`0` with no error. Tenant isolation held; the *fail-loud* contract did not.

Reversing the operands would have been a fix in appearance only, resting on the
same absent guarantee. The order is now structural:

```sql
CASE WHEN identity.authorize_service_workspace_any(<guc>, caps) IS NOT NULL
     THEN workspace_id = <guc>
     ELSE false
END
```

PostgreSQL documents that a `CASE`'s `WHEN` condition is evaluated before its
`THEN` result and that an unselected branch is not evaluated at all. The row
column appears *only* inside `THEN`, so it is unreachable until authorization
has already returned. The documented exception — constant folding at plan time —
cannot apply (`current_setting` and the authorizer are `STABLE`, not
`IMMUTABLE`) and would in any case run the authorizer *earlier*. All three
policies — `importer_read`, `importer_insert`, `importer_lock_only` — take this
shape, and 017 now asserts it against `pg_policy` positionally, so a regression
fails the migration rather than a later gate. (**As first written that assertion
was itself broken and would have failed a correct tree — see Round 9.**)

**The guarantee, stated exactly.** Per *scanned row*: wherever the policy is
evaluated, authorization is proven before the workspace comparison, so an
unauthorized selected workspace raises 42501 instead of returning an empty set.
This is *not* a claim that RLS raises on a relation for which no rows are
evaluated — an empty table evaluates no qual and still yields zero rows quietly.
That residual case is covered by the layer above: the service entrypoints in
`packages/db/src/workspace-context.ts` call the authorizer explicitly before
touching data, so unauthorized context is refused before a relation is reached.
RLS is the backstop for that call being skipped, not the only check.

**A NOLOGIN owner is not a runtime role.** Two ACL tests selected their subjects
by name — `grantee LIKE 'ai_capital_%'` — and therefore indicted
`ai_capital_owner` for holding `DELETE`/`TRUNCATE` on all 18 ledger tables and
`SELECT` on the five withheld views. Those are not grants anyone issued:
PostgreSQL gives an owner the full privilege set on its own objects, and an
owner may restore anything revoked from it, so an ACL entry against the owner is
not a boundary and revoking it would only have produced a comforting catalogue.

The boundary that is real is that **nobody can authenticate as the owner**. Both
tests now select on `pg_roles.rolcanlogin` (excluding superusers, who bypass
privilege checks by definition), each with a positive non-vacuity assertion
pinning the LOGIN application roles — **as of this round, the five that then
existed: `agent`, `app`, `importer`, `migrator`, `operator`** — and re-asserting
that `ai_capital_owner` is NOLOGIN right where the exclusion is made. Coverage
is unchanged in extent: every LOGIN role against every ledger table, and every
LOGIN role against all five withheld views. Ownership itself was not weakened,
and nothing was revoked.

> **Superseded on 2026-09-13 — the count, not the principle.** The *method*
> above stands unchanged: select on `rolcanlogin`, exclude superusers, and pin
> the examined role set positively so the assertion cannot pass vacuously. Only
> the membership of that set has moved. Slices S2 and S3 added
> `ai_capital_pipeline` and `ai_capital_claim_writer`, so **the contract is now
> seven LOGIN roles** — `agent`, `app`, `claim_writer`, `importer`, `migrator`,
> `operator`, `pipeline` — alongside two NOLOGIN roles, `ai_capital_owner` and
> `ai_capital_identity_authority`: nine in total.
>
> Leaving the five-name lists in place had a cost. They were written as exact
> equality against `pg_roles`, so the 2026-09-13 runtime-role rehearsal met a
> *correctly* provisioned nine-role cluster and failed three assertions that
> were themselves stale — the tests were wrong, not the cluster. A fourth
> assertion had been written as `>= 5`, which does not fail on a stale count but
> is worse: a floor cannot detect a role that is missing, which is precisely the
> condition that makes "no LOGIN role can execute this" trivially true.
>
> Both shapes are gone. Every such assertion now reads its expected set from one
> exported manifest — `ALL_PRODUCTION_ROLES`, `LOGIN_ROLES` and `NOLOGIN_ROLES`
> in `tests/integration/tenancy/fixture.ts` — and compares it as an exact set
> with both sides sorted in JavaScript, so the result does not depend on the
> database's collation. `tests/unit/bootstrap-contract.test.ts` pins that
> manifest against `ops/roles/000_cluster_roles.sql` **without a database**, so a
> future role addition fails the ordinary unit gate rather than waiting for a
> separately authorized cluster rehearsal to discover it. A duplicated literal
> cannot be corrected in one place; a manifest can.

### Round 9 (2026-09-07) — two guards that did not guard

Both defects here are the same mistake in different materials: a check that
looked right on the page and could not have held.

**The migration-time policy guard matched the GUC, not the column.** Round 8's
`pg_policy` assertion located the row column with `strpos(e, 'workspace_id')`.
That is not where the column is. `pg_get_expr` names the GUC first, inside the
literal `'app.workspace_id'` that the authorizer takes as its argument — and
that literal sits in the `WHEN` condition. So `THEN < workspace_id` was **false
for the correct policy**, and the assertion would have aborted migration 017 on
a good tree: a guard that fails closed against the thing it was written to
protect. (The authorizer's own name is not the hazard it first appears to be —
it ends `workspace_any`, not `workspace_id` — but it is masked anyway so a
future rename cannot quietly reintroduce the problem.)

The fix masks both non-column occurrences by exact name before locating the
column, with replacements of identical length so every offset in the masked
string still lines up with the original — which is what makes the four positions
comparable at all. A boundary-aware `~` then confirms the survivor is a real
`workspace_id =` comparison rather than any substring, and 017 asserts the
length-preservation invariant itself rather than trusting it. `regexp_instr`
would have been the tidier tool and was rejected deliberately: it is PostgreSQL
15+, nothing else in migrations 001–017 needs anything newer than 8.x, and a
version floor is not a thing to acquire as a side effect of a lint. The guard's
logic is now exercised database-free against representative deparsed text
containing both hazards, proving it accepts the intended `CASE` and rejects the
comparison-first `AND`, the reversed `AND`, a comparison inside `WHEN`, a
missing `CASE`, a missing authorizer, and a branch that never compares the row.

**Two connections on one login are one principal.** The changed-archive test
opened two clients with `connectAs('importer')`, called one the publisher and
the other the reconciler, granted the single underlying principal *both*
`archive-import` and `reconciliation` in *one* workspace, and then asserted that
it lacked `reconciliation`. Capability resolves from `session_user` through
`identity.current_service_principal()`, and the fixture binds exactly one
service principal per login, so no database could ever have satisfied that
assertion — the gate reported it as `expected true to be false`.

Authority is keyed by *(principal, workspace)*, so the separation is now by
workspace: `archiveWs` holds `archive-import` only and carries the publication
and every carve-out refusal; `reconWs` holds `reconciliation` only and carries
the positive transitions and the whole state machine, on a case opened there for
the purpose rather than the changed-archive case from a workspace where nobody
holds `reconciliation`. Each workspace asserts both halves — the capability it
has and the one it does not — so neither block can pass vacuously, and the file
proves at runtime that both clients still authenticate as `ai_capital_importer`
and resolve to the same principal. No second principal, login or role was
created, and the cross-workspace test reuses `reconWs` instead of seeding a
third workspace with an ad-hoc grant.


## Runtime-role rehearsal remediation (2026-09-13)

Slice S3B — `ai_capital_pipeline` and `ai_capital_claim_writer` — was rehearsed
against a disposable, isolated PostgreSQL 17 cluster: nine roles from 000, the
010 bootstrap, all eighteen migrations, the 090 lockdown, then the tenancy
suite and a full positive/negative privilege probe matrix. Ownership was
perfect, the negative probes were 37/37, and the privilege matrix matched the
design exactly in every schema except one. Four defects survived, and none of
them could have been found without a database.

**1 — the `public` grant in migration 018 was a silent no-op.** 018 carried
`GRANT USAGE ON SCHEMA public TO ai_capital_pipeline`, was applied cleanly, and
granted nothing. Migrations execute under `SET LOCAL ROLE ai_capital_owner`;
schema `public` is owned by the `pg_database_owner` pseudo-role, of which
`ai_capital_owner` is not a member, and the owner's own `USAGE` carries no grant
option.

The load-bearing fact is that **PostgreSQL does not raise an error for a grant
the grantor cannot make.** It emits `SQLSTATE 01007`,
`WARNING: no privileges were granted for "public"` — a warning, not an error, so
`ON_ERROR_STOP` does not stop and the node-postgres runner does not see it. The
migration recorded itself as applied. The observable failure was not a
permission error at all: it was `SQLSTATE 42704`, `type "vector" does not exist`,
because a missing schema `USAGE` prevents name resolution before any privilege
check on the type occurs. The grant moved to 010, where the cluster
administrator can actually make it stick.

This generalises into the rule the two files now follow: **010 grants on
database-owned objects; migrations grant on owner-owned application objects.**
A migration may only grant what `ai_capital_owner` owns.

**2 — `PUBLIC` still held `CONNECT` and `TEMPORARY` on the database.** A new
database is not private: its ACL is seeded from `acldefault('d', ...)`, which
grants both to `PUBLIC`. Naming seven roles in a `GRANT CONNECT` adds privileges
without removing the default, so the rehearsal measured `PUBLIC` holding both
after 010 *and* after the 090 lockdown — a cluster-wide open door behind a list
that looked like an allowlist. 010 now issues
`REVOKE CONNECT, TEMPORARY ON DATABASE ... FROM PUBLIC` **before** any database
grant, so the named list is the complete access list from the first moment
onward. `TEMPORARY` is revoked with it because it is a write privilege.

**3 — `briefing.predictions` was missing `SELECT`.** 018 granted
`INSERT, UPDATE`, which is what a plain `INSERT` and a plain `UPDATE` need. The
real statement is `INSERT ... ON CONFLICT (date) DO UPDATE`, and PostgreSQL
requires `SELECT` on the conflict target to arbitrate the conflict; without it
the whole statement is refused with `42501`. The first probe of this path used
`UPDATE ... WHERE date = ...` and passed, which is exactly why it was re-probed
with the production statement shape. **A privilege probe that does not use the
real statement shape is not a probe of that path.**

**4 — three tenancy assertions were stale, not wrong in principle.** They
hard-coded a five-name role list and a count of seven that predated
`ai_capital_pipeline` and `ai_capital_claim_writer`, so a *correctly* provisioned
nine-role cluster failed them. The lists are now derived from a single exported
manifest in `tests/integration/tenancy/fixture.ts` — nine roles, seven LOGIN and
two NOLOGIN — which `bootstrap-contract.test.ts` independently pins against
`ops/roles/000_cluster_roles.sql` without a database. A duplicated literal
cannot be corrected in one place; a shared manifest can.

**What the rehearsal establishes about method.** Three of these four defects are
invisible to source review, to typechecking, and to every database-free test in
this repository, because all three are properties of what PostgreSQL *does*
rather than of what the SQL *says*. Defect 1 in particular is a statement that
is syntactically valid, semantically meaningful, applied without error, and
completely ineffective. Slices that change grants need a rehearsal on a real
cluster, with probes issued in the production statement shape.


## S4A / S4B — the dashboard read role (2026-09-14)

Everything above this line is left as written. The 2026-09-13 statements describe
the S3B rehearsal accurately **for that date**: nine roles, seven LOGIN, eighteen
migrations. They are history, not error, and rewriting them would destroy the
record of how the design arrived here. What follows supersedes their *counts*,
not their method.

**Current topology: ten production roles — eight LOGIN, two NOLOGIN.** The tenth
is `ai_capital_dashboard`, the operator dashboard's read identity. The NOLOGIN
pair is unchanged: `ai_capital_owner` and `ai_capital_identity_authority`.

**The CONNECT set is nine, and the distinction matters.** `010`'s named
CONNECT-only statement lists the **eight LOGIN roles**; `ai_capital_owner` reaches
the database through its own separate `GRANT CREATE, CONNECT`. So nine roles hold
`CONNECT` while eight are named — two different questions, and an assertion that
conflates them fails against a correctly provisioned cluster. That is not
hypothetical: the Round-3 design carried exactly that error and Codex caught it.
`ai_capital_identity_authority` holds no `CONNECT`. `PUBLIC` holds neither
`CONNECT` nor `TEMPORARY`, which is what makes a named list an admission list.

**Migration 019 and `CURRENT_V19`.** `019_dashboard_read_grants.sql` is a
grants-only migration — it defines no object, so `017` remains the final *ledger*
migration. The manifest is renamed completely: `CURRENT_V19_MANIFEST`,
`ManifestRecognition = 'CURRENT_V19' | 'UNRECOGNIZED'`, `manifest_version = 'V19'`,
nineteen entries. **No `CURRENT_V18` alias is retained** — a superseded manifest
that kept answering for a database which had moved past it would let the label
mean two things, which is precisely what strict recognition exists to prevent.
The one surviving mention of `CURRENT_V18` in the source is the sentence that says
the alias does not exist.

**The dashboard's grant boundary is five tables.** `USAGE` on schema `trade`, and
`SELECT` on `trade.countries`, `trade.chokepoints`, `trade.chokepoint_routes`,
`trade.ticker_dependencies` and `trade.flows` — traced from the one route that
reads PostgreSQL, not assumed. No writes, no `ON ALL TABLES`, no default
privileges, no sequences, no functions, no memberships, no grant option, no
`public` USAGE, no `TEMPORARY`, no `CREATE`.

**The connection boundary.** `getDashboardPool()` reads `DASHBOARD_DATABASE_URL`
and nothing else, requires an explicit PostgreSQL scheme, user, host (or socket)
and database, and refuses an incomplete value *before* constructing a pool —
because `createPool()` would otherwise complete it from `PGDATABASE`/`PGUSER`/
`USER`, which is a fallback wearing a different name. A password is not required
structurally; production authentication policy is a separate provisioning gate.
Manual refresh keeps its market-closed `409` precedence and otherwise returns
`503 REFRESH_UNAVAILABLE`, holding no credential and launching no subprocess,
until S4F-refresh.

**S4B, on a disposable socket-only PostgreSQL 17.10 cluster with SCRAM
authentication.** Ten roles created; **19/19 migrations applied** with all
nineteen ledger hashes matching the files on disk; manifest recognition
**`CURRENT_V19`**; zero real server `WARNING` records and zero `SQLSTATE 01007`.
Pre-lockdown tenancy **10 passed**, post-lockdown **445 passed**, both zero
failures. The dashboard gate ran **48 probes, 48 as expected**: five positive
reads plus the real `DISTINCT ON` flows query; writes, forbidden schemas, object
creation and `SET ROLE` escalation all `42501`; the `vector` type `42704`, because
without `public` USAGE the name cannot resolve before any privilege check. The
role's readable set, computed database-wide, was **exactly those five relations**,
and a newly created table in the granted schema was **not** readable — the runtime
proof that neither `ON ALL TABLES` nor default privileges were used. A real
`getDashboardPool()` probe connected as `ai_capital_dashboard` to the disposable
database over the Unix socket while `PGDATABASE`, `PGHOST`, `PGPORT`, `PGUSER` and
`USER` all pointed elsewhere, read all five tables, and closed cleanly; `getPool()`
refused for want of `DATABASE_URL`. Zero residue.

Evidence: operator-local evidence bundle (stored outside the repository),
`s4b-dashboard-gate-20260914T141413Z`, manifest `SHA256SUMS.txt` =
`02eea006e16f5bb0ece468ed1aa9d7f7ee4e73f3ce7dfce8ef8ea455e306bb6d`, 16/16 entries
verified. The bundle is not tracked here: an absolute operator path in a tracked
record is wrong on every other machine, and the manifest hash is what makes the
bundle identifiable regardless of where it lives.

**Production remains unprovisioned and un-cut-over.** Nothing here has been
applied to a production cluster: no role exists there, no credential has been
installed, no consumer has been repointed. The `pg_hba.conf` and SCRAM audit
remains a hard stop before provisioning, and `ai_capital_app` activation remains
separate and blocked. The claim-writer credential fallback is addressed in the
next section.


## S4C — the claim-writer credential boundary (2026-09-14)

Claim persistence used to fall back to the general pool when
`CLAIM_WRITER_DATABASE_URL` was unset or blank, so a missing narrow credential
silently escalated to a broader one. Tracing the path turned up something
sharper: a blank, malformed or *incomplete* value did not fall back at all — it
was handed to `createPool()`, whose `pinDestination()` completes a missing
database from `PGDATABASE`, then the connection-string user, then `PGUSER`, then
`USER`. Measured with `PGDATABASE=ambient_claims_db` set, `'   '`,
`redis://localhost:6379` and `postgres://host.example` all resolved to
`ambient_claims_db`. None of those names a protected database, so the write was
*allowed*. Production `ai_capital` stayed protected by the live-name gate, but
"not production" is not "intended".

**The shared validator.** `requireExplicitPostgresUrl(varName, raw)` was
extracted from the dashboard implementation in `pool.ts` and parameterised, so
one piece of security logic serves both credentials rather than two copies
drifting apart. It requires the `postgres://` or `postgresql://` form and an
explicitly stated **user, host (or `?host=` socket) and database**; it refuses
surrounding whitespace rather than trimming it; it returns the original string
byte-for-byte; and it names the variable in every message while revealing no
value. There is **no ambient fallback** for either caller.

**Authorization, three times, each catching what the others cannot.** Against the
validated URL *before* a protected writer pool is constructed — so a refused
attempt neither builds a pool nor leaves one cached for the next call to find.
Against the cached pool on every retrieval, because a pool may have been created
when the environment read differently. And again at **SQL-issue time**, because
`writer()` resolves synchronously before the first `await` and an authorizing
scope can close in between; that is the W4-1 regression, and it is now covered by
a behavioural test rather than a source scan.

**The cached pool is byte-bound to its credential.** Validation answers "is this
value usable?", not "is this the value we are using?". Without the binding, a
process that started on credential A and later saw a different but equally valid
credential B would validate B and write through A's pool. Drift now fails closed,
naming neither value; `closeClaimWriter()` is the way to change credentials. A
successful close clears pool and binding; a **failed** close retains both, so
cleanup stays retryable and the next call cannot quietly rebuild against a
different credential.

**Evidence.** A new database-free suite of **88 tests** exercises the boundary
through the public persistence API. Its driver mock is wholly inert — it imports
no real driver class, extends nothing, and has no socket-capable path — and it
proves that about itself with a structural self-check and a behavioural one. An
earlier version of this harness subclassed the genuine pool and therefore
*permitted* real connection attempts; that is recorded here because the
conclusion drawn from it at the time was not warranted. The **73-test** dashboard
suite passes **unmodified**, which is the regression proof for the shared
extraction. Eleven mutation controls, including one that removes the
cached-credential equality check, are all killed.

**No role, migration or grant changed.** `ai_capital_claim_writer`, its `CONNECT`
in `010` and its `desk` privileges in `018` already existed; S4C changes which
credential the code demands, not what the database permits.

**No database-backed gate was required — but not because everything here is
pre-connection.** An earlier draft of this paragraph said every property was
about what happens before a connection exists. That is false, and the exception
is the most interesting property in the slice. The properties divide three ways:

*Pre-construction:* credential presence, URL validation, refusal of ambient
fallback, and the initial production authorization — all of which complete before
any pool or client object is built.

*Singleton-lifecycle:* the byte binding between the cached pool and the
credential that created it, and the close semantics that clear both on success
and retain both on failure. These are properties of module state across calls,
not of any single connection.

*Post-connect but pre-SQL:* the final authorization check. It runs **after**
`Pool.connect()` resolves, deliberately, because that await is precisely where an
authorizing scope can close beneath a caller who already holds the pool — the
W4-1 regression. Calling it pre-connection would describe the wrong thing and
would have missed the bug it exists to catch.

All three are nevertheless tested **database-free**, because the fake Pool and
client are wholly inert: `connect()` resolves to a stub the test installs, so the
post-connect ordering is exercised without a server ever being involved.

What makes a PostgreSQL-backed gate unnecessary is separate from that: **no grant
and no database behaviour changed in this slice**, and the claim-writer role's
actual database privileges were already proven by the S3B rehearsal. What a
database-free suite cannot prove — real authentication, real connectivity, and an
actual claim landing in `desk.agent_claims` under the real credential — is
**still required**, and belongs to the later provisioning and cutover gate. It
cannot exist before the credential does, and shipping this slice does not
discharge it.

**Status: the source boundary is implemented and awaiting commit; the production
credential remains unprovisioned.** No production cutover has occurred. Until the
credential is installed, non-Vitest claim persistence fails closed — the intended
state, not a defect.
