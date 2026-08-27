# Production-write boundary — DEFERRED findings (FROZEN 2026-08-27)

**Status: frozen by decision, not resolved.** Work stopped after Warden's round 4.
Do not mark any of these resolved without a fix and a re-test.

Why frozen: the claim-persistence feature is **not wired into production** — no
launchd job, no DAG stage, and no caller outside `packages/db/tests`. Its
remaining hardening does not outrank a daily investment pipeline that is
currently failing. Rounds 1–3 and the two round-4 bypasses (W4-1, W4-2) **are**
fixed and verified; only the five below remain open.

Severity columns record what Warden **demonstrated**, not what is theoretically
conceivable.

| # | Finding | Production mutation | Authorization bypass | Denial of service | Verification blind spot |
|---|---|---|---|---|---|
| **W4-3** | `Object.freeze(pool.options)` misses `pool.Client`, a writable own property on the pool that `pg-pool` actually constructs from (`new this.Client(this.options)`) | not demonstrated | **yes — swapping it redirects every checkout while the WeakMap record stands** | no | no |
| **W4-4** | Throwing inside the `'connect'` handler does not prevent the query | not demonstrated | no | **yes — measured: process termination with no `uncaughtException` handler (launchd worker restarts mid-DAG), or `pool.query()` never settles (hung 4003 ms) where a handler exists; repeat until `max` and the pool deadlocks** | **yes — the assertion runs after `connect()` succeeds, so it never prevents reaching the wrong database, and it is skipped entirely for reused idle clients** |
| **W4-5** | `resolveDestination` fails **open** when given a connection string *and* a config: pg discards `cfg.database`/`cfg.user` when a connectionString is present, the guard puts `cfg.database` first | **latent** — no caller passes both today; `createClientFromConfig` compensates with a separate `assertNotLiveDatabase` | **latent yes** — two matrix cases where pg reaches `ai_capital` and the guard reports "harmless" | no | yes |
| **W4-7** | Six construction spellings evade `constructsPostgres` (`createRequire`, module re-export, re-export + rename, bracket-on-default-import, factory-returns-ctor, comma-operator); plus a **false positive on a comment**, and `PATTERN_HOLDERS` skips allowlisted files **wholesale** | no | no | no | **yes — `architecture-checks.ts` and `isolation-coverage.test.ts` could each contain a live `new pg.Pool` and never be flagged** |
| **W4-8** | `packagesWithTests()` still keys on `scripts.test`, so a package with test **files** but no test **script** is absent from `NAMES` and its `vitest.config.ts` is never asserted to load the isolation setup | no | no | no | **yes — and CLAUDE.md documents `cd apps/<app> && npx vitest run <file>` as a normal workflow, which uses exactly that unasserted config** |

Two lower-severity items, same freeze:

- **W4-6** — the `$USER` tail of the resolution chain reads `process.env.USER` live, while `pg` snapshots `pg.defaults.user` at module load. Both observed divergences land **fail-closed**, so no exploit; but the claim "matches pg's actual order exactly" is false. Use `pg.defaults.user` as the last link.
- **W4-9** — `build`/`typecheck`/`test` all run under `--if-present` with no meta-test that a project *has* the script, so deleting one silently removes a project from the gate — the same shape as the R3-6 coverage hole. Also the root `package.json` scripts lack `--no-bail`, so `pnpm test` at the root still stops at the first failure.

## Correction owed to migration 010 (not yet made)

`migrations/010_correct_claim_history.sql` and the resulting `COMMENT ON SEQUENCE`
text say sequence state "is NOT evidence of anything" / "NOT TAMPER-EVIDENT".

That is right about the **past** and wrong about the **present**. `is_called=false`
means any `nextval` since the reset would have flipped it to `true`; both desk
sequences still read `1/false`, which is positive evidence of **zero insert
attempts since the reset, including rolled-back ones**. The current wording will
talk the next auditor out of the single cleanest detector those tables have.

Requires a migration 011 (010 is applied and checksum-locked). Frozen with the rest.

## Also open, disclosed, and accurate

**R3-9** — `runMigrations()` (`packages/db/src/migrate.ts`) executes arbitrary SQL
from `migrations/*.sql` through `getPool()` with no intent scope. The `'migration'`
operation class exists in the type and is enforced nowhere. Consistent with the
gate's documented scope, so not a bypass — but it is the largest remaining
ungated route to production.
