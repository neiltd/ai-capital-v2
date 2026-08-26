# Database roles and the environment contract

**Phase 1: CLOSED — database authority boundary established and independently
adversarially verified (2026-08-26).**

Scope of that closure, precisely:

| | |
|---|---|
| Test-runtime privilege isolation | **closed** |
| Specialist read-only privilege isolation | **closed** |
| Production runtime least privilege | **open — Phase 2** |
| Production object ownership separation | **open — Phase 2 or later** |

This is not "database security is complete". It is one boundary, verified.

The property established: *even if every TypeScript isolation guard is bypassed,
ordinary tests and specialist agents do not possess database authority capable
of materially modifying production.* Warden attempted escalation independently —
direct and alternate CONNECT routes, cross-database `DROP`/`ALTER DATABASE`,
backend signalling, `SET ROLE`, `SET SESSION AUTHORIZATION`, self-`GRANT`,
direct `pg_authid`/`pg_database` writes, `dblink`/`postgres_fdw`,
`COPY ... TO PROGRAM`, and `SECURITY DEFINER` elevation — and found no path.

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
| `ai_capital_agent` | Specialist agents — see the full map below | **read-only, enforced** |
| `ai_capital_test_runtime` | Ordinary test execution | **none — cannot CONNECT** |

Both new roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
NOREPLICATION NOINHERIT` with **zero role memberships**, so there is no
`SET ROLE` path into the owner.

`CONNECT` on `ai_capital` was revoked from `PUBLIC` — it was implicitly granted,
so any new role would otherwise have reached production for free.

## Which agents hold a database credential

Audited across all 10 agent definitions, not assumed. No DB-capable agent
remains on the production superuser credential.

| Agent | Database access |
|---|---|
| `atlas` | read-only, `$AGENT_DATABASE_URL` |
| `ledger` | read-only, `$AGENT_DATABASE_URL` |
| `sentinel` | read-only, `$AGENT_DATABASE_URL` |
| `vizier` | read-only, `$AGENT_DATABASE_URL` |
| `warden` | read-only, `$AGENT_DATABASE_URL` |
| `glenn` | read-only, `$AGENT_DATABASE_URL` |
| `cassandra` | none — reasons from other agents' exported data |
| `compass` | none — reads repo state and git |
| `herald` | none — creator-studio only |
| `lumen` | none — dashboard UI only |

The only remaining `$DATABASE_URL` mentions in agent files are explicit
instructions *not* to use it.

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

## Layer above the roles: production-write intent

The roles answer *"is this credential permitted to write?"* They cannot answer
*"did anyone mean for this process to write?"* — and that second question is the
one the incidents actually turned on.

Every guard built on 2026-08-25/26 keyed on `process.env.VITEST`. Warden pointed
out the consequence: outside vitest, nothing was guarded. `.env` carries
`CLAIM_WRITER_DATABASE_URL`, so an ad-hoc `tsx` run that sourced it and reached a
persistence function wrote straight to the real book. Same shape as the ad-hoc
CLI hazard that lost the CRWD 4:1 split adjustment on 2026-07-05.

**The invariant:** possessing a production write credential is not itself
sufficient to perform a production write. Production mutation requires explicit
production intent.

```ts
await withProductionWrite(
  { operation: 'claim-persistence', context: 'pipeline',
    reason: 'daily DAG persisting specialist claims' },
  () => ingestAgentOutput(...),
)
```

**Why a call scope and not an environment variable.** This is the entire design.
An env var is the wrong instrument: it can be set once in `.env` and be
permanently, invisibly true; it is inherited by every child process for free;
and it grants authority by *ambient presence* — which is the exact property that
caused both incidents. A `withProductionWrite()` scope cannot be granted by a
file, cannot cross a process boundary, and exists only for the duration of a
call that names its operation and states a reason in the source. You do not
enter it by accident; you enter it by typing it.

An earlier draft added `ALLOW_TEST_PRODUCTION_INTENT` so unit tests could open a
scope. That was removed — it was the very thing the mechanism exists to prevent.
Authorization and isolation are independent layers: a test may declare intent
and still cannot reach production, because the connection factory refuses a
protected destination under vitest and `ai_capital_test_runtime` has no CONNECT.

**Scope is per operation class.** A `migration` scope does not authorize a
`claim-persistence` write. **It fails closed before any SQL is issued**, naming
the protected destination, the operation class, and the absence of
authorization — and it neither falls back to the test database nor silently
skips persistence, because both would leave the caller believing it had written.

### What this gate actually covers — stated honestly

Warden's review made a point worth recording verbatim rather than softening:

> "The gate is on `writer()`, not on the tables. `getPool` is exported from
> `@common/db`; any code doing `getPool().query('INSERT INTO desk.agent_claims …')`
> is entirely ungated. The invariant as written describes one function, not the
> database."

That is correct. The honest statement of scope is:

**Gated:** the claim-persistence functions — `recordClaims`, `applyEvent`,
`recordAgentRun`, `ingestAgentOutput` — all of which route through `writer()`.

**Not gated:** raw SQL through `getPool()`, every other table in the cluster,
and any future persistence function that forgets to call the gate. Those are
protected by the PostgreSQL roles alone.

The four-word version of the invariant is aspirational about the database and
accurate about one module. Do not cite it as though the cluster enforces it —
**the roles are what the cluster enforces.** This layer raises the cost of an
accident on the one path that has already caused an incident twice; it is not a
general mutation barrier, and treating it as one would be exactly the kind of
confidently-wrong belief this desk keeps having to dig out.

Only claim persistence is gated today. Nothing in production invokes it yet, so
no launchd or DAG configuration changed. Extending the gate to pipeline writes
would require the worker to declare intent, which IS a production launch
configuration change and needs its own decision.

## Verification binaries

| Command | Property |
|---|---|
| `pnpm --filter @common/db verify-privileges` | least-privilege roles hold |
| `pnpm --filter @common/db verify-architecture` | every Postgres constructor routes through `packages/db/src/pool.ts`; no test file is silently dead |
| `pnpm --filter @common/db verify-all` | both |

`verify-architecture` runs **outside vitest** deliberately. Enforcing a
non-test invariant only inside the test runner is circular: disable the suite
and the property protecting production disappears with it. Both checks share
one implementation with the vitest meta-test (`testing/architecture-checks.ts`)
so they cannot drift.

## Future observability: `track_commit_timestamp`

Currently **off**, and deliberately left off.

Reconstructing the 2026-08-26 timeline required mapping transaction ids to wall
time via migration anchors, relation file mtimes and OID ordering — several
hours of forensic argument. `track_commit_timestamp = on` would have made it a
single query against `pg_xact_commit_timestamp()`.

**Operational cost of enabling it:**

- Requires a **PostgreSQL restart**. This cluster serves the daily pipeline, the
  launchd worker, and the dashboard; a restart is a real interruption, not a
  reload.
- Adds a small per-transaction write overhead and additional `pg_commit_ts`
  storage that grows with transaction volume.
- Not retroactive — it records nothing about transactions already committed, so
  it would not have helped with any incident to date.

**Decision (2026-08-26): not enabled.** A production restart for forensic
convenience is not justified by the claim-governance work alone. Reconsider when
a restart is already scheduled for another reason, at which point the cost is
close to zero. If tamper-evidence on `desk.agent_claims` specifically is wanted
sooner, an append-only audit table is the cheaper answer, and unlike sequence
state it cannot be reset by a cleanup.

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
