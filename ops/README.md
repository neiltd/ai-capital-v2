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
| 3 | *(migrations 001–017)* | `ai_capital_migrator` | every deployment |
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
  rather than a missing privilege. Source tracing over 011–017 finds exactly one
  reference from the tenancy schemas into `public`: 011's `EXCLUDE USING gist`
  opclass lookup, at DDL time, by the owner. No runtime role needs it, and none
  is given it. `CREATE` on `public` is granted to nobody at all.

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

## Verifying a database after bootstrap

Nothing in this directory has been executed. When the database-execution gate
opens, the order is:

1. `ops/roles/000_cluster_roles.sql` — as a cluster administrator, once per
   cluster.
2. `ops/bootstrap/010_database_bootstrap.sql` — once per database.
3. `MIGRATION_OWNER_ROLE=ai_capital_owner` + the migration runner, connecting as
   `ai_capital_migrator`.
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
