# Database roles and the environment contract

Phase 1 of least-privilege separation, 2026-08-26. **No secrets in this file** —
variable names and role purpose only. Values live in the gitignored `.env`.

## Why this exists

Before Phase 1 the cluster had **exactly one role**: `thanapold` — superuser,
CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION — owning both databases, all 9
schemas, all 28 tables. Application runtime, specialist agents, migrations and
the test suite were all the same superuser identity.

On 2026-08-25 a test run wrote fixture rows into the real portfolio. Application
guards were added, and were then bypassed three separate times (`%5F`
percent-encoding, `socket:` connection strings, `LIVE_DATABASE_NAMES`
replacement). The lesson:

> A safety property should not depend on every parser, environment variable and
> test config being perfect. Software guards make mistakes difficult; the
> database authority model makes those mistakes non-destructive.

## Roles

| Role | Purpose | Production access |
|---|---|---|
| `thanapold` | Application runtime, migrations, DB administration | full (superuser) |
| `ai_capital_agent` | Specialist agents (Atlas, Ledger, Sentinel, Cassandra, Warden, Glenn) | **read-only, enforced** |
| `ai_capital_test_runtime` | Ordinary test execution | **none — cannot CONNECT** |

Both new roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
NOREPLICATION NOINHERIT` with **zero role memberships**, so there is no
`SET ROLE` path into the owner.

`CONNECT` on `ai_capital` was revoked from `PUBLIC` — it was implicitly granted,
so any new role would otherwise have reached production for free.

## Environment contract

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | production application, pipeline, migrations | privileged; set in launchd plists, `scripts/*.sh`, root `.env` |
| `AGENT_DATABASE_URL` | specialist agents | read-only role |
| `TEST_RUNTIME_DATABASE_URL` | test execution | restricted role; **required** to run tests |

`TEST_DATABASE_URL` is derived automatically and handed to workers by
`packages/db/testing/global-setup.ts`. You do not normally set it.

## Running tests from a fresh clone

Requires Postgres reachable, `DATABASE_URL` (for bootstrap only), and
`TEST_RUNTIME_DATABASE_URL`. The bootstrap creates the test database if absent,
migrates it, verifies the schemas, then hands workers **only** the restricted
credential and deletes the privileged one from the environment.

Every failure path stops the run with an actionable message. **Nothing ever
falls back to the production credential.** Missing `TEST_RUNTIME_DATABASE_URL`
produces:

```
[test-db] TEST_RUNTIME_DATABASE_URL is not set. Ordinary tests must
authenticate as the restricted role (ai_capital_test_runtime), not as the
privileged bootstrap credential.
```

## Verifying the boundary

```
pnpm --filter @common/db verify-privileges
```

Connects with the agent credential and checks object-level grants across every
production table, sequence and schema — the layer `privilege-model.test.ts`
cannot see, since `has_table_privilege` resolves names in the current database
and the test suite deliberately has no production access. Run it after any
grant change. Read-only; exits non-zero on drift.

## What this does NOT cover

**Production application runtime still uses `thanapold`, a superuser.** Moving
the pipeline off it is Phase 2 and is deliberately separate: it touches 3
launchd plists, 4 shell scripts, `.env`, and `unified-platform/.env.local`, for
a DAG that runs at 07:00 on a real-money book where a missing grant means a
silently failed stage.

**`ai_capital_test_runtime` can still connect to `postgres` and `template1`,**
where PUBLIC's default CONNECT was never revoked. Verified inert by Warden: no
CREATE on `public`, no persistent objects, no temp tables in `template1`, and no
cross-database reach to production. Worth knowing it is not literally "zero
cluster access".

**Ownership is unchanged.** `thanapold` owns every object, and an owner bypasses
grants. The Phase 1 boundary therefore rests on the restricted roles having no
membership in it — which `packages/db/tests/privilege-model.test.ts` checks on
every run.
