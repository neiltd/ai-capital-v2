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
| 3 | *(migrations 001–019)* | `ai_capital_migrator` | every deployment |
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
- **`USAGE ON SCHEMA public` for exactly two roles: `ai_capital_owner` and
  `ai_capital_pipeline`.**
  Revoking from `PUBLIC` removes the ability to *see* anything in `public`,
  including the extension objects step 2 just installed there — so 006 failed
  with `type "vector" does not exist`, which reads like a missing extension
  rather than a missing privilege.

  The **owner** needs it at DDL time. Source tracing over 011–018 finds exactly
  one reference from the *tenancy* schemas into `public`: 011's
  `EXCLUDE USING gist` opclass lookup — plus 006's own `vector(384)` and
  `vector_cosine_ops`. All of these run as the owner, while a migration is
  executing.

  The **pipeline** needs it at DML time. `ai_capital_pipeline` runs `$N::vector`
  and `ORDER BY embedding <=> $N` against `capital.chunks`
  (`packages/db/src/vector-store/pg.ts`), and both the `vector` type and
  pgvector's `<=>` operator live in `public`.

  **Both grants are made here, in 010, and neither can be made by a migration.**
  This was not the original design: migration 018 carried
  `GRANT USAGE ON SCHEMA public TO ai_capital_pipeline` and appeared to work.
  It did not. Migrations execute under `SET LOCAL ROLE ai_capital_owner`;
  `public` is owned by the `pg_database_owner` pseudo-role, of which
  `ai_capital_owner` is not a member, and the owner's own `USAGE` carries no
  grant option. **PostgreSQL does not raise an error for a grant the grantor
  cannot make** — it emits `SQLSTATE 01007`,
  `WARNING: no privileges were granted for "public"`, which neither
  `ON_ERROR_STOP` nor the node-postgres migration runner can observe. The
  migration recorded itself as applied and granted nothing; the 2026-09-13
  isolated rehearsal measured the result, and it was not
  `permission denied for schema public` either — it was `SQLSTATE 42704`,
  `type "vector" does not exist`.

  The rule this produces: **010 grants on database-owned objects; migrations
  grant on owner-owned application objects.** A migration may only grant what
  `ai_capital_owner` owns.

  It is **`USAGE` only** in both cases. `CREATE` on `public` is granted to
  nobody at all.
- **`REVOKE CONNECT, TEMPORARY ON DATABASE ... FROM PUBLIC`, before any
  `GRANT ... ON DATABASE`.**
  A new database is not private. PostgreSQL seeds its ACL from
  `acldefault('d', ...)`, which grants `CONNECT` and `TEMPORARY` to `PUBLIC` —
  every role in the cluster, present and future. A named `CONNECT` list — even
  today's eight LOGIN roles — restricts nothing unless `PUBLIC` is revoked
  first. The 2026-09-13 rehearsal observed this when the list contained seven
  roles: both privileges were still held by `PUBLIC` after 010 *and* after the
  090 lockdown. `TEMPORARY` goes with it because it is a write
  privilege: it lets any connected role put temp tables on the database's
  default tablespace. The revoke is placed *before* the named grants so that
  from the first moment the database has a restricted ACL, the named list is
  the complete access list.

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
    --target ai_capital \
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
`CURRENT_V19` — all nineteen published migrations recorded under their exact
content hashes and nothing else — or `UNRECOGNIZED`, with the evidence for it
(`missing`, `additional`, `hash_mismatched`) beside it. Recognition is strict:
one missing migration, one extra, or one changed hash is `UNRECOGNIZED`, and
there is no partial or subset match. There is deliberately no `V20` branch and no
retained `CURRENT_V18` alias, so a database carrying a migration nobody has
written — or one that has moved past a superseded manifest — lands in
`UNRECOGNIZED` and gets a human.

## Runtime roles: where each privilege comes from

**No live database has been changed by any of this.** Everything below describes
what a future run of the bootstrap and the migration chain would produce on a
fresh target, or on one whose migration window has been deliberately reopened.

Database access and object access are granted in two different places, by two
different principals, and neither can do the other's job:

| | Granted by | Run as | What it confers |
|---|---|---|---|
| `CONNECT` on the database, and `USAGE` on schema `public` | `bootstrap/010_database_bootstrap.sql` | cluster administrator | the right to open a connection; the right to resolve names in the extension schema |
| schema, table and sequence privileges on **application** schemas | `migrations/018_legacy_runtime_grants.sql` | `ai_capital_owner`, via the migration runner | exactly the objects each runtime role touches |
| the dashboard's read privileges | `migrations/019_dashboard_read_grants.sql` | `ai_capital_owner`, via the migration runner | `USAGE` on `trade` and `SELECT` on five tables |

### The role topology, stated once

**Ten production roles: eight LOGIN and two NOLOGIN.** The NOLOGIN pair —
`ai_capital_owner` and `ai_capital_identity_authority` — are object owners and
grantors, never connection identities.

The **named `CONNECT` list in `010` contains all eight LOGIN roles**:
`ai_capital_agent`, `ai_capital_app`, `ai_capital_claim_writer`,
`ai_capital_dashboard`, `ai_capital_importer`, `ai_capital_migrator`,
`ai_capital_operator`, `ai_capital_pipeline`.

**The actual set of roles holding `CONNECT` after bootstrap and lockdown is
NINE, not eight** — those eight plus `ai_capital_owner`, which is granted
separately and additionally holds `CREATE`. The two counts answer different
questions, and conflating them produces an assertion that fails against a
correctly provisioned database. `ai_capital_identity_authority` holds **no**
`CONNECT`. `PUBLIC` holds **neither `CONNECT` nor `TEMPORARY`**, which is what
makes the named list the effective admission list rather than a description of
one.

The dividing line is **ownership**, not convenience. Migrations 018 and 019
execute under `SET LOCAL ROLE ai_capital_owner`, so they can grant only what that
role owns. The database and schema `public` are not among them, and the two failure
modes differ in a way that matters:

- `GRANT ... ON DATABASE` is **refused** with `SQLSTATE 42501`. Loud.
- `GRANT ... ON SCHEMA public` is **silently discarded** with `SQLSTATE 01007`,
  `WARNING: no privileges were granted`. Not an error, not visible to
  `ON_ERROR_STOP`, not visible to the migration runner. 018 shipped with exactly
  such a statement and granted nothing for it.

### What migration 018 does

It gives the two runtime identities their least-privilege object access, and
nothing else. It creates nothing, drops nothing, alters no ownership, sets no
default privileges, grants no role membership, and issues no `GRANT ALL` or
`ON ALL`.

- **`ai_capital_pipeline`** — the identity the scheduled DAG runs as, replacing
  the cluster superuser the pipeline used to connect as. `USAGE` on `capital`,
  `thesis`, `portfolio`, `briefing` and `trade` — **five schemas; `public` is
  granted by 010, not here, for the reason above**; per-table `SELECT`,
  `INSERT` and `UPDATE` exactly where the DAG needs them; `USAGE` on one
  sequence, `capital.fetch_log_id_seq`. **No `DELETE` anywhere**, and no
  privilege at all in `identity`, `investment_ledger`, `cash_ledger`, `desk`,
  `db` or `graph`.

  `briefing.predictions` carries `SELECT, INSERT, UPDATE`. The `SELECT` is not
  general read access: `prediction-archiver.ts` issues
  `INSERT ... ON CONFLICT (date) DO UPDATE`, and PostgreSQL requires `SELECT` on
  the conflict target in addition to `INSERT` and `UPDATE`. With only the latter
  two the statement fails outright with `SQLSTATE 42501` — measured against the
  real production statement shape during the 2026-09-13 rehearsal, after an
  earlier probe using a plain `UPDATE ... WHERE` missed it.
- **`ai_capital_claim_writer`** — the claim protocol and only that. `USAGE` on
  `desk`; `SELECT, INSERT, UPDATE` on `desk.agent_claims`; `INSERT` on
  `desk.agent_runs`; `USAGE` on both `desk` sequences. Nothing outside `desk`.
- It also revokes the built-in `PUBLIC EXECUTE` from
  `desk.agent_claims_assertion_is_immutable()`. No compensating `EXECUTE` grant
  accompanies it: PostgreSQL checks a trigger function's `EXECUTE` when the
  trigger is *created*, not when it fires, so the immutability trigger keeps
  working for every writer.

### What migration 019 does

It gives `ai_capital_dashboard` — the operator dashboard's read identity — exactly
what `apps/unified-platform/src/app/api/trade-graph/route.ts` reads, and nothing
else. Six statements:

- `USAGE` on schema **`trade`**, and on no other schema;
- `SELECT` on exactly **`trade.countries`**, **`trade.chokepoints`**,
  **`trade.chokepoint_routes`**, **`trade.ticker_dependencies`** and
  **`trade.flows`**.

It grants **no** `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or
`TRIGGER`; **no** `ON ALL TABLES` and **no** `ALTER DEFAULT PRIVILEGES`; **no**
sequence `USAGE` and **no** function `EXECUTE`; **no** role membership; **no**
`WITH GRANT OPTION`; **no** `USAGE` on `public`; **no** `TEMPORARY`; and **no**
`CREATE` on any schema or on the database.

`CONNECT` is not 019's to give — the database is not an owner-owned object — so it
comes from `010`, in the eight-role list above.

The absences are load-bearing, not stylistic. Withholding `public` is the cheapest
proof the route resolves no type or operator there: as this role,
`SELECT '[0.1,0.2]'::vector` fails with `SQLSTATE 42704`, because without schema
`USAGE` the name cannot be resolved at all and the failure precedes any privilege
check. Naming five tables rather than `ON ALL TABLES` is what keeps the grant from
widening when a sixth table is added to `trade` — verified on a disposable cluster,
where a newly created table in the granted schema was **not** readable.

### The dashboard connection boundary

`apps/unified-platform` is network-facing, so the constraint is not only which
database it reaches but which credential it can hold at all.

- The `trade-graph` route calls **`getDashboardPool()`**, never `getPool()`.
- `getDashboardPool()` reads **`DASHBOARD_DATABASE_URL`** and nothing else. It has
  **no fallback** — not `DATABASE_URL`, not `TEST_DATABASE_URL`, not `PGDATABASE`,
  `PGHOST`, `PGUSER` or `USER`.
- The value must be written `postgres://` or `postgresql://` and must state its
  **user**, **host** (a TCP host, or an explicit `?host=` socket directory) and
  **database** explicitly. An incomplete URL is refused *before* any pool or client
  is constructed, because `createPool()` would otherwise complete it from the
  ambient environment — which is a fallback by another name.
- A **password is not required** for the URL to be structurally valid;
  passwordless authentication and `.pgpass` remain operator choices, and the
  production authentication policy (`pg_hba.conf`, SCRAM) is a **separate
  provisioning gate**, not something this validation decides.

Why a second accessor exists at all: this app runs Prisma with
`provider = "sqlite"` and `url = env("DATABASE_URL")`, so inside the Next server
process `DATABASE_URL` is a `file:` URL. One variable cannot hold two mutually
exclusive values, and the route that used `getPool()` therefore behaved
differently depending on how the server had been started.

**Manual price refresh is disabled.** `POST /api/portfolio/refresh` still answers
`409` first when the market is closed — that is a different fact from "refresh is
not configured" and the precedence is part of the contract — and otherwise returns
**`503` with `code: REFRESH_UNAVAILABLE`**. It holds no PostgreSQL credential and
launches no subprocess. Delegated submission of the existing background refresh
job is slice **S4F-refresh**; until then the daily pipeline stage and the
scheduled intraday price job continue to refresh prices.

**The ordinary tenancy suite does not authenticate `ai_capital_dashboard`.** It
authenticates five named identities plus a cluster administrator; the dashboard,
pipeline and claim-writer credentials are exercised by dedicated runtime gates —
pipeline and claim-writer by the S3B rehearsal, dashboard by **S4B**.

### The claim-writer connection boundary

Claim persistence — `recordClaims`, `applyEvent`, `recordAgentRun`,
`ingestAgentOutput` — has the same shape of boundary as the dashboard, and for a
sharper reason: `ai_capital_claim_writer` holds production `INSERT`.

- **Outside Vitest it reads `CLAIM_WRITER_DATABASE_URL` and nothing else.** There
  is **no fallback** — not `DATABASE_URL`, not `TEST_DATABASE_URL`, not
  `PGDATABASE`, `PGHOST`, `PGPORT`, `PGUSER` or `USER`, and not an ordinary pool
  that already happens to be open. An earlier revision returned the general pool
  when this variable was unset or blank, which silently escalated a missing
  narrow credential to a broader one.
- **The value must be written `postgres://` or `postgresql://` and must state its
  user, host (or an explicit `?host=` socket directory) and database.** Missing,
  empty, whitespace-only, whitespace-surrounded, malformed, wrong-scheme and
  incomplete values are refused **before any pool or client is constructed**.
  That last case is not pedantry: an incomplete URL would otherwise be completed
  from the ambient environment, and a blank or malformed one was measured
  resolving to whatever `PGDATABASE` named.
- **Passwordless URLs and explicit Unix-socket URLs remain structurally valid.**
  Authentication policy is a separate provisioning gate.
- **A valid production credential is still not authorization.** A protected
  destination additionally requires a matching
  `withProductionWrite({ operation: 'claim-persistence', … })` scope. The check
  runs three times, and each catches something the others cannot: against the
  validated URL *before* a protected writer pool is constructed, against the
  cached pool on every retrieval, and again at **SQL-issue time** — because
  `writer()` resolves synchronously before the first `await`, so a scope can
  close between obtaining the pool and issuing the statement.
- **A cached writer is byte-bound to the credential that created it.** If the
  environment later names a different value — even a perfectly valid one — the
  call fails closed rather than writing through the old connection while the
  environment names a new one. Neither value appears in the error. Call
  `closeClaimWriter()` before changing the credential.
- **Close semantics.** A successful `closeClaimWriter()` clears both the pool and
  its credential binding; a **failed** one retains both, so cleanup stays
  retryable and the next call cannot rebuild against a different credential with
  the drift check never firing.
- **Under Vitest the writer is the isolated ordinary test pool**, which the
  harness has already pointed at a disposable database and which cannot reach a
  protected one.
- **`claimHistory` is deliberately outside this path.** It is a read, and it
  continues to use `getPool()`.

**This credential does not belong in the shared root `.env`.** It is a
single-purpose production write credential; scoping it to the one process that
needs it is the point of separating it from `DATABASE_URL` at all.

**It is not yet provisioned.** Until it is, non-Vitest claim persistence fails
closed — which is the intended state, not a defect.

### The pipeline connection boundary

The queue worker is the third consumer to get its own credential, and it is the
one that spawns other processes — so the boundary has two halves.

- **Two explicit credential sources, and exactly one may be set.**
  `PIPELINE_DATABASE_URL` carries the URL itself (tests, deliberate manual runs);
  `PIPELINE_CREDENTIAL_FILE` carries the **absolute path** of a file holding it,
  and is what the launchd plists use. Both set is a refusal, not a precedence
  rule; neither set is a refusal; there is no implicit default path and no
  `HOME`-derived location. `packages/queue/bin/worker.ts`,
  `bin/structured-worker.ts` and `bin/run-stage.ts` validate with the same
  canonical validator the dashboard and claim writer use
  (`@common/db/credential-url`), extended with an **exact-role constraint**: a
  credential naming any role other than `ai_capital_pipeline` is refused even
  when otherwise valid. A file-loaded value stays a local and is **never written
  into `process.env`**.
- **The credential file is data, never shell code.** One URL, one optional
  terminating LF as framing, no CR/NUL/second line, fatal UTF-8 decoding, no
  trimming, 4 KiB bound. It is opened `O_RDONLY|O_NOFOLLOW`, and its type, owner,
  owner-only mode and single hard link are checked on the **descriptor**; its
  containing directory must be a real, owner-owned, mode-0700 directory.
- **`ensurePipelineEnv()` holds no credential.** It runs in ten bins, five of
  which never reach PostgreSQL; only `requirePipelineCredential()` (three bins)
  reads a credential.
- **Validation happens before any resource module is even imported.** ESM
  evaluates every static import before the first statement, so the entry points
  import only inert code statically and pull `src/queue.js` and
  `src/processor.js` in with `await import(...)` *after* the credential is
  validated. A refused credential therefore produces no Worker, no QueueEvents
  and no Redis connection at all, rather than ones that fail on first use.
- **Stage children receive a DERIVED `DATABASE_URL`, never an inherited one.**
  `buildPipelineChildEnv()` copies the parent environment, applies the JobSpec's
  own `env` and the caller's additions, then **strips** every `PG*`
  (`^PG[A-Z0-9_]*$` — `PGCONNECT_TIMEOUT` is why the pattern allows digits and
  underscores), every `*_DATABASE_URL`, `MIGRATION_OWNER_ROLE` and
  `LIVE_DATABASE_NAMES` — and only then assigns `DATABASE_URL` from the
  validated credential. Sanitizing last is deliberate: it means it does not
  matter where a variable came from. Assigning the credential last is also
  deliberate: a JobSpec cannot redirect a stage's destination.
- **`PIPELINE_DATABASE_URL` itself is not passed down.** One credential name per
  process keeps "which credential am I holding" answerable.
- **The direct (non-queue) consumers use the same code.**
  `scripts/run-alerts.sh` and `scripts/refresh-prices.sh` carry no default and no
  policy; they `exec packages/queue/bin/run-stage.ts -- <fixed command>`, which
  validates and builds the child environment exactly as the worker does. The
  previous `${DATABASE_URL:-postgres://…}` default meant a missing credential
  silently ran the stage as the personal superuser role.
- **The schedulers hold no credential at all.** `daily-queue.sh`,
  `scripts/daily-scheduler.sh` and `scripts/pipeline-watchdog.sh` submit to Redis
  and read the SQLite run ledger; nothing on their path connects to PostgreSQL.
  `daily-queue.sh` additionally no longer starts a worker: the inline `nohup`
  fallback inherited the scheduler's environment, which was the only reason a
  scheduled job would have needed a production credential.
- **A registered launchd job is not a running one.** `launchctl list` exits 0 for
  a job that is merely loaded — crashed and waiting out `ThrottleInterval`, or
  never started — and prints no `PID` key at all.
  `scripts/lib/worker-liveness.sh` requires a live PID whose command line is the
  expected worker entry point, run by a plausible runtime, so a stale PID, a
  recycled PID and a `grep`/`tail` that merely mentions the path are all refused.
  With no live worker the scheduler exits 3 and enqueues nothing.
- **The root `.env` is no longer sourced wholesale.** `ensurePipelineEnv()` reads
  it, parses it in memory with dotenv's pure `parse`, and copies only
  `ANTHROPIC_API_KEY` and `SEC_FUND_API_KEY`. `process.loadEnvFile()` cannot be
  made selective — it installs the whole file into `process.env` before any code
  can look at it. A file that exists but cannot be read is a hard error, reported
  with its path and error code and never its contents.

**The launchd templates under `ops/launchd/` are source artifacts.** They contain
`@@PLACEHOLDER@@` values and no credential — the worker, structured-worker and
alerts templates carry `PIPELINE_CREDENTIAL_FILE` (a path); daily and watchdog
carry no database variable of any kind.

Three source tools now exist, all inside `@common/queue` so they are typechecked
and their tests are collected:

- **`bin/render-launchd-plist.ts`** — substitutes path, Redis endpoint and
  credential-file path only. It refuses a template carrying a credential-value
  placeholder, enforces an exact per-agent placeholder allowlist with expected
  occurrence counts, escapes XML, and then **parses its own output** with
  `plutil` and inspects the real `EnvironmentVariables` dictionary, so a
  mixed-case or XML-entity-encoded PostgreSQL URL cannot slip past a regex. Each
  agent maps to exactly one destination — there is no arbitrary `--out` — and a
  staging directory must not already exist.
- **`bin/install-pipeline-credential.ts`** — reads the secret only from a no-echo
  terminal or a pre-opened descriptor, validates it (including the exact role)
  **before** writing, and publishes at mode 0600. `--rotate` is required to
  replace an existing file and never silently becomes an initial installation.
  No backup is written: a stale secret copy is a liability, and recovery from a
  bad rotation is re-provisioning, not restoring a file.
- **`bin/inspect-launchd-plist.ts`** — parses an installed plist (so an XML
  comment cannot spoof a `Label` or a key), refuses a symlinked input, treats
  lint/parser failure as an error, reports an ACL check that fails as `unknown`
  rather than `absent`, and **exits non-zero** on a forbidden credential key, a
  PostgreSQL literal or an unresolved placeholder. It prints environment key
  names and never values; a credential-shaped `ProgramArgument` is suppressed
  and counted.

Both publishing tools share one primitive, `src/atomic-publish.ts`: validate the
directory → take a lock → re-inspect the destination → private same-directory
temporary → complete write → fsync → close → validate → publish → fsync the
directory. Initial publication uses `link(2)`, which fails with `EEXIST` rather
than destroying a competing writer's file; `rename(2)` is used only for an
explicit replacement, under the lock, after re-validation. A temporary is
unlinked only when this invocation created it, and a lock is never stolen.

**Nothing has been provisioned or installed.** Production cutover to
`ai_capital_pipeline` remains a separate, separately authorized action.

**Time Machine ordering.** `~/.config` is *not* excluded from Time Machine
automatically, and deleting a local file does not remove it from existing backup
history. If exclusion of the credential directory is approved, it must be applied
and verified **before** the credential file is first created; otherwise the
secret can enter a snapshot in the window between creation and exclusion. No
`tmutil` command has been run.

### The production runtime root (S4F, in transition)

Two directories are protected as production for the duration of the relocation,
and `packages/queue/src/destinations.ts` names both as frozen literals:

| Root | Status |
|---|---|
| `/Users/thanapold/ai-capital-runtime` | **proposed canonical runtime root.** It does **not exist yet**, and nothing points at it. |
| `/Users/thanapold/Desktop/Projects.nosync` | **legacy root — still protected and still authoritative** throughout the transition. |

`isInsideProductionRepo()` classifies a path as production when it equals or sits
under **either** root after canonicalization (`path.resolve` + `realpath`, so
symlinks and `..` collapse, and a sibling like `…/ai-capital-runtime-old` is not
swallowed by a prefix match). `PRODUCTION_REPO` is retained as the canonical
default and now resolves to the **runtime** root, so an unset `PIPELINE_RUNS_DB`
or `AI_CAPITAL_ROOT` resolves there — never to `cwd`, `HOME`, an environment
variable, or the checkout that happened to load the module.

**Why the roots are literals.** Deriving the root from the module's own location
would make every checkout declare itself production — including the disposable
`/private/tmp` worktrees the test suite runs from — so the guard would answer
`true` for a temp worktree and `false` for the real runtime root. There is no
input to point the boundary somewhere else, so no export and no stray `cd` can
move it. `AI_CAPITAL_ROOT` keeps its only meaning: being **outside** these roots
is one of three dimensions that must *all* hold before an environment counts as
isolated.

**Why the scripts changed.** Five shell files hard-coded the Desktop path. All
five now derive `ROOT` from `BASH_SOURCE[0]` — the executing file's own path,
which is the one thing that always describes the checkout it belongs to (`$0`
differs when a file is sourced, and cwd is whatever the caller left behind).

| File | Kind | What ROOT selects |
|---|---|---|
| `scripts/run-alerts.sh` | **production launcher** — the `alerts` launchd agent runs it every 30 min during market hours | the checkout whose `run-stage.ts` and app it executes |
| `scripts/refresh-prices.sh` | **production launcher** | the checkout it executes, and `DATA_ROOT`, which is now derived **from** that `ROOT` so the two can never disagree |
| `scripts/daily-catchup.sh` | **production launcher** | its run database, log and lock |
| `scripts/dep-graph-scan.sh` | **production launcher** | the app directory it runs `npm run scan` in |
| `scripts/test-scheduler-cases.sh` | **dry-run test harness — not production** | **which copy of the real scheduler and watchdog is under test** |

The harness is the one that is easy to dismiss and the most dangerous to leave
alone. It never submits a pipeline, never touches `data/pipeline-runs.db`, and
runs every case as `--dry-run` against a `mktemp` database and heartbeat — so it
cannot corrupt production state. But it invokes the **real**
`./scripts/daily-scheduler.sh` and `./scripts/pipeline-watchdog.sh` from inside
`cd "$ROOT"`. With the old literal, a copy of the harness living in the new
runtime checkout would have exercised the **legacy Desktop** scripts while
appearing to test the ones beside it — measured, that line still produced
`/Users/thanapold/Desktop/Projects.nosync/scripts/daily-scheduler.sh` when run
from a checkout outside `~/Desktop`. A false PASS for code that never ran is
worse than a failure, because nothing prompts anyone to look.

`daily-scheduler.sh`, `pipeline-watchdog.sh`, `daily-queue.sh` and
`scripts/lib/worker-liveness.sh` were already root-relative and are unchanged.
`packages/queue/tests/runtime-root-portability.test.ts` holds all five files to
the derivation behaviourally: each script's prologue — stopping before the first
line that would *do* anything — is copied into a temporary fake checkout and
executed there, and the answer must be that fake checkout. The harness probe
additionally runs from a decoy working directory that has its own `scripts/`
subdirectory, so a cwd-derived `ROOT` would look plausible and still be caught.
A return to the Desktop literal fails the suite either way.

**This slice performs no relocation and no cutover.** It creates no directory,
copies no data, installs no credential, renders no plist and touches no launchd
job. Removing protection for the legacy root is a **later, separately approved
retirement change** — not part of S4F.

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

### `--target`, and why it is not the credential

`--target` is **mandatory**, has **no default**, and is **closed** to the live
databases the collector recognises:

| `--target` | database asserted from inside the session |
|---|---|
| `ai_capital` | `ai_capital` |
| `ai_capital_v3` | `ai_capital_v3` |

Anything else is refused — including a different case, a near miss such as
`ai_capital_v3_test`, and a value with surrounding whitespace, which is refused
rather than trimmed so the value validated is the value recorded. Every one of
these refusals happens **before a client object exists**, so a mistyped target
cannot reach a server at all.

It is **independent of `VERIFY_INVENTORY_DATABASE_URL`**, and deliberately so.
The credential says where the driver was asked to connect; the target says which
database the operator meant; and `assertSessionIsSafe` compares the **server's**
answer with the target. Deriving the target from the credential would make that
comparison circular — it would prove only that the driver connected where it was
told, which was never in doubt, and it would pass against any database at all.
For the same reason the target is never read from the environment: an ambient
target is a fallback by another name.

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
   `ai_capital_migrator`, applying migrations 001–019.
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

## The ai-capital-v3 cluster (PostgreSQL 17, port 5433)

A second cluster now exists in this repository's operational surface: the V3
migration target, on **port 5433**, holding the database **`ai_capital_v3`**.
Its artifacts, topology, authentication contract and rollback boundary live in
[`ops/clusters/ai-capital-v3/README.md`](clusters/ai-capital-v3/README.md).

**Everything in the rest of this file addresses the 5432 cluster and the
`ai_capital` database unless it says otherwise.** Two clusters mean `TARGET_DB`
and the `psql` examples above are no longer self-evident about which one they
mean, so state the port explicitly whenever you adapt them.

Two rules from that document are load-bearing enough to repeat here:

- **`ops/bootstrap/090_post_migration_lockdown.sql` must not be applied during
  V3 provisioning.** Its line 41 revokes `ai_capital_owner` from
  `ai_capital_migrator` — precisely the membership `packages/db/src/legacy-copy.ts`
  needs for its `SET LOCAL ROLE` during the copy. It runs only after the copy
  has completed and been verified.
- **The V3 cluster is excluded from Time Machine and therefore has no backup.**
  It must not become the system of record until a backup and recovery design is
  separately approved.

The provisioning and verification scripts each take an explicit mode and have no
default:

```bash
ops/clusters/ai-capital-v3/provision.sh --inspect   # read-only preflight
ops/clusters/ai-capital-v3/provision.sh --apply     # re-runs --inspect, then provisions
ops/clusters/ai-capital-v3/verify.sh --stopped      # filesystem/control-file, no connection
ops/clusters/ai-capital-v3/verify.sh --running      # live, read-only
```

The artifacts are checked as text, with no PostgreSQL contact, by
`packages/db/tests/v3-cluster-artifacts.test.ts`.
