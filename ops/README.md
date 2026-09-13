# `ops/` — cluster and database administration

These files are **not migrations**. `packages/db/src/migrate.ts` connects as the
application's migrator, which deliberately has no `CREATEROLE` and no superuser
rights; putting role creation or extension installation in the ordinary
migration path would require giving the application cluster-level authority it
must never hold.

Nothing here is executed by this repository's tooling. Each file is run by hand,
by a cluster administrator, in the order below.

## Run order

| # | File | Run as | When |
|---|---|---|---|
| 1 | `roles/000_cluster_roles.sql` | cluster administrator | once per cluster |
| 2 | `bootstrap/010_database_bootstrap.sql` | cluster administrator | once per database, and again to re-open a migration window |
| 3 | *(migrations 001–018)* | `ai_capital_migrator` | every deployment |
| 4 | `bootstrap/090_post_migration_lockdown.sql` | cluster administrator | immediately after step 3 |

### What step 2 must provide, and why each piece is load-bearing

The 2026-09-06 disposable-cluster gate could not get past step 3. Three of its
blockers were here, and all three were privileges the chain needs at a moment
nobody had executed:

- **`CREATE` on the DATABASE *and* on schema `db`.** `migrate.ts` opens with
  `CREATE SCHEMA IF NOT EXISTS db; CREATE TABLE IF NOT EXISTS
  db.schema_migrations`. The first checks the database privilege. The second
  checks `CREATE` **on the schema**, and does so *before* the `IF NOT EXISTS`
  short-circuit — so it is refused even though the table already exists. Only
  the database grant was present, and every fresh database failed on the
  runner's very first statement with `permission denied for schema db`. Step 4
  revokes both.
- **`INSERT` on `db.schema_migrations`, for the window only.** Step 2 grants it
  and step 4 revokes it. An earlier version granted `SELECT, INSERT`
  permanently and step 4 deliberately kept both, on the reasoning that
  re-opening a window should not also require repairing the runner's own
  bookkeeping. That got the risk backwards: the ledger is the artefact every
  downstream check trusts to say which migrations are applied and with what
  hashes, so a deployment login able to append to it after lockdown can record
  that a migration ran when it could not have. `USAGE ON SCHEMA db` and
  `SELECT` stay permanent — reading a closed ledger is not a window privilege —
  and re-running step 2 restores `INSERT` as part of the one deliberate act
  that reopens the window.
- **Both extensions, `WITH SCHEMA public`, before the `public` revoke.**
  `btree_gist` for the exclusion constraint in 011, and **`vector` for migration
  006** — which is published and immutable and says
  `CREATE EXTENSION IF NOT EXISTS vector` unqualified. Unprovisioned, that
  statement resolves into whatever the owner's `search_path` offers first, where
  it has no `CREATE` and must not be given any; and extension creation needs
  superuser besides. Step 2 names the schema **explicitly** because both
  extensions are relocatable and `--no-psqlrc` does not neutralise a
  `search_path` set with `ALTER DATABASE ... SET` or `ALTER ROLE ... SET` — the
  server applies those at connect time, before psql runs anything. Everything
  downstream assumes `public`: the USAGE grant below, the lockdown that
  preserves it, and the post-lockdown assertion on `pg_extension`.
- **A pinned migration `search_path`, set by the runner — not by this file.**
  Placement is not visibility. Migrations 006 and 011 resolve names that live in
  `public` *without qualifying them* (`vector(384)`, `vector_cosine_ops`,
  btree_gist's `=` operators), so whether they resolve depends on the migrator
  session's `search_path` — which `ALTER DATABASE ... SET`, `ALTER ROLE ... SET`,
  a connection parameter or `PGOPTIONS` can each supply, and the server applies
  before any client statement runs. This script cannot fix that: it governs the
  administrator's session, not the migrator's. So `packages/db/src/migrate.ts`
  issues `SET LOCAL search_path = pg_catalog, public` immediately after
  `SET LOCAL ROLE`, per migration, only when `MIGRATION_OWNER_ROLE` is
  configured. It is transaction-local, omits `"$user"` and every
  application-owned schema, and grants nothing — every ACL still applies.
- **`USAGE ON SCHEMA public` for `ai_capital_owner`, and nobody else.**
  Revoking from `PUBLIC` removes the ability to *see* anything in `public`,
  including the extension objects step 2 just installed there — so 006 failed
  with `type "vector" does not exist`, which reads like a missing extension
  rather than a missing privilege. Source tracing over 011–018 finds exactly one
  reference from the *tenancy* schemas into `public`: 011's `EXCLUDE USING gist`
  opclass lookup, at DDL time, by the owner.

  **One runtime role does need `public`, and migration 018 grants it.**
  `ai_capital_pipeline` runs `$N::vector` and `ORDER BY embedding <=> $N`
  against `capital.chunks` (`packages/db/src/vector-store/pg.ts`), and both the
  `vector` type and pgvector's `<=>` operator live in `public`; PostgreSQL
  requires schema `USAGE` to resolve either by name. Without it those stages
  fail with "permission denied for schema public" — a privilege error that reads
  like a missing extension. It is **`USAGE` only**. `CREATE` on `public` is
  granted to nobody at all, including the pipeline.

## Invocation

Every file uses the **same** model: psql supplies exactly one transaction, and
the SQL contains no `BEGIN`/`COMMIT` of its own. Mixing the two would silently
break the `SET LOCAL ROLE` these files depend on for deterministic ownership.

```bash
psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
     -d postgres -f ops/roles/000_cluster_roles.sql

psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
     -d "$TARGET_DB" -v dbname="$TARGET_DB" \
     -f ops/bootstrap/010_database_bootstrap.sql

MIGRATION_OWNER_ROLE=ai_capital_owner \
DATABASE_URL="postgres://ai_capital_migrator@…/$TARGET_DB" \
  node -e "import('@common/db').then(m => m.runMigrations()).then(console.log)"

psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
     -d "$TARGET_DB" -v dbname="$TARGET_DB" \
     -f ops/bootstrap/090_post_migration_lockdown.sql
```

`ON_ERROR_STOP=1` is **mandatory**. Without it psql continues after a failed
`SET ROLE` and creates objects under the wrong owner — the exact failure this
ordering exists to prevent.

## Why `MIGRATION_OWNER_ROLE`

Object ownership is decided by the role that runs `CREATE`, and an owner may
`ALTER`, `DROP` and `GRANT` on its own objects regardless of ACLs. Without this
variable, a fresh database ends up with schemas 001–010 owned by the deployment
login, so "the migrator controls nothing after lockdown" would simply be false.

A `SET LOCAL ROLE` inside each migration file would fix 011 onward, but 001–010
are published and immutable — `migrate.ts` refuses to re-run a file whose hash
changed. The runner is therefore the only place ownership can be set for them.
`REASSIGN OWNED` in step 4 is the backstop that makes the claim a fact about the
catalogue rather than a hope.

## Roles

| Role | Login | Purpose |
|---|---|---|
| `ai_capital_owner` | **no** | owns every schema, table, view and trigger |
| `ai_capital_identity_authority` | **no** | owns the SECURITY DEFINER functions, and nothing else |
| `ai_capital_migrator` | yes | deployment identity; assumes the owner during a window |
| `ai_capital_app` | yes | human request runtime — **no tenant privilege until the OIDC gate** |
| `ai_capital_importer` | yes | archive import and the manual-entry domain API |
| `ai_capital_agent` | yes | specialist agents; SELECT only, RLS-bound |
| `ai_capital_operator` | yes | **global** grant administrator — see below |

Every runtime role is created with **zero memberships**. `SET ROLE` can only
target a role you are a member of, so a runtime login cannot assume another
service's identity — which is what makes `session_user` a trustworthy basis for
authorization inside `identity.*`.

### `ai_capital_operator` is deliberately global

It can cancel or revoke a capability grant in **any** workspace. That is
unavoidable: grant administration is a cross-tenant function, and scoping it per
workspace would need a grant to administer grants, which is circular.

Its blast radius is bounded by what it is *not* given. It receives exactly three
things — `CONNECT` on the database, `USAGE` on schema `identity`, and `EXECUTE`
on `identity.terminate_service_grant` — and **no table privilege of any kind, no
role membership, and no access to `investment_ledger` at all**. It cannot read a
transaction, an account, a document or an archive row. It can only end a grant,
and every termination records an immutable reason and its own principal id.

## Taking a read-only inventory

Before anything decides whether this database's privileges are *correct*,
somebody has to be able to say what they **are**. `packages/db/bin/db-inventory.ts`
is that step and only that step.

```bash
mkdir -p ~/ai-capital-evidence && chmod 700 ~/ai-capital-evidence

VERIFY_INVENTORY_DATABASE_URL="postgres://ai_capital_migrator@…/ai_capital" \
  pnpm --filter @common/db db-inventory \
    --mode inventory \
    --run-id 2026-09-10-preflight \
    --output ~/ai-capital-evidence/inventory-$(date -u +%Y%m%dT%H%M%SZ).json
```

It opens one transaction, reads the catalogue, rolls back, disconnects, and
publishes one canonical JSON fact document. It ends with

```
INVENTORY COMPLETE — NO VERDICT
```

**and that is not a pass.** It says the collection finished, not that the
database is acceptable. This build issues no verdict of any kind: a missing
object, an unexpected grant, a role that unexpectedly holds `LOGIN`, a drifted
extension version and an invalid index are each *recorded* and none of them
fails the run. Deciding what any of that means is a separate, later act.

The one label the document carries is `binding.manifest_recognition`, either
`CURRENT_V18` — all eighteen published migrations recorded under their exact
content hashes and nothing else — or `UNRECOGNIZED`, with the evidence for it
(`missing`, `additional`, `hash_mismatched`) beside it. Recognition is strict:
one missing migration, one extra, or one changed hash is `UNRECOGNIZED`, and
there is no partial or subset match. There is deliberately no `V19` branch, so a
database carrying a migration nobody has written lands in `UNRECOGNIZED` and
gets a human.

## Runtime roles: where each privilege comes from

**No live database has been changed by any of this.** Everything below describes
what a future run of the bootstrap and the migration chain would produce on a
fresh target, or on one whose migration window has been deliberately reopened.

Database access and object access are granted in two different places, by two
different principals, and neither can do the other's job:

| | Granted by | Run as | What it confers |
|---|---|---|---|
| `CONNECT` on the database | `bootstrap/010_database_bootstrap.sql` | cluster administrator | the right to open a connection, and nothing inside the database |
| schema, table and sequence privileges | `migrations/018_legacy_runtime_grants.sql` | `ai_capital_owner`, via the migration runner | exactly the objects each role touches |

Migration 018 cannot grant `CONNECT`: it executes under
`SET LOCAL ROLE ai_capital_owner`, and that role holds `CONNECT` without the
right to re-grant it and does not own the database, so the statement is refused
with `SQLSTATE 42501`.

### What migration 018 does

It gives the two runtime identities their least-privilege object access, and
nothing else. It creates nothing, drops nothing, alters no ownership, sets no
default privileges, grants no role membership, and issues no `GRANT ALL` or
`ON ALL`.

- **`ai_capital_pipeline`** — the identity the scheduled DAG runs as, replacing
  the cluster superuser the pipeline used to connect as. `USAGE` on `capital`,
  `thesis`, `portfolio`, `briefing`, `trade` and `public`; per-table `SELECT`,
  `INSERT` and `UPDATE` exactly where the DAG needs them; `USAGE` on one
  sequence, `capital.fetch_log_id_seq`. **No `DELETE` anywhere**, and no
  privilege at all in `identity`, `investment_ledger`, `cash_ledger`, `desk`,
  `db` or `graph`.
- **`ai_capital_claim_writer`** — the claim protocol and only that. `USAGE` on
  `desk`; `SELECT, INSERT, UPDATE` on `desk.agent_claims`; `INSERT` on
  `desk.agent_runs`; `USAGE` on both `desk` sequences. Nothing outside `desk`.
- It also revokes the built-in `PUBLIC EXECUTE` from
  `desk.agent_claims_assertion_is_immutable()`. No compensating `EXECUTE` grant
  accompanies it: PostgreSQL checks a trigger function's `EXECUTE` when the
  trigger is *created*, not when it fires, so the immutability trigger keeps
  working for every writer.

### Manual mutation is deliberately excluded

Every privilege in 018 is reachable from one of the 23 stages of
`DAILY_PIPELINE`. Paths whose only call site is a manual CLI are **not** granted
to `ai_capital_pipeline`, even where the same source file defines them:
`portfolio.positions` `DELETE` and `INSERT` (`cli-portfolio`),
`capital.pending_manual_input` `UPDATE` (`cli-config`), the `thesis` create and
update paths (`creator.ts`, `updater.ts`, `review.ts`), and every `graph.*` and
`trade.*` write — `dependency-graph-engine` and `trade-graph` are not DAG
stages. Those CLIs keep running under the administrator credential until a
**manual-mutation role is separately designed**; that role does not exist yet
and `ai_capital_pipeline` must not be widened to stand in for it.

### `verify-privileges` and `verify-all` are NOT authoritative

> **Warning.** `pnpm --filter @common/db verify-privileges` and `verify-all`
> predate the V3 tenancy model. They do not know about `ai_capital_owner`,
> `ai_capital_identity_authority`, the `SET`-without-`INHERIT` memberships, the
> post-lockdown ACLs, `investment_ledger` or migration 017's RLS and grants.
> A pass from either says nothing about whether this database matches the V3
> design, and a failure from either is as likely to be the checker being out of
> date as the database being wrong. **Do not quote them as evidence.** They stay
> in the repository because removing them is a separate change; the inventory
> collector is what the V3-aware enforcement slice will be built on.

### The mandatory run ID

`--run-id` is required and is **never generated**. A machine-made id would make
every run look equally well-attested while tying none of them to anything; the
operator's id is what binds the artifact to the change, ticket or maintenance
window it was taken for. Letters, digits, dot, dash and underscore, up to 64
characters.

### The evidence directory must be `0700`

The artifact is a complete map of who may read and write what in a real-money
database. The collector refuses to write into a directory that is anything other
than exactly `0700` — not `0755`, not `0750`, not `0770`. `0600` on the file
does not help if the directory is group-readable: the name, size and mtime still
leak, and a group-writable directory lets someone else replace the artifact
outright. The published file is `0600`.

It also refuses to overwrite an existing artifact, and the refusal is atomic
rather than advisory — see the publication sequence below. Evidence is moved
aside deliberately or not at all.

### `VERIFY_INVENTORY_DATABASE_URL`, and nothing else

The CLI reads that one variable. It does **not** fall back to `DATABASE_URL`,
`AGENT_DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_RUNTIME_DATABASE_URL`,
`BOOTSTRAP_DATABASE_URL`, `CLAIM_WRITER_DATABASE_URL`, `PGDATABASE`, `PGHOST`, or
any other generic database variable — a fallback chain is how a tool aimed at an
inspection replica ends up on the live book because a shell happened to export
something, and CLAUDE.md actively encourages exporting `DATABASE_URL`. Requiring
a name that exists for no other purpose means "inventory this database" has to be
said out loud, separately, every time.

The URL is never printed, logged, serialised or hashed. The endpoint recorded in
the artifact is asked of the **server** — `inet_server_addr()`,
`unix_socket_directories`, `port` — rather than parsed out of the URL, so no user
name or password can reach the evidence file even in principle.

### What the artifact is bound to

Every completed artifact carries a `binding` block, and the run fails rather than
publish one that is missing a field:

| Field | Why it is there |
|---|---|
| `run_id` | operator-supplied; ties the artifact to the operation |
| `collected_at_utc` | UTC, so two artifacts are comparable across machines |
| `repository_head` | which source produced it (read from `.git`, read-only) |
| `database_name` | the book it describes |
| `database_oid` | the name is reusable; drop and recreate `ai_capital` and every name-based fact still matches while every object is new |
| `database_owner` | who owns the database itself |
| `endpoint` | host **or** socket directory, port, database — never user, password or raw URL |
| `server_version`, `server_version_num` | which engine |
| `postmaster_start_time` | which *running instance*; a change between two artifacts means a restart happened |
| `server_port`, `cluster_name` | which listener; `cluster_name` is recorded even when empty, because empty is its real default |
| `manifest_recognition`, `manifest_version` | which published schema the ledger matched |
| `exit_status` | stamped `0` at publication. A failed run publishes nothing, so this can never contradict the file's own existence |

### Exit codes

| Code | Meaning | Who fixes it |
|---|---|---|
| `0` | inventory complete — **not** a policy pass | nobody; read the artifact |
| `2` | **refused**: bad or missing `--mode`, `--output` or `--run-id`; missing credential; output directory absent or not `0700`; artifact already present; the session was not read-only, not `ai_capital`, or not `ai_capital_migrator` as **both** `current_user` and `session_user`; inspection authority could not be proved | the operator — fix the invocation or the grant, run again |
| `1` | **broke**: a query, the connection, the cleanup, the filesystem, or the collector itself | an engineer — this is a bug or an outage |

Collapsing 1 and 2 into a single non-zero code is what makes a scheduled evidence
run impossible to triage without reading the log, so they are kept apart.

### What it refuses, and in what order

Everything in the first group happens **before a client object exists**, so a
malformed invocation cannot reach the network at all:

1. a missing or unknown `--mode` (`inventory` is the only one implemented);
2. a missing or relative `--output` — a relative path resolves against a working
   directory the operator does not control under a scheduler;
3. a missing or malformed `--run-id`;
4. an output directory that is missing, is not a directory, or is not `0700`;
5. an artifact already present at that path;
6. a missing `VERIFY_INVENTORY_DATABASE_URL`.

Then, on the connection, in this order:

7. `BEGIN TRANSACTION READ ONLY` is the **first** statement on the session, so
   there is no window in which anything else could have been sent;
8. `transaction_read_only = on` is read back **from inside the session** rather
   than assumed from the statement having succeeded — a connection parameter,
   `ALTER ROLE … SET` or a pooler can each change what the session actually got;
9. `current_database()` must be `ai_capital`, and `current_user` **and**
   `session_user` must both be `ai_capital_migrator`. The last two are checked
   separately because `SET ROLE` moves one and not the other; the collector never
   issues `SET ROLE` and refuses to run if something already has;
10. three capability probes must **evaluate**, each against a role that is not
    the current user: `has_table_privilege`, `has_schema_privilege` and
    `pg_has_role`. Each of those raises rather than answering wrongly when the
    session may not ask, so a denial is loud. A probe that finds no non-self
    subject at all is equally disqualifying — an empty catalogue and a filtered
    view are indistinguishable from inside — and the run stops with
    `INVENTORY INCOMPLETE — INSUFFICIENT INSPECTION AUTHORITY` rather than
    producing a document that looks complete and is not.

Then exactly one `ROLLBACK` attempt and exactly one connection-close attempt —
one cleanup path, taken by success and failure alike, with the rollback counted
before it is awaited so a rejected one is still recorded, and the close attempted
even when the rollback rejected so the session cannot leak. A collection that
succeeded but would not close cleanly **publishes nothing**: the rows may be
fine, but "this session was released" is part of what an artifact on disk
asserts.

### The publication sequence

Publication is last, and every step is load-bearing:

1. `open(temp, O_CREAT|O_EXCL|O_WRONLY, 0600)` — a uniquely named temporary in
   the **same directory** (both `link` and `rename` are confined to one
   filesystem). `O_EXCL` means a stale or planted temporary file is never
   adopted and published as evidence.
2. **Write every byte, in a loop.** `write(2)` is allowed to write fewer bytes
   than asked and still report success; the collector checks the returned count,
   resumes at a **byte** offset into the UTF-8 payload, and fails closed on zero
   progress, a negative count, a count larger than what remained, or a
   non-integer. A short write must never become a truncated artifact stamped
   `complete: true`.
3. `fsync(file)` — the **contents** are durable before any name points at them.
   Doing this after publication can leave a correctly-named empty artifact.
4. `close`, then `chmod 0600`.
5. `link(temp, output)` — **the publication**, and an atomic create-if-absent:
   `link(2)` fails `EEXIST` if the destination exists. This is why it is not a
   rename. `rename(2)` replaces its destination unconditionally, so
   "check `existsSync`, then rename" silently destroys anything created in the
   window between the two — which is exactly the situation the no-overwrite rule
   exists for: two operators, or an operator and a scheduled run, pointed at the
   same evidence path. A concurrent winner is left **byte-for-byte untouched**
   and the loser exits `2`.
6. `fsync(directory)` — the new **name** is durable.
7. `unlink(temp)` — drop the second name; the artifact now has exactly one link
   and the directory holds no residue.
8. `fsync(directory)` — the removal is durable too.

**Failure cleanup.** Before the link succeeds, only the temporary file is
removed and the destination is left alone — on `EEXIST` it belongs to somebody
else and is never deleted, truncated or replaced. After the link succeeds the
destination was created by this call, so both names are removed: a
`complete: true` document whose publication did not complete must not survive.

So an artifact on disk is itself evidence that the session was released and the
bytes reached the platter; there is no partial artifact and none at all on
failure.

### Extension evidence: four classes, and what the fourth one means

| Class | Meaning |
|---|---|
| `direct_member` | `pg_depend` deptype `'e'` — the extension owns it |
| `internal_support` | reached from a direct member through the `'i'`/`'a'` closure; dropping the extension drops it too |
| `application_dependency` | an ordinary object with a **normal** (`'n'`) dependency on something in a closure — a `vector` column, an `hnsw` index, an exclusion constraint using btree_gist's operators. Dropping the extension does not drop it; the drop is refused |
| `unrelated_public_object` | an object living in schema **`public`** that is in neither of the above relations |

The fourth class is deliberately about `public`, not about the application.
`public` is the one schema the bootstrap installs extensions into and then
revokes from `PUBLIC`, so "what is sitting in there that no extension accounts
for?" is a real question with a small answer. "Which application objects don't
depend on an extension?" is not — it is nearly every table in the database, and
labelling `portfolio.positions` or `investment_ledger.transactions`
*unrelated* would drown the one signal the category carries.

Public objects are discovered by **object address**, not by enumerating
catalogues: every schema-qualified object records a normal `pg_depend` entry on
its namespace, so one query finds tables, functions, types, **operators,
operator classes, operator families, conversions, collations and text-search
objects** alike, and `pg_describe_object` names each one. An object whose
catalogue class the server cannot describe is recorded with `described: false`
rather than dropped.

None of the four classes is a verdict. An application object depending on an
extension is not an error, and an unrelated public object is not an intruder —
each is recorded so the enforcement slice can decide.

### Taking an inventory from a linked worktree

`git worktree add` checkouts are supported. There `.git` is a *file* containing
`gitdir: <path>`; the collector resolves it, reads `HEAD` from the per-worktree
Git directory, and follows `commondir` to find `refs/heads/*` and `packed-refs`
in the original repository. Detached `HEAD` is supported in both layouts.
Resolution is read-only file access with no `git` subprocess. Malformed metadata
— a `.git` file naming no gitdir, a `gitdir` or `commondir` pointing nowhere, an
unresolvable branch ref — fails the run before any client is constructed, and
publishes nothing: an artifact that cannot say which source produced it is not
evidence.

### Running it costs the database nothing it can keep

The run is `SELECT`-only inside a read-only transaction that is always rolled
back. It creates nothing, grants nothing, revokes nothing and migrates nothing.

## Verifying a database after bootstrap

Nothing in this directory has been executed. When the database-execution gate
opens, the order is:

1. `ops/roles/000_cluster_roles.sql` — as a cluster administrator, once per
   cluster.
2. `ops/bootstrap/010_database_bootstrap.sql` — once per database.
3. `MIGRATION_OWNER_ROLE=ai_capital_owner` + the migration runner, connecting as
   `ai_capital_migrator`, applying migrations 001–018.
4. `TENANCY_PHASE=pre-lockdown pnpm --filter @common/investment-ledger test:tenancy`
5. `ops/bootstrap/090_post_migration_lockdown.sql` — as a cluster administrator.
6. `TENANCY_PHASE=post-lockdown pnpm --filter @common/investment-ledger test:tenancy`

**The suite runs twice, on purpose.** Before lockdown the migrator still holds
its two `SET`-only role memberships and `CREATE` on the database, and re-running
the migrator is a legal no-op. After lockdown all three are gone and a further
migration is refused until `010_database_bootstrap.sql` is deliberately re-run.
Those are contradictory assertions, and a single suite holding both would have
to weaken one of them until it said nothing. `TENANCY_PHASE` therefore has no
default: a run that guessed could report "post-lockdown passed" on a database
where lockdown had never been applied.

Steps 4 and 6 are the acceptance test for steps 1-3 and 5, and they need **seven
separate login URLs**, one per role, because the authorization functions resolve
the caller from `session_user` and `SET ROLE` does not change it. A suite that
switched roles inside one connection would exercise a different mechanism from
the one production uses:

```
TENANCY_MIGRATOR_DATABASE_URL   ai_capital_migrator
TENANCY_IMPORTER_DATABASE_URL   ai_capital_importer
TENANCY_AGENT_DATABASE_URL      ai_capital_agent
TENANCY_APP_DATABASE_URL        ai_capital_app
TENANCY_OPERATOR_DATABASE_URL   ai_capital_operator
TENANCY_ADMIN_DATABASE_URL      a cluster administrator — SEEDING ONLY
TEST_DATABASE_URL               the same disposable database
TENANCY_PHASE                   pre-lockdown | post-lockdown (no default)
```

`ai_capital_owner` and `ai_capital_identity_authority` are absent from that list
on purpose: they are `NOLOGIN` and no credential for either exists. That is what
makes `FORCE ROW LEVEL SECURITY` meaningful, since FORCE removes only the *table
owner's* exemption.

Every connection re-checks `current_database()` from inside the session against
the disposable-database allowlist in
`packages/investment-ledger/tests/integration/support.ts`, so a URL that
resolves somewhere unexpected — a service alias, a pooler, a `PGDATABASE`
default — is refused rather than written to. `TENANCY_ADMIN_DATABASE_URL` seeds
identity rows and installs the append-only test's temporary control policy; it
never asserts a result, because a superuser bypasses every boundary these tests
exist to prove.
