#!/bin/bash
#
# ai-capital-v3 — PostgreSQL 17 provisioning, port 5433.
#
# TWO MODES, NO DEFAULT.
#
#   --inspect   strictly read-only preflight. Creates nothing, modifies
#               nothing, starts nothing, connects to nothing.
#   --apply     the provisioning execution. Re-runs the full inspection first
#               and refuses unless every operational root is still absent and
#               5433 is still unused.
#
# A default mode would mean an invocation that named no mode could still
# provision. The operator says which act they intend, out loud, every time.
#
# WHAT THIS SCRIPT WILL NOT DO, EVER:
#   * touch port 5432, or the cluster, config, socket or service that owns it;
#   * read .env, or inherit a database destination from the environment;
#   * reach the network, or invoke pnpm / npm / npx / corepack;
#   * retry, repair, roll back or "fix" anything after a failure;
#   * apply ops/bootstrap/090_post_migration_lockdown.sql;
#   * run verify-privileges;
#   * write a credential anywhere under the evidence root;
#   * print, log, hash or fingerprint a credential value.
#
# FAIL CLOSED. Every check is an assertion. A failure stops the run where it
# stands and leaves the partial state for a human to inspect: an automatic
# rollback would destroy the evidence of what went wrong.

set -euo pipefail
umask 077
IFS=$'\n\t'

# ── Absolute paths. Nothing here resolves through PATH ──────────────────────
#
# The Homebrew shims in /opt/homebrew/bin are NOT used. `brew unlink
# postgresql@17 && brew link postgresql@16` silently repoints them, and a 16.x
# psql against this 17 cluster connects happily while a 16.x postmaster would
# abort on catalog version — one of those failures is loud and the other is not.
readonly PG_BIN='/opt/homebrew/opt/postgresql@17/bin'
readonly INITDB="${PG_BIN}/initdb"
readonly PG_CTL="${PG_BIN}/pg_ctl"
readonly PSQL="${PG_BIN}/psql"
readonly CREATEDB="${PG_BIN}/createdb"
readonly PG_CONTROLDATA="${PG_BIN}/pg_controldata"

readonly PGDATA_ROOT='/Users/thanapold/ai-capital-v3-pgdata'
readonly SOCKET_ROOT='/Users/thanapold/ai-capital-v3-run'
readonly SECRET_ROOT='/Users/thanapold/ai-capital-secrets/s4f-d4'
readonly EVIDENCE_ROOT='/Users/thanapold/ai-capital-evidence/s4f-d4-provision'

# SECRET_ROOT and EVIDENCE_ROOT are DISJOINT SUBTREES. Neither is inside the
# other and neither is reachable from the other by following a component: the
# evidence walk is rooted at EVIDENCE_ROOT, so "the digest never sees a
# credential" is a property of the path tree, not of a filter someone has to
# remember to write correctly.

readonly TARGET_DB='ai_capital_v3'
readonly TARGET_PORT='5433'
readonly OWNER_ROLE='ai_capital_owner'
readonly MIGRATOR_ROLE='ai_capital_migrator'
readonly PIPELINE_ROLE='ai_capital_pipeline'
readonly SUPERUSER='thanapold'
readonly CLUSTER_NAME='ai-capital-v3'

# Roles that must exist but must NOT receive a password in this phase. A role
# with no password and no trust rule has no access path at all, which is a
# stronger property than "its grants are bounded" — and it is the reason
# verify-privileges is deferred to cutover rather than being fed a manufactured
# agent credential here.
# AN ARRAY, NOT A SPACE-DELIMITED SCALAR. This script sets IFS=$'\n\t', so
# `for r in ${SCALAR}` would not split on spaces at all: the loop would run ONCE
# with the whole string as a single role name, every `grep -q "^${r}|t|f$"`
# would fail to match, and the run would die with a message naming a role that
# does not exist. An array carries its own element boundaries and is immune to
# IFS entirely.
readonly PASSWORDLESS_ROLES=(
  ai_capital_app
  ai_capital_importer
  ai_capital_agent
  ai_capital_claim_writer
  ai_capital_operator
  ai_capital_dashboard
)

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO="$(cd "${HERE}/../../.." && pwd -P)"
readonly CONF_SRC="${HERE}/postgresql.conf.d/ai-capital-v3.conf"
readonly HBA_SRC="${HERE}/pg_hba.conf"
# The reviewed verifier, addressed absolutely from this script's own directory
# so --apply cannot pick up a different copy from PATH or the caller's cwd.
readonly VERIFY_SH="${HERE}/verify.sh"
readonly ROLES_SQL="${REPO}/ops/roles/000_cluster_roles.sql"
readonly BOOTSTRAP_SQL="${REPO}/ops/bootstrap/010_database_bootstrap.sql"
readonly TSX="${REPO}/packages/db/node_modules/.bin/tsx"
readonly DB_INVENTORY="${REPO}/packages/db/bin/db-inventory.ts"
readonly VERIFY_ARCHITECTURE="${REPO}/packages/db/bin/verify-architecture.ts"

# The existing cluster, named ONLY so the isolation proof can assert it is
# untouched. No command in this script connects to it, and no psql invocation
# below names this port.
readonly FOREIGN_PGDATA='/opt/homebrew/var/postgresql@17'

die() { printf 'provision.sh: REFUSED: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ── The environment this script runs in ─────────────────────────────────────
#
# Refuse rather than sanitise. Unsetting an inherited DATABASE_URL would make
# the run succeed while hiding that the operator's shell is pointed somewhere;
# the next command they type by hand would still go there.
assert_sterile_environment() {
  local leaked=''
  local v
  for v in $(/usr/bin/env | /usr/bin/sed -n 's/^\(PG[A-Z0-9_]*\)=.*/\1/p'); do leaked="${leaked} ${v}"; done
  for v in DATABASE_URL TEST_DATABASE_URL TEST_RUNTIME_DATABASE_URL BOOTSTRAP_DATABASE_URL \
           DASHBOARD_DATABASE_URL CLAIM_WRITER_DATABASE_URL AGENT_DATABASE_URL \
           PIPELINE_DATABASE_URL VERIFY_INVENTORY_DATABASE_URL AI_CAPITAL_COPY_DATABASE_URL \
           LIVE_DATABASE_NAMES MIGRATION_OWNER_ROLE; do
    if [ -n "${!v-}" ]; then leaked="${leaked} ${v}"; fi
  done
  if [ -n "${leaked}" ]; then
    die "the environment carries database variables (${leaked# }). This script takes its
       destination from its own constants and never from the environment. Start a clean
       shell rather than letting it be overridden."
  fi
  note 'environment carries no PG* or *DATABASE_URL variable'
}

# ═══════════════════════════════════════════════════════════════════════════
#  INSPECT — strictly read-only. Every command below reads; none creates,
#  modifies, starts, stops or connects.
# ═══════════════════════════════════════════════════════════════════════════
run_inspect() {
  step 'INSPECT (read-only)'
  assert_sterile_environment

  note '-- PostgreSQL 17 binaries, by absolute path'
  local b
  for b in "${INITDB}" "${PG_CTL}" "${PSQL}" "${CREATEDB}" "${PG_CONTROLDATA}"; do
    [ -x "${b}" ] || die "missing or non-executable: ${b}"
    "${b}" --version | /usr/bin/grep -q ' 17\.' || die "${b} is not PostgreSQL 17"
  done
  note "all five binaries present and report major 17"

  note '-- required extensions, from the filesystem'
  local sharedir
  sharedir="$("${PG_BIN}/pg_config" --sharedir)"
  local e
  for e in vector btree_gist; do
    [ -f "${sharedir}/extension/${e}.control" ] || die "extension control missing: ${e}"
  done
  note 'vector and btree_gist control files present'

  note '-- reviewed artifacts'
  [ -f "${CONF_SRC}" ] || die "missing config template: ${CONF_SRC}"
  [ -f "${HBA_SRC}" ]  || die "missing HBA template: ${HBA_SRC}"
  [ -f "${ROLES_SQL}" ] || die "missing ${ROLES_SQL}"
  [ -f "${BOOTSTRAP_SQL}" ] || die "missing ${BOOTSTRAP_SQL}"
  [ -x "${TSX}" ] || die "missing package-local tsx: ${TSX}"
  [ -f "${DB_INVENTORY}" ] || die "missing ${DB_INVENTORY}"
  [ -f "${VERIFY_ARCHITECTURE}" ] || die "missing ${VERIFY_ARCHITECTURE}"
  # --apply runs the reviewed verifier in both modes and refuses to publish a
  # digest unless both pass, so its absence is a hard precondition, not a
  # degraded mode.
  [ -x "${VERIFY_SH}" ] || die "missing or non-executable verifier: ${VERIFY_SH}"
  note 'config, HBA, role SQL, bootstrap SQL, tsx, both probes and the verifier present'

  note '-- HBA contract: six active rules, zero trust, zero replication'
  local active
  active="$(/usr/bin/grep -cvE '^[[:space:]]*(#|$)' "${HBA_SRC}")"
  [ "${active}" = '6' ] || die "HBA has ${active} active rules, expected 6"
  ! /usr/bin/grep -qE '^[^#]*[[:space:]]trust([[:space:]]|$)' "${HBA_SRC}" || die 'HBA contains a trust rule'
  ! /usr/bin/grep -qE '^[^#]*[[:space:]]replication[[:space:]]' "${HBA_SRC}" || die 'HBA contains a replication rule'
  note 'six active rules, no trust, no replication'

  note '-- the four operational roots must be ABSENT'
  local p
  for p in "${PGDATA_ROOT}" "${SOCKET_ROOT}" "${SECRET_ROOT}" "${EVIDENCE_ROOT}"; do
    [ ! -e "${p}" ] || die "already exists, refusing to provision over it: ${p}"
    note "absent  ${p}"
  done

  note "-- port ${TARGET_PORT} must be unused"
  local listeners
  listeners="$(/usr/sbin/lsof -nP -iTCP:"${TARGET_PORT}" 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  [ "${listeners}" = '0' ] || die "port ${TARGET_PORT} already has ${listeners} lsof rows"
  [ ! -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}" ] || die "a ${TARGET_PORT} socket already exists"
  note "port ${TARGET_PORT}: 0 listeners, no socket"

  note '-- the existing cluster, OBSERVED ONLY (no connection is made)'
  [ -d "${FOREIGN_PGDATA}" ] || die "expected the existing cluster at ${FOREIGN_PGDATA}"
  note "foreign PGDATA present; this script never contacts it"

  step 'INSPECT COMPLETE — nothing was created, modified, started or connected'
}

# ═══════════════════════════════════════════════════════════════════════════
#  APPLY
# ═══════════════════════════════════════════════════════════════════════════
run_apply() {
  # 1. Validate every input first. --apply re-runs the WHOLE inspection: the
  #    roots must still be absent and 5433 still unused at the moment of
  #    mutation, not merely when the operator last looked.
  run_inspect

  step 'APPLY 2/25 — create the four roots, empty, at 0700'
  # Created BEFORE any tmutil call. Excluding a path that does not exist is a
  # no-op that reports success, which would leave the cluster backed up.
  /bin/mkdir -m 700 -p "${PGDATA_ROOT}" "${SOCKET_ROOT}" "${SECRET_ROOT}" "${EVIDENCE_ROOT}"

  step 'APPLY 3/25 — ownership, real directories, no symlinks'
  local p
  for p in "${PGDATA_ROOT}" "${SOCKET_ROOT}" "${SECRET_ROOT}" "${EVIDENCE_ROOT}"; do
    [ -d "${p}" ] || die "not a directory: ${p}"
    [ ! -L "${p}" ] || die "is a symlink, refusing: ${p}"
    [ "$(/usr/bin/stat -f '%N' "${p}")" = "$(cd "${p}" && pwd -P)" ] || die "not its own realpath: ${p}"
    [ "$(/usr/bin/stat -f '%Su' "${p}")" = "${SUPERUSER}" ] || die "wrong owner: ${p}"
    [ "$(/usr/bin/stat -f '%Lp' "${p}")" = '700' ] || die "mode is not 700: ${p}"
    note "ok 0700 ${SUPERUSER} real-dir  ${p}"
  done

  step 'APPLY 4/25 — Time Machine exclusions, now that the directories exist'
  # PGDATA, socket and secret roots are excluded. The EVIDENCE root is
  # deliberately NOT excluded: it holds text, and it is exactly what one would
  # want restored. Consequence, recorded in README.md: the cluster has no
  # backup, and cannot become the system of record until that is addressed.
  for p in "${PGDATA_ROOT}" "${SOCKET_ROOT}" "${SECRET_ROOT}"; do
    /usr/bin/tmutil addexclusion "${p}"
    /usr/bin/tmutil isexcluded "${p}" | /usr/bin/grep -q '\[Excluded\]' || die "exclusion did not take: ${p}"
    note "excluded  ${p}"
  done

  step 'APPLY 5/25 — initdb'
  # Locale stated explicitly rather than inherited: initdb reads LANG at run
  # time, and a shell that happened to export LC_ALL=C would produce a cluster
  # with different string ordering — index semantics that differ from the
  # source while every command still reports success.
  "${INITDB}" \
    --pgdata="${PGDATA_ROOT}" \
    --username="${SUPERUSER}" \
    --encoding=UTF8 \
    --locale=en_US.UTF-8 \
    --data-checksums \
    --auth-local=peer \
    --auth-host=scram-sha-256
  [ "$(/bin/cat "${PGDATA_ROOT}/PG_VERSION")" = '17' ] || die 'PG_VERSION is not 17'
  "${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" | /usr/bin/grep -q 'Data page checksum version: *1' \
    || die 'checksums are not enabled'

  step 'APPLY 6/25 — install the reviewed config and HBA atomically'
  # install(1) writes to a temporary file and renames, so a reader never sees a
  # half-written pg_hba.conf. The reviewed templates are the source; nothing is
  # generated or interpolated here.
  printf '\ninclude = %s\n' "'${PGDATA_ROOT}/ai-capital-v3.conf'" >> "${PGDATA_ROOT}/postgresql.conf"
  /usr/bin/install -m 600 "${CONF_SRC}" "${PGDATA_ROOT}/ai-capital-v3.conf"
  /usr/bin/install -m 600 "${HBA_SRC}" "${PGDATA_ROOT}/pg_hba.conf"
  /usr/bin/grep -cvE '^[[:space:]]*(#|$)' "${PGDATA_ROOT}/pg_hba.conf" | /usr/bin/grep -qx '6' \
    || die 'installed HBA does not have exactly 6 active rules'
  ! /usr/bin/grep -qE '^[^#]*[[:space:]]trust([[:space:]]|$)' "${PGDATA_ROOT}/pg_hba.conf" \
    || die 'installed HBA contains a trust rule'

  step 'APPLY 7/25 — start, manually, with absolute pg_ctl'
  # Manual pg_ctl, not launchd and not brew services. The cluster is under
  # construction: it must not survive a reboot unattended, and it must not be
  # resurrectable by a service manager after a rollback removes its PGDATA.
  # brew services is keyed on formula name and could only be made to work by
  # endangering the existing postgresql@17 service.
  "${PG_CTL}" -D "${PGDATA_ROOT}" -l "${PGDATA_ROOT}/log/pg_ctl.log" -w -t 60 start

  step 'APPLY 8/25 — isolation from the 5432 cluster, WITHOUT connecting to it'
  # Process and filesystem comparison only. Asserting "5432 is untouched" by
  # connecting to it would be the one thing this proof must not do.
  local foreign_pid
  foreign_pid="$(/usr/sbin/lsof -nP -iTCP:5432 -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u | /usr/bin/head -1)"
  [ -n "${foreign_pid}" ] || die 'the 5432 listener vanished during provisioning'
  /bin/ps -o command= -p "${foreign_pid}" | /usr/bin/grep -q -- "-D ${FOREIGN_PGDATA}" \
    || die 'the 5432 listener is no longer the expected cluster'
  [ -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}" ] || die 'the v3 socket was not created'
  [ "$(/usr/bin/stat -f '%Lp' "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}")" = '700' ] \
    || die 'the v3 socket is not mode 0700'
  /usr/sbin/lsof -nP -iTCP:"${TARGET_PORT}" -sTCP:LISTEN | /usr/bin/grep -q '127\.0\.0\.1' \
    || die "nothing is listening on 127.0.0.1:${TARGET_PORT}"
  ! /usr/sbin/lsof -nP -iTCP:"${TARGET_PORT}" -sTCP:LISTEN | /usr/bin/grep -q '\[::1\]' \
    || die 'the v3 cluster is listening on ::1; listen_addresses was not honoured'
  note "the existing listener is still pid ${foreign_pid} on its own PGDATA; v3 on 127.0.0.1:${TARGET_PORT} only"

  step 'APPLY 9/25 — cluster roles'
  "${PSQL}" --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
    -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" -d postgres -f "${ROLES_SQL}"

  step 'APPLY 10/25 — generate the two secrets, on-host CSPRNG'
  # base64url (A-Za-z0-9-_) and nothing else: every character is unreserved in
  # an RFC-3986 userinfo component, so the URL needs no percent-encoding and is
  # stable byte-for-byte. Plain base64 would emit '+' and '/', and a '/' in
  # userinfo truncates the authority.
  local migrator_secret pipeline_secret
  migrator_secret="$(/usr/bin/openssl rand -base64 32 | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '=\n')"
  pipeline_secret="$(/usr/bin/openssl rand -base64 32 | /usr/bin/tr '+/' '-_' | /usr/bin/tr -d '=\n')"
  # Assert the alphabet rather than hope for it. The secret VALUE is never
  # echoed; only the pass/fail of this pattern test is observable.
  [[ "${migrator_secret}" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'generated migrator secret is not 43 base64url characters'
  [[ "${pipeline_secret}" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'generated pipeline secret is not 43 base64url characters'

  step 'APPLY 11/25 — set the passwords, off the command line and out of the log'
  # The plaintext reaches psql on STDIN, never in argv (where `ps` would show
  # it) and never in shell history. log_statement is silenced for these two
  # statements so the server log does not record them either.
  PGOPTIONS='-c log_statement=none' "${PSQL}" --no-psqlrc -v ON_ERROR_STOP=1 \
    -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" -d postgres <<SQL
ALTER ROLE ${MIGRATOR_ROLE} PASSWORD '${migrator_secret}';
ALTER ROLE ${PIPELINE_ROLE} PASSWORD '${pipeline_secret}';
SQL

  step 'APPLY 12/25 — publish the two credential files atomically at 0600'
  # Written under the SECRET root, never the evidence root. Created at 0600 by
  # umask before a byte is written, then renamed into place.
  local mig_tmp pipe_tmp
  mig_tmp="${SECRET_ROOT}/.migrator.url.$$"
  pipe_tmp="${SECRET_ROOT}/.pipeline.url.$$"
  printf 'postgresql://%s:%s@/%s?host=%%2FUsers%%2Fthanapold%%2Fai-capital-v3-run&port=%s\n' \
    "${MIGRATOR_ROLE}" "${migrator_secret}" "${TARGET_DB}" "${TARGET_PORT}" > "${mig_tmp}"
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s\n' \
    "${PIPELINE_ROLE}" "${pipeline_secret}" "${TARGET_PORT}" "${TARGET_DB}" > "${pipe_tmp}"
  /bin/chmod 600 "${mig_tmp}" "${pipe_tmp}"
  /bin/mv -f "${mig_tmp}" "${SECRET_ROOT}/migrator.url"
  /bin/mv -f "${pipe_tmp}" "${SECRET_ROOT}/pipeline.url"
  unset migrator_secret pipeline_secret
  note 'two credential files published at 0600 under the secret root'

  step 'APPLY 13/25 — create the database'
  # Separate from step 14 because CREATE DATABASE cannot run inside the
  # --single-transaction that 010 requires.
  "${CREATEDB}" -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" \
    -O "${OWNER_ROLE}" -E UTF8 --locale=en_US.UTF-8 -T template0 "${TARGET_DB}"

  step 'APPLY 14/25 — database bootstrap'
  "${PSQL}" --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
    -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" -d "${TARGET_DB}" \
    -v dbname="${TARGET_DB}" -f "${BOOTSTRAP_SQL}"

  step 'APPLY 15/25 — migrations 001-019, as the migrator, over the socket'
  # THE PACKAGE CLI, IN A SUBSHELL ANCHORED TO THE PACKAGE DIRECTORY.
  #
  # The previous form was `tsx -e "import('@common/db')..."`. That resolves the
  # bare specifier `@common/db` relative to the PROCESS's working directory, so
  # it worked only when the operator happened to be standing inside the
  # workspace — the same class of defect as a relative `--output`. Run from
  # anywhere else it fails with ERR_MODULE_NOT_FOUND, and it is not obvious from
  # reading the line that it could.
  #
  # bin/migrate.ts is a real file addressed by an absolute path, and the `cd`
  # happens inside ( ) so the caller's directory is untouched either way.
  # `migrate.ts` refuses outright when DATABASE_URL is unset, which is a second
  # fail-closed layer under the credential read.
  #
  # tsx is the package-local binary; pnpm, npm, npx and corepack are never
  # invoked. The credential is read at the point of use and lives only in this
  # command's environment.
  (
    cd "${REPO}/packages/db"
    MIGRATION_OWNER_ROLE="${OWNER_ROLE}" \
    DATABASE_URL="$(/bin/cat "${SECRET_ROOT}/migrator.url")" \
      "${TSX}" bin/migrate.ts
  )

  step 'APPLY 16/25 — db-inventory: LIVE DATABASE EVIDENCE'
  # Runs AFTER the migrations, so CURRENT_V19 recognition has all nineteen rows
  # to recognise. --target is mandatory and closed; it is independent of the
  # credential, so the check compares the server's answer against something the
  # server did not supply.
  VERIFY_INVENTORY_DATABASE_URL="$(/bin/cat "${SECRET_ROOT}/migrator.url")" \
    "${TSX}" "${DB_INVENTORY}" \
      --mode inventory \
      --target "${TARGET_DB}" \
      --run-id "s4f-d4-provision-$(/bin/date -u +%Y%m%dT%H%M%SZ)" \
      --output "${EVIDENCE_ROOT}/inventory.json"

  step 'APPLY 17/25 — verify-architecture: SOURCE-TREE EVIDENCE, NOT DATABASE EVIDENCE'
  # This reads repository files and opens no connection. It is equally true
  # before the cluster exists, and must never be reported as evidence about the
  # cluster. Its output is filed under a name that says so.
  "${TSX}" "${VERIFY_ARCHITECTURE}" > "${EVIDENCE_ROOT}/source-tree-check.txt"

  # 18. verify-privileges is NOT run. It requires AGENT_DATABASE_URL and asserts
  #     database 'ai_capital'; ai_capital_agent is deliberately passwordless
  #     here. Manufacturing an agent password to satisfy it would widen exactly
  #     the boundary it exists to narrow. Deferred to cutover.

  step 'APPLY 19/25 — live postconditions and evidence'
  # The walk is rooted at EVIDENCE_ROOT and never at the secret root. No
  # credential value, and no hash of one, is produced: a hash is still a derived
  # secret artifact, and its presence in an evidence bundle invites comparison.
  {
    printf 'cluster_name: %s\n' "${CLUSTER_NAME}"
    printf 'pg_controldata (running):\n'
    "${PG_CONTROLDATA}" -D "${PGDATA_ROOT}"
  } > "${EVIDENCE_ROOT}/control-running.txt"

  # THE SERVER ENFORCES READ-ONLY, NOT THE AUTHOR'S INTENT.
  #
  # Everything from here to the end of this step is evidence collection. A
  # statement that read like a SELECT but was not would be a write performed by
  # the very step that exists to attest to the final state. Asking the server to
  # refuse writes is cheap and does not depend on anyone reading the SQL
  # correctly — including a future editor adding "just one more" query.
  #
  # `-U` is explicit: psql otherwise defaults to $USER, so the identity the
  # evidence was gathered under would depend on the invoking shell.
  local -a ro_psql=(
    "${PSQL}" --no-psqlrc -v ON_ERROR_STOP=1 -At
    -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" -d "${TARGET_DB}" -U "${SUPERUSER}"
  )
  local ro_env='-c default_transaction_read_only=on'

  # Prove the session actually GOT read-only rather than trusting that asking
  # for it worked — the same discipline db-inventory applies to its own BEGIN.
  [ "$(PGOPTIONS="${ro_env}" "${ro_psql[@]}" -c "SELECT current_setting('transaction_read_only')")" = 'on' ] \
    || die 'the verification session is not read-only; refusing to gather evidence through it'

  PGOPTIONS="${ro_env}" "${ro_psql[@]}" \
    -c "SELECT rolname, rolcanlogin, rolpassword IS NOT NULL AS has_password FROM pg_authid ORDER BY rolname" \
    > "${EVIDENCE_ROOT}/roles.txt"

  # Exactly two roles hold a password; the other six hold none, so they have no
  # access path at all.
  local with_password
  with_password="$(/usr/bin/grep -c '|t$' "${EVIDENCE_ROOT}/roles.txt" || true)"
  [ "${with_password}" = '2' ] || die "expected exactly 2 roles with a password, found ${with_password}"
  # NON-VACUITY: assert the array's own size before iterating it. A loop over an
  # empty or truncated array passes by checking nothing, which is precisely the
  # failure the scalar form produced.
  [ "${#PASSWORDLESS_ROLES[@]}" = '6' ] \
    || die "PASSWORDLESS_ROLES has ${#PASSWORDLESS_ROLES[@]} entries, expected 6"
  local r
  for r in "${PASSWORDLESS_ROLES[@]}"; do
    /usr/bin/grep -q "^${r}|t|f$" "${EVIDENCE_ROOT}/roles.txt" || die "${r} should be LOGIN without a password"
  done

  # The migrator must STILL hold ai_capital_owner. This is the positive proof
  # that 090 did not run: its line 41 revokes exactly this membership, and
  # legacy-copy.ts needs it for SET LOCAL ROLE during the Phase-H copy.
  PGOPTIONS="${ro_env}" "${ro_psql[@]}" \
    -c "SELECT pg_has_role('${MIGRATOR_ROLE}', '${OWNER_ROLE}', 'MEMBER')" \
    | /usr/bin/grep -qx 't' || die "${MIGRATOR_ROLE} no longer holds ${OWNER_ROLE}; the post-migration lockdown must not have run"
  note "${MIGRATOR_ROLE} still holds ${OWNER_ROLE} — the lockdown has not been applied"

  step 'APPLY 20/25 — the reviewed verifier, --running'
  # THE VERIFIER IS THE AUTHORITY, NOT A SECOND OPINION.
  #
  # Everything above this line proves that each step did what it set out to do.
  # That is not the same as proving the finished cluster is correct, and a
  # provisioning script that grades its own work with its own checks can only
  # ever confirm what its author already believed.
  #
  # verify.sh is the reviewed statement of what a correct cluster looks like.
  # Running it here means provisioning and verification cannot drift apart, and
  # that the standalone `verify.sh --running` an operator runs next month
  # asserts exactly what the provisioning run asserted. It is read-only,
  # server-enforced: it reads no credential and writes nothing.
  "${VERIFY_SH}" --running | /usr/bin/tee "${EVIDENCE_ROOT}/verify-running.txt"
  note 'the running cluster passed the reviewed verifier'

  # 21. ops/bootstrap/090_post_migration_lockdown.sql is NOT applied here, and
  #     must not be until the Phase-H legacy copy has completed and been
  #     verified. Its line 41 destroys the membership just asserted.

  step 'APPLY 22/25 — stop the cluster'
  # The cluster has no consumer. Leaving an unconsumed database listening is an
  # attack surface and an invitation to an accidental connection; a stopped
  # cluster makes "nothing points at this yet" observable.
  "${PG_CTL}" -D "${PGDATA_ROOT}" -m fast -w -t 60 stop

  step 'APPLY 23/25 — prove the shutdown was clean and PGDATA is intact'
  local after
  after="$(/usr/sbin/lsof -nP -iTCP:"${TARGET_PORT}" 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  [ "${after}" = '0' ] || die "port ${TARGET_PORT} still has ${after} lsof rows after stop"
  [ ! -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}" ] || die 'the socket survived the stop'
  [ ! -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}.lock" ] || die 'the socket lock survived the stop'
  # NON-VACUOUS. An absent listener is also what a CRASHED postmaster leaves
  # behind. Only the control file distinguishes a clean shutdown from a dirty
  # one, so the state is asserted positively rather than inferred from absence.
  "${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" | /usr/bin/grep -qE 'Database cluster state: +shut down' \
    || die 'pg_controldata does not report "shut down"; the stop was not clean'
  [ "$(/bin/cat "${PGDATA_ROOT}/PG_VERSION")" = '17' ] || die 'PGDATA no longer reports version 17'
  [ "$(/usr/bin/stat -f '%Lp' "${PGDATA_ROOT}")" = '700' ] || die 'PGDATA mode drifted'
  "${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" > "${EVIDENCE_ROOT}/control-stopped.txt"
  note 'listener absent, socket absent, control file says shut down, PGDATA intact'

  step 'APPLY 24/25 — the reviewed verifier, --stopped'
  # Run AFTER the clean-stop checks above and BEFORE the digest. The two are
  # not redundant: the checks above assert the transition (the listener went
  # away, the control file says shut down), while --stopped asserts the
  # resting state an operator will find weeks later — roots, modes, credential
  # containers, installed artifacts byte-identical to the reviewed sources.
  #
  # Because `set -e` is in force and this is not in a condition, a failing
  # verifier stops the run here, before the digest exists. An evidence bundle
  # is a claim that the cluster is in a known-good state; publishing its digest
  # after a failed verification would make that claim false.
  "${VERIFY_SH}" --stopped | /usr/bin/tee "${EVIDENCE_ROOT}/verify-stopped.txt"
  note 'the stopped cluster passed the reviewed verifier'

  step 'APPLY 25/25 — publish the evidence digest'
  # LAST, and only after a proven clean shutdown: a digest published while the
  # cluster still ran would attest to a state that no longer exists.
  #
  # The walk is rooted at EVIDENCE_ROOT. SECRET_ROOT is a disjoint subtree and
  # is unreachable from here, so no credential can enter the digest.
  ( cd "${EVIDENCE_ROOT}" && /usr/bin/find . -type f ! -name DIGEST -print0 \
      | /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/shasum -a 256 ) > "${EVIDENCE_ROOT}/DIGEST"
  /bin/chmod 600 "${EVIDENCE_ROOT}/DIGEST"
  note "digest written: ${EVIDENCE_ROOT}/DIGEST"

  step 'APPLY COMPLETE — cluster provisioned, migrated, inventoried and STOPPED'
  note 'NOT done, deliberately: 090 lockdown, legacy copy, agent credential,'
  note 'verify-privileges, ~/.config/ai-capital consumer credential, launchd.'
}

main() {
  case "${1-}" in
    --inspect) run_inspect ;;
    --apply)   run_apply ;;
    *)
      printf 'usage: provision.sh --inspect | --apply\n\n' >&2
      printf '  --inspect  read-only preflight; creates and changes nothing\n' >&2
      printf '  --apply    provision the cluster; re-runs --inspect first\n\n' >&2
      printf 'There is no default mode.\n' >&2
      exit 2
      ;;
  esac
}

main "$@"
