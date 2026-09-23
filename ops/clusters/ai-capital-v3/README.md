# ai-capital-v3 — PostgreSQL 17 cluster on port 5433

The migration target for the V3 database. It is **not** the system of record,
and it must not become one until the open item at the bottom of this file is
resolved.

## Topology

| | |
|---|---|
| PGDATA | `/Users/thanapold/ai-capital-v3-pgdata` (0700) |
| Socket directory | `/Users/thanapold/ai-capital-v3-run` (0700) |
| Secrets | `/Users/thanapold/ai-capital-secrets/s4f-d4` (0700, files 0600) |
| Evidence | `/Users/thanapold/ai-capital-evidence/s4f-d4-provision` (0700) |
| Port | 5433, bound to the literal `127.0.0.1` only |
| Database | `ai_capital_v3` |
| Binaries | `/opt/homebrew/opt/postgresql@17/bin/*`, 17.10, by absolute path |
| Lifecycle | manual `pg_ctl`. No launchd job, no `brew services` |

**PGDATA lives outside `/opt/homebrew/var`.** That tree is Homebrew's:
`brew upgrade`, `brew cleanup` and `brew uninstall` all operate there and have
no idea a second, non-Homebrew cluster is squatting under a name that
pattern-matches their own. It also lives outside the Git clone, so
`git clean -xdf` cannot reach it.

**The socket directory is not `/tmp`.** The macOS temp reaper sweeps
`/private/tmp` — it destroyed a live worktree during S4F-D2.13 — and the 5432
cluster's socket there is mode 777. A dedicated 0700 directory under `$HOME` is
both reaper-proof and access-controlled.

**The database is named `ai_capital_v3`, not `ai_capital`.** Reusing the name
would make the cutover a one-token change, which is the argument for it. Against
it: the 5432 cluster answers `trust` to every local connection for every role
and every database, so a command that means 5433 but reaches 5432 — a stale
`PGPORT`, a sourced `.env`, a pasted URL — would connect to **production** and
operate on it silently. With a distinct name that same mistake fails
immediately with `database "ai_capital_v3" does not exist`. Converting a silent
wrong-target into a hard failure is worth a longer cutover diff.

## Authentication

Six rules, first-match-wins, in `pg_hba.conf`:

```
local   ai_capital_v3  ai_capital_migrator                 scram-sha-256
local   all            thanapold                           peer
local   all            all                                 reject
host    ai_capital_v3  ai_capital_pipeline  127.0.0.1/32   scram-sha-256
host    all            all                  0.0.0.0/0      reject
host    all            all                  ::/0           reject
```

- The **migrator** authenticates only through the private Unix socket, and only
  to `ai_capital_v3`. It has **no TCP path at all** — `legacy-copy.ts` refuses a
  TCP session outright, and the transport layer now agrees with it.
- The **pipeline** authenticates only over IPv4 loopback, and only to
  `ai_capital_v3`.
- Every other path, local or TCP, is **explicitly** rejected. Relying on
  PostgreSQL's implicit final reject would make "no other role can connect" a
  property nobody can grep for.
- **Zero `trust` rules. Zero `replication` rules.**
- **Adding a consumer later: insert above the catch-all rejects.** A rule
  appended at the end is dead. That direction of failure is deliberate, but it
  means a misplaced rule looks present and does nothing.

Only two roles are given a password: `ai_capital_migrator` and
`ai_capital_pipeline`. The other six LOGIN roles are created **passwordless**,
so reuse as the pipeline credential is not merely disallowed by policy but
impossible in the cluster's actual state.

Credentials live under the **secret** root, never the evidence root:

```
migrator.url   postgresql://ai_capital_migrator:<secret>@/ai_capital_v3?host=%2FUsers%2Fthanapold%2Fai-capital-v3-run&port=5433
pipeline.url   postgresql://ai_capital_pipeline:<secret>@127.0.0.1:5433/ai_capital_v3
```

The secret alphabet is base64url (`A-Za-z0-9-_`), 43 characters. Every
character is unreserved in an RFC-3986 userinfo component, so the URL needs no
percent-encoding and stays stable byte-for-byte. The evidence digest is rooted
at the evidence directory, which is a disjoint subtree, so no credential — and
no hash of one — can enter it.

## Usage

```bash
ops/clusters/ai-capital-v3/provision.sh --inspect   # read-only preflight
ops/clusters/ai-capital-v3/provision.sh --apply     # provision (re-runs --inspect first)

ops/clusters/ai-capital-v3/verify.sh --stopped      # no connection
ops/clusters/ai-capital-v3/verify.sh --running      # live, read-only
```

Neither script has a default mode. `verify.sh` never starts, stops, repairs,
migrates, grants, revokes or generates a credential.

**`provision.sh --apply` runs both verifier modes itself.** It invokes
`verify.sh --running` after the migrations and inventory and before stopping the
cluster, then `verify.sh --stopped` after the clean-stop checks and **before**
the evidence digest is published. Both outputs are captured under the evidence
root (`verify-running.txt`, `verify-stopped.txt`), and because the script runs
under `set -euo pipefail` a failure in either mode halts provisioning with no
digest written — an evidence bundle is a claim that the cluster is in a
known-good state, and publishing its digest after a failed verification would
make that claim false.

Running the verifier rather than re-implementing its checks is deliberate: a
provisioning script that grades its own work with its own checks can only
confirm what its author already believed, and the two would drift apart the
first time one of them was corrected. The standalone modes remain available and
are the right tool for a later read-only check — weeks after provisioning, or
before a cutover — with no re-provisioning implied.

`verify.sh --running` opens its sessions with
`PGOPTIONS='-c default_transaction_read_only=on'` and an explicit `-U thanapold`,
then proves `transaction_read_only = on` from **inside** the session before
reading anything through it. Read-only is therefore enforced by the server, not
by a reader correctly classifying every statement — and it keeps holding when
someone later adds one more query.

Both modes compare the **installed** `pg_hba.conf` and config fragment
byte-for-byte against the reviewed sources in this directory, and prove the
fragment is included exactly once and is the only `include*` directive.
Credential files are checked as containers only — regular file, owner, `0600`,
link count 1, and **not** a symlink — never by reading their contents.

`--running` goes further, because matching bytes on disk say nothing about what
the running postmaster actually loaded:

- `data_directory`, `config_file` and `hba_file` must be exactly this cluster's
  paths — a server started with a different `-D`, or whose PGDATA was swapped
  after start, passes every filesystem check while serving a configuration
  nobody reviewed;
- all eighteen canonical settings must hold their normalized runtime values
  (`datestyle = 'iso, mdy'` reads back as `ISO, MDY`, and the GUC is `TimeZone`);
- every one of those settings must have `pg_settings.sourcefile` equal to the
  installed fragment. `ALTER SYSTEM SET` writes `postgresql.auto.conf`, which is
  read **last** and silently wins: without this check a cluster could have the
  reviewed fragment installed, byte-identical, included exactly once, and still
  be running with `listen_addresses = '*'`;
- `pg_hba_file_rules` must show zero parse errors, exactly six rules, and the
  exact normalized sequence — type, database, user, address, netmask, method —
  because `pg_hba.conf` is first-match-wins and the same six rules in another
  order are a different policy. This is the check that catches a broadened
  `host all all 127.0.0.1/32 scram-sha-256`: it hands the migrator a TCP path
  without naming it anywhere, so it is caught by what it **means**, not by how
  it is spelled.

That view is readable because the session is the cluster superuser
(`initdb --username=thanapold`, authenticated by the `local all thanapold peer`
rule).

## The ordering rule that matters most

**`ops/bootstrap/090_post_migration_lockdown.sql` must NOT be applied during
provisioning.** Its line 41 —

```sql
REVOKE ai_capital_owner FROM ai_capital_migrator;
```

— destroys the membership granted at `010_database_bootstrap.sql:234`
(`WITH INHERIT FALSE, SET TRUE`), which is exactly what `legacy-copy.ts`
requires for its `SET LOCAL ROLE ai_capital_owner` during the Phase-H copy.
Applying 090 early would make the copy structurally impossible, and the failure
would surface as a permissions error long after provisioning reported success.

090 runs only **after** the legacy copy has completed and been verified.
`provision.sh` asserts the membership positively at the end of `--apply`, and
`verify.sh --running` re-checks it, so "090 has not run" is proved rather than
assumed.

## What provisioning deliberately does not do

- apply `090_post_migration_lockdown.sql`
- run `legacy-copy.ts` or any archive importer
- run `verify-privileges.ts` — it needs `AGENT_DATABASE_URL` and asserts
  database `ai_capital`, and `ai_capital_agent` is deliberately passwordless
  here. Manufacturing an agent password to satisfy it would widen the exact
  boundary it exists to narrow. Deferred to cutover.
- write `~/.config/ai-capital/pipeline-database.url`, render or install a
  plist, or touch launchd — that is the cutover, not the provisioning
- give the six remaining LOGIN roles a password
- connect to port 5432 in any way

`verify-architecture.ts` **is** run, and its output is filed as
`source-tree-check.txt`. It reads repository files and opens no connection: it
is evidence about the source tree and is equally true before this cluster
exists. It is never evidence about the cluster.

## Rollback

The cluster shares nothing with the existing system — distinct PGDATA outside
Homebrew's tree, distinct port, distinct socket directory, distinct database
name, distinct credentials, no launchd registration, no consumer pointing at
it. Rollback is therefore total, and identical at every point in the run:

1. `pg_ctl -D /Users/thanapold/ai-capital-v3-pgdata -m fast stop` (no-op if stopped)
2. remove the PGDATA, socket and secret roots — with `trash`, **not** `rm`, so
   the state survives for a post-mortem
3. shred the two credential files

Nothing in Git changes, no remote ref moves, the Desktop checkout is untouched,
`~/.config/ai-capital` stays empty, the four launchd agents keep running against
5432 exactly as before, and 5432 is never connected to.

## Open item — the cluster has no backup

PGDATA, the socket root and the secret root are excluded from Time Machine.
Backing up a live PGDATA yields a torn, unrestorable copy and burns snapshot
space on WAL churn, so the exclusion is correct — but it means the recovery
story for this cluster is **re-provisioning from these artifacts plus a re-run
of the copy from the 5432 source**, not a file restore.

That is acceptable for a migration target and unacceptable for a production
primary. **This cluster must not become the system of record until a real
backup and recovery design has been separately approved.**
