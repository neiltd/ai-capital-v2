# Incident evidence — unauthenticated production-write HTTP surface

Captured 2026-08-28 00:06:56 +07 (+0700) BEFORE containment. Read-only.
**No secret VALUES appear in this file — variable names only.**

## Process tree
```
51812     1 Fri Aug 21 07:58:52 2026     06-16:08:04 npm exec next dev -p 3000     
51892 51812 Fri Aug 21 07:58:52 2026     06-16:08:04 node /Users/thanapold/Desktop/Projects.nosync/apps/unified-platform/node_modules/.bin/../next/dist/bin/next dev -p 3000
51944 51892 Fri Aug 21 07:58:52 2026     06-16:08:04 next-server (v14.2.35) 
```

## Listeners
```
COMMAND     PID      USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      51944 thanapold   13u  IPv6  0x61d4b5325220d64      0t0  TCP *:3000 (LISTEN)
```

## Working directory of each process
```
pid 51812  cwd: /Users/thanapold/Desktop/Projects.nosync/apps/unified-platform
pid 51892  cwd: /Users/thanapold/Desktop/Projects.nosync/apps/unified-platform
pid 51944  cwd: /Users/thanapold/Desktop/Projects.nosync/apps/unified-platform
```

## Environment variable NAMES visible to the server process (values redacted)
```
/sbin/launchd
/System/Library/Frameworks/OpenGL.framework/Versions/A/Libraries/CVMServer
/usr/libexec/logd
/usr/libexec/UserEventAgent (System)
/System/Library/Frameworks/CoreServices.framework/Versio
-- names present in apps/unified-platform/.env.local --
ANTHROPIC_API_KEY
APP_ACCESS_KEY
DATA_ROOT
DATABASE_URL
OPENAI_API_KEY
-- names present in root .env --
AGENT_DATABASE_URL
ANTHROPIC_API_KEY
CLAIM_WRITER_DATABASE_URL
DATABASE_URL
SEC_FUND_API_KEY
TEST_RUNTIME_DATABASE_URL
```

## Git state of unified-platform
```
HEAD: 5c79e27  branch: main
worktree changes under apps/unified-platform:
last commit touching the app: 547c122 2026-08-27 fix(queue): contain the resurrection hazard; isolate test filesystem; record the Aug 27 incident
```

## Why it survived: PPID 1 — orphaned to init, no supervisor
```
51812 PPID=1  -> started detached; not launchd-managed, not a child of any shell
no launchd agent references it
no cron entry references it
```

## Decoy database — preserved as evidence, NOT deleted
```
canonical path : /Users/thanapold/Desktop/Projects.nosync/apps/capital-intelligence-ingestion/data/pipeline-runs.db
size           : 32768 bytes
modified       : Jul 17 15:57:26 2026
created        : Jun 11 10:27:27 2026
inode          : 54492937
sha256         : f6765a75315bc9d254326bd6b24eeadeef0fdcea11cedb57936f2bc28478a101
md5            : fe01d7f1681edbef2822ec69e241fd4e
sidecars       : 
git tracked    : no — untracked
gitignored     : yes
```

Read via the sqlite3 CLI in read-only URI mode — never through openDb(),
which would apply the schema and switch journal_mode.
```
journal_mode   : wal
rows           : 40
date range     : 2026-06-11 -> 2026-07-17
status         : running x4
status         : success x36
stuck running  : capital-ingestion-GoogleNews since 2026-06-11T03:35:56.827Z
stuck running  : capital-ingestion-GoogleNews since 2026-06-11T04:01:21.723Z
stuck running  : capital-ingestion-GoogleNews since 2026-07-02T05:22:23.364Z
stuck running  : capital-ingestion-GoogleNews since 2026-07-02T05:22:47.530Z
```

Preserved because it is evidence that the `resolveDbPath` cwd fallback
actually fired repeatedly on ad-hoc runs, not merely that it could.
Removal only after the fallback class is fixed.

## HTTP authority map — 26 route files, 33 server-rendered pages

Middleware matcher (`src/middleware.ts:4`) gates ONLY:
`/admin/:path*`  `/studio/:path*`  `/api/studio/:path*`  `/api/thesis-proposals`  `/api/theses/proposals/:path*`

### Unauthenticated routes

| Route | Method | DB | Spawn | Net | FS | Mutates? |
|---|---|---|---|---|---|---|
| `/api/portfolio/refresh` | POST | **production Postgres (hardcoded)** | **execFile** | Yahoo (child) | — | **YES** |
| `/api/status` | GET | **run DB read/WRITE** | — | — | — | **YES — schema + WAL** |
| `/api/ask` | POST | via `lib/data`, `lib/thesis-db` | — | **Anthropic** | — | metered spend |
| `/api/archive-qa` | POST | via `lib/data` | — | — | **appendFile** | **YES** |
| `/api/trade-graph` | GET | SQLite | — | — | — | opener-dependent |
| `/api/briefing` `/api/context` `/api/discovery` `/api/world` | GET | via `lib/data` | — | — | — | read |
| `/api/thesis` | GET | via `lib/thesis-db` | — | — | — | read |
| `/api/trade-graph/events` `/api/world-intel/causal-tree` | GET | — | — | — | — | read |

### Gated routes with mutation authority

| Route | Note |
|---|---|
| `/admin/pipeline` (page render) | `reapOrphans()` → `UPDATE … SET status='timeout'` on production |
| `POST /api/theses/proposals/[id]` | `resolveProposal()` → raw SQLite, bypasses `usePostgres()` |

**"GET" does not imply read-only.** `getRecentRuns` → `openDb` → `new Database(path)`
+ `journal_mode = WAL` + `db.exec(SCHEMA)`. An unauthenticated GET takes a write
lock on the production run database and can create it if absent.

### Bind
```
package.json  "dev": "next dev"      — no -H / --hostname flag
result        TCP *:3000 (LISTEN)    — all interfaces, IPv6 wildcard
intended      127.0.0.1 unless LAN exposure is explicitly required
```
Loopback is containment, not authorization: the unauthenticated mutation routes
need auth regardless of bind.

## thesis-memory split brain — read-only assessment, NOT reconciled
```
same 82 proposals in both stores (identical id-set sha256 d18ab0bb…)
  sqlite   : 82 rejected   resolved_at 2026-07-04T02:33:36.781Z -> .790Z  (9 ms — a BULK operation)
  postgres : 82 pending
theses 20/20, proposal_changes 320/320 — counts match; only status diverges
sqlite mtime 2026-07-04, sha faaa6bac…
```
Route reaching it: `POST /api/theses/proposals/[id]` → `resolveProposal()`
(`lib/thesis-db.ts:168`), which uses raw `new Database(...)` and never consults
`usePostgres()`. The DAG stage (`npm run update`) routes through `usePostgres()`
and therefore sees Postgres, where all 82 are still `pending`.

**Impact (Plausible, not Verified):** decisions recorded on 2026-07-04 exist only
in SQLite. Anything reading Postgres — including the pipeline — treats all 82 as
undecided. Whether that has caused re-surfacing downstream is not established here.
No reconciliation attempted. Replay appears possible because the id sets match
exactly, but that is not verified.

## Quarantined: `pnpm -F @common/queue smoke`

CLAUDE.md describes it as smoke-testing "without hitting real APIs". It is
production-mutating: writes a `queue-smoke` row to the production run DB, enqueues
onto the production `daily-pipeline` queue where the loaded worker picks it up and
spawns, and sets `removeOnComplete/removeOnFail: {count: 50}` — which would trim
the retained job sets currently preserved as incident evidence (228 parked / 41
failed). `submit.ts` deliberately refuses `{count:100}` as a resurrection hazard.
**Do not run pending redesign.**
