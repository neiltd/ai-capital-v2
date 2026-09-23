#!/bin/bash
#
# ai-capital-v3 — verification, port 5433. READ-ONLY, ALWAYS.
#
# TWO MODES, NO DEFAULT.
#
#   --running   live verification against a running cluster: configuration,
#               authentication posture, roles, migrations. Read-only SQL only,
#               enforced by the SERVER, not by the author's intent.
#   --stopped   filesystem, control-file, port and clean-shutdown verification,
#               making no connection at all.
#
# The two modes answer different questions and neither substitutes for the
# other, so neither is the default. --stopped is the state provision.sh leaves
# behind; --running is for the window in which the cluster has deliberately
# been started.
#
# THIS SCRIPT NEVER: starts, stops, restarts or signals a cluster; repairs
# anything; migrates; grants or revokes; creates or rotates a credential;
# writes to any database; touches the other cluster on this host; reads a
# credential value into its output. It reports and exits non-zero. Fixing is
# somebody else's authorized act.

set -euo pipefail
umask 077
IFS=$'\n\t'

readonly PG_BIN='/opt/homebrew/opt/postgresql@17/bin'
readonly PSQL="${PG_BIN}/psql"
readonly PG_CONTROLDATA="${PG_BIN}/pg_controldata"

readonly PGDATA_ROOT='/Users/thanapold/ai-capital-v3-pgdata'
readonly SOCKET_ROOT='/Users/thanapold/ai-capital-v3-run'
readonly SECRET_ROOT='/Users/thanapold/ai-capital-secrets/s4f-d4'
readonly TARGET_DB='ai_capital_v3'
readonly TARGET_PORT='5433'
readonly SUPERUSER='thanapold'
readonly MIGRATOR_ROLE='ai_capital_migrator'
readonly OWNER_ROLE='ai_capital_owner'

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly CONF_SRC="${HERE}/postgresql.conf.d/ai-capital-v3.conf"
readonly HBA_SRC="${HERE}/pg_hba.conf"
readonly CONF_INSTALLED="${PGDATA_ROOT}/ai-capital-v3.conf"
readonly HBA_INSTALLED="${PGDATA_ROOT}/pg_hba.conf"

FAILURES=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { FAILURES=$((FAILURES + 1)); printf '  FAIL  %s\n' "$*"; }
check(){ if [ "$1" = 'true' ]; then ok "$2"; else bad "$2${3:+ — $3}"; fi; }

# ── lsof, with its three states made explicit ───────────────────────────────
#
# `lsof` exits 1 when it matches nothing — its ordinary way of saying "no such
# listener", not an error. Under `set -o pipefail` a pipeline inherits that 1,
# so `listeners="$(lsof ... | wc -l)"` fails as an assignment and `set -e`
# kills the script before the zero comparison it was written to feed. The
# failure therefore fires in exactly the case --stopped exists to confirm.
#
# NOT `|| true`: that would flatten all three states into success and report a
# permission error or a missing binary as "nothing is listening".
#
#   exit 0                        matched; emit the rows
#   exit 1 with no output at all  matched nothing; emit nothing, succeed
#   anything else                 a real failure; diagnose and fail
#
# `-w` suppresses lsof's own warnings, so a warning line can never be counted
# as a matching row.
readonly LSOF='/usr/sbin/lsof'

lsof_query() {
  local out rc
  out="$("${LSOF}" -w "$@" 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    if [ -n "${out}" ]; then printf '%s\n' "${out}"; fi
    return 0
  fi
  if [ "${rc}" -eq 1 ] && [ -z "${out}" ]; then
    return 0
  fi
  printf 'lsof failed: exit %s%s\n' "${rc}" "${out:+ — ${out}}" >&2
  return 1
}

# Callers MUST handle a non-zero return: it means the state is UNKNOWN, which
# this script must never report as zero.
lsof_count() {
  local rows
  rows="$(lsof_query "$@")" || return 1
  if [ -z "${rows}" ]; then
    printf '0\n'
  else
    printf '%s\n' "${rows}" | /usr/bin/wc -l | /usr/bin/tr -d ' '
  fi
}

# ── The read-only session ───────────────────────────────────────────────────
#
# A FUNCTION WITH SEPARATE ARGUMENTS, NOT A COMMAND STRING.
#
# The previous version built `local q="${PSQL} --no-psqlrc ... -d ${TARGET_DB}"`
# and then ran `${q} -c '...'`. Under this script's own `IFS=$'\n\t'` that
# string does not word-split on spaces at all: the shell looks for a single
# executable literally named "psql --no-psqlrc ..." and every query fails with
# "command not found". Even with a default IFS it would be wrong the moment a
# path contained a space. An array expanded as "${arr[@]}" carries its own
# argument boundaries and is immune to IFS entirely.
#
# PGOPTIONS asks the SERVER to refuse writes. That matters more than it looks:
# it does not depend on a reader correctly classifying every statement below as
# a SELECT, and it keeps holding when someone later adds one more query.
readonly RO_PGOPTIONS='-c default_transaction_read_only=on'

psql_ro() {
  PGOPTIONS="${RO_PGOPTIONS}" "${PSQL}" \
    --no-psqlrc -v ON_ERROR_STOP=1 -At \
    -h "${SOCKET_ROOT}" -p "${TARGET_PORT}" -d "${TARGET_DB}" -U "${SUPERUSER}" \
    "$@"
}


# ── Shared: the artifacts on disk, no connection required ───────────────────
verify_filesystem() {
  printf '\n== roots: real, owned, private\n'

  local p
  for p in "${PGDATA_ROOT}" "${SOCKET_ROOT}" "${SECRET_ROOT}"; do
    if [ ! -e "${p}" ]; then
      bad "missing  ${p}"
    elif [ -L "${p}" ]; then
      # -L before -d: `[ -d link_to_dir ]` follows the link and reports true,
      # so a symlinked root would otherwise pass every check while pointing
      # somewhere nobody reviewed.
      bad "is a SYMLINK, not a real directory  ${p}"
    elif [ ! -d "${p}" ]; then
      bad "exists but is not a directory  ${p}"
    elif [ "$(/usr/bin/stat -f '%Su' "${p}")" != "${SUPERUSER}" ]; then
      bad "wrong owner ($(/usr/bin/stat -f '%Su' "${p}"))  ${p}"
    elif [ "$(/usr/bin/stat -f '%Lp' "${p}")" != '700' ]; then
      bad "mode is $(/usr/bin/stat -f '%Lp' "${p}"), expected 700  ${p}"
    else
      ok "0700 ${SUPERUSER} real directory  ${p}"
    fi
  done

  printf '\n== credential files: regular, owned, 0600, unshared\n'
  # The CONTENT is never read. These checks prove the container, never the
  # secret: nothing here cats, hashes or prints the file.
  local f path
  for f in migrator.url pipeline.url; do
    path="${SECRET_ROOT}/${f}"
    if [ ! -e "${path}" ]; then
      bad "missing  ${path}"
    elif [ -L "${path}" ]; then
      # A symlinked credential is a redirect: the bytes psql reads are not the
      # bytes anyone reviewed, and the link target's own mode is what governs.
      bad "is a SYMLINK  ${path}"
    elif [ ! -f "${path}" ]; then
      bad "is not a regular file  ${path}"
    elif [ "$(/usr/bin/stat -f '%Su' "${path}")" != "${SUPERUSER}" ]; then
      bad "wrong owner ($(/usr/bin/stat -f '%Su' "${path}"))  ${path}"
    elif [ "$(/usr/bin/stat -f '%Lp' "${path}")" != '600' ]; then
      bad "mode is $(/usr/bin/stat -f '%Lp' "${path}"), expected 600  ${path}"
    elif [ "$(/usr/bin/stat -f '%l' "${path}")" != '1' ]; then
      # A hard link count above 1 means the same inode is reachable under
      # another name, where the 0700 parent no longer protects it.
      bad "link count is $(/usr/bin/stat -f '%l' "${path}"), expected 1  ${path}"
    else
      ok "0600 ${SUPERUSER} regular file, 1 link (content not read)  ${path}"
    fi
  done

  printf '\n== installed artifacts match the reviewed canonical sources\n'
  # BYTE-FOR-BYTE, NOT PROPERTY-BY-PROPERTY.
  #
  # A name-based check ("is there a migrator host rule?") passes a broad
  # `host all all 127.0.0.1/32 scram-sha-256`, which grants the migrator TCP
  # without containing the string "ai_capital_migrator" anywhere. Comparing the
  # installed file with the reviewed one admits exactly one policy — the
  # reviewed one — and needs no list of the ways it could be wrong.
  local pair src dst label
  for pair in "${HBA_SRC}|${HBA_INSTALLED}|pg_hba.conf" "${CONF_SRC}|${CONF_INSTALLED}|ai-capital-v3.conf"; do
    src="${pair%%|*}"; dst="${pair#*|}"; label="${dst#*|}"; dst="${dst%%|*}"
    if [ ! -f "${src}" ]; then
      bad "canonical source missing, comparison is UNPROVEN  ${src}"
    elif [ ! -f "${dst}" ]; then
      bad "installed file missing  ${dst}"
    elif /usr/bin/cmp -s "${src}" "${dst}"; then
      ok "installed ${label} is byte-identical to the reviewed source"
    else
      bad "installed ${label} DIFFERS from ${src}"
    fi
  done

  printf '\n== postgresql.conf includes the fragment exactly once\n'
  local main="${PGDATA_ROOT}/postgresql.conf"
  if [ ! -f "${main}" ]; then
    bad "missing  ${main} — the include could not be checked"
  else
    local includes
    includes="$(/usr/bin/grep -cE "^[[:space:]]*include[[:space:]]*=[[:space:]]*'${CONF_INSTALLED}'" "${main}" || true)"
    check "$([ "${includes}" = '1' ] && echo true || echo false)" \
          'the fragment is included exactly once' "found ${includes}"
    # A second include of the same file, or an `include_if_exists` alongside it,
    # would make the LAST occurrence authoritative and the reviewed one a
    # decoy — legal, silent, and invisible to a diff of the fragment itself.
    local any
    any="$(/usr/bin/grep -cE "^[[:space:]]*include(_if_exists|_dir)?[[:space:]]*=" "${main}" || true)"
    check "$([ "${any}" = '1' ] && echo true || echo false)" \
          'no other include/include_dir/include_if_exists directive' "found ${any}"
  fi
}

# ── --stopped ───────────────────────────────────────────────────────────────
verify_stopped() {
  verify_filesystem

  printf '\n== the cluster is stopped, cleanly\n'
  local listeners
  if listeners="$(lsof_count -nP -iTCP:"${TARGET_PORT}")"; then
    check "$([ "${listeners}" = '0' ] && echo true || echo false)" "no listener on ${TARGET_PORT}" "lsof rows ${listeners}"
  else
    # UNKNOWN IS NOT ZERO. A failed query must not be reported as an absent
    # listener; that is the whole property this mode exists to establish.
    bad "lsof could not be queried — the ${TARGET_PORT} listener state is UNKNOWN, not proven absent"
  fi
  check "$([ ! -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}" ] && echo true || echo false)" 'no socket file'
  check "$([ ! -e "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}.lock" ] && echo true || echo false)" 'no socket lock'

  # THE NON-VACUOUS HALF. An absent listener is also what a crashed postmaster
  # leaves behind; only the control file separates a clean shutdown from a
  # dirty one. Assert the state positively, and fail if the file cannot be read
  # at all rather than reporting "no problems found".
  if "${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" > /dev/null 2>&1; then
    local state
    state="$("${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" | /usr/bin/sed -n 's/^Database cluster state: *//p')"
    check "$([ "${state}" = 'shut down' ] && echo true || echo false)" 'control file says "shut down"' "says \"${state}\""
    check "$("${PG_CONTROLDATA}" -D "${PGDATA_ROOT}" | /usr/bin/grep -q 'Data page checksum version: *1' && echo true || echo false)" \
          'data checksums are enabled'
  else
    bad 'pg_controldata could not read PGDATA — clean shutdown is UNPROVEN, not proven'
  fi
  check "$([ "$(/bin/cat "${PGDATA_ROOT}/PG_VERSION" 2>/dev/null)" = '17' ] && echo true || echo false)" 'PGDATA is intact at version 17'
}

# ── --running ───────────────────────────────────────────────────────────────
verify_running() {
  verify_filesystem

  printf '\n== the cluster is running, on the expected endpoint only\n'
  # ONE QUERY, TWO PROPERTIES. Two separate lsof runs could observe two
  # different instants, and the old IPv6 form reported "not listening on ::1"
  # whenever lsof itself failed: grep finds nothing in an empty stream, and the
  # negation turns that miss into a pass. An error must never read as a
  # satisfied security property.
  local listen_rows
  if listen_rows="$(lsof_query -nP -iTCP:"${TARGET_PORT}" -sTCP:LISTEN)"; then
    check "$(printf '%s\n' "${listen_rows}" | /usr/bin/grep -q '127\.0\.0\.1' && echo true || echo false)" \
          "listening on 127.0.0.1:${TARGET_PORT}"
    check "$(printf '%s\n' "${listen_rows}" | /usr/bin/grep -q '\[::1\]' && echo false || echo true)" \
          'NOT listening on ::1'
  else
    bad 'lsof could not be queried — IPv4 presence and IPv6 absence are UNKNOWN, not proven'
  fi
  check "$([ -S "${SOCKET_ROOT}/.s.PGSQL.${TARGET_PORT}" ] && echo true || echo false)" 'the Unix socket exists'

  printf '\n== the verification session is read-only, as the SERVER reports it\n'
  # Proved from inside the session before anything is read through it. If this
  # fails, every check below would be running with write capability it must not
  # have, so the run stops here rather than continuing with a caveat.
  local ro
  ro="$(psql_ro -c "SELECT current_setting('transaction_read_only')" 2>/dev/null || echo '<unreadable>')"
  if [ "${ro}" != 'on' ]; then
    bad "transaction_read_only is \"${ro}\", expected \"on\" — refusing to read further"
    return
  fi
  ok 'transaction_read_only = on'
  check "$([ "$(psql_ro -c 'SELECT session_user')" = "${SUPERUSER}" ] && echo true || echo false)" \
        "session_user is ${SUPERUSER}"

  printf '\n== the server loaded THESE files, not some other copy\n'
  # BYTE-COMPARING THE FILES ON DISK IS NOT ENOUGH.
  #
  # `cmp` proves the reviewed bytes are at the reviewed paths. It says nothing
  # about which files the running postmaster actually read: a cluster started
  # with a different -D, or whose PGDATA was replaced after start, would sail
  # through every filesystem check while serving a configuration nobody
  # reviewed. These three settings are the server's own answer to "where did I
  # come from", so they close the gap between the artifacts and the process.
  local trio name want got
  for trio in "data_directory|${PGDATA_ROOT}" \
              "config_file|${PGDATA_ROOT}/postgresql.conf" \
              "hba_file|${HBA_INSTALLED}"; do
    name="${trio%%|*}"; want="${trio#*|}"
    got="$(psql_ro -c "SELECT current_setting('${name}')" 2>/dev/null || echo '<unreadable>')"
    check "$([ "${got}" = "${want}" ] && echo true || echo false)" "${name} = ${want}" "got ${got}"
  done

  printf '\n== every canonical setting, at its normalized runtime value\n'
  # The values are the NORMALIZED forms the server reports, which are not always
  # the spelling in the file: `datestyle = 'iso, mdy'` reads back as `ISO, MDY`,
  # and the timezone GUC is named `TimeZone`. Comparing against the file's own
  # text would therefore fail on correct configuration, so the expectation is
  # written the way the server states it.
  local pair setting
  for pair in "port|${TARGET_PORT}" \
              "listen_addresses|127.0.0.1" \
              "unix_socket_directories|${SOCKET_ROOT}" \
              "unix_socket_permissions|0700" \
              "password_encryption|scram-sha-256" \
              "cluster_name|ai-capital-v3" \
              "logging_collector|on" \
              "log_directory|log" \
              "log_connections|on" \
              "log_disconnections|on" \
              "DateStyle|ISO, MDY" \
              "TimeZone|America/Los_Angeles" \
              "lc_messages|en_US.UTF-8" \
              "lc_monetary|en_US.UTF-8" \
              "lc_numeric|en_US.UTF-8" \
              "lc_time|en_US.UTF-8" \
              "default_text_search_config|pg_catalog.english"; do
    name="${pair%%|*}"; want="${pair#*|}"
    setting="$(psql_ro -c "SELECT current_setting('${name}')" 2>/dev/null || echo '<unreadable>')"
    check "$([ "${setting}" = "${want}" ] && echo true || echo false)" "${name} = ${want}" "got ${setting}"
  done
  # log_line_prefix ends in a significant trailing space, which -At would keep
  # but a shell $( ) strips. Compare it inside the server instead of out here.
  check "$([ "$(psql_ro -c "SELECT current_setting('log_line_prefix') = '%m [%p] %q%u@%d '")" = 't' ] && echo true || echo false)" \
        'log_line_prefix is exactly the reviewed value (trailing space included)'

  printf '\n== each of those settings came from the reviewed fragment, and nothing overrode it\n'
  # THE OVERRIDE HOLE THIS CLOSES. `ALTER SYSTEM SET` writes
  # postgresql.auto.conf, which is read LAST and silently wins. A cluster could
  # therefore have the reviewed fragment installed, byte-identical, included
  # exactly once — and still be running with `listen_addresses = '*'` because a
  # later source overrode it. current_setting() alone cannot tell the
  # difference; pg_settings.sourcefile names the file that actually supplied
  # the live value.
  local from_fragment
  from_fragment="$(psql_ro -c "
    SELECT count(*) FROM pg_settings
     WHERE lower(name) IN (
       'port','listen_addresses','unix_socket_directories','unix_socket_permissions',
       'password_encryption','cluster_name','logging_collector','log_directory',
       'log_line_prefix','log_connections','log_disconnections','datestyle','timezone',
       'lc_messages','lc_monetary','lc_numeric','lc_time','default_text_search_config')
       AND sourcefile IS NOT DISTINCT FROM '${CONF_INSTALLED}'" 2>/dev/null || echo 'unreadable')"
  # NON-VACUITY: the fragment declares eighteen settings. A count that is merely
  # "not wrong" — zero rows, an unreadable catalog — must fail, not pass.
  check "$([ "${from_fragment}" = '18' ] && echo true || echo false)" \
        'all eighteen canonical settings are sourced from the reviewed fragment' \
        "found ${from_fragment}"

  local overridden
  overridden="$(psql_ro -c "
    SELECT coalesce(string_agg(name || '<-' || coalesce(sourcefile, source), ', '), '')
      FROM pg_settings
     WHERE lower(name) IN (
       'port','listen_addresses','unix_socket_directories','unix_socket_permissions',
       'password_encryption','cluster_name','logging_collector','log_directory',
       'log_line_prefix','log_connections','log_disconnections','datestyle','timezone',
       'lc_messages','lc_monetary','lc_numeric','lc_time','default_text_search_config')
       AND sourcefile IS DISTINCT FROM '${CONF_INSTALLED}'" 2>/dev/null || echo 'unreadable')"
  check "$([ "${overridden}" = '' ] && echo true || echo false)" \
        'no canonical setting was supplied by a later source' "${overridden}"

  printf '\n== the HBA the server PARSED, rule by rule\n'
  # pg_hba_file_rules is readable here because this session is the superuser —
  # `initdb --username=thanapold`, authenticated by the `local all thanapold
  # peer` rule. (An earlier note of mine claimed this view was out of reach;
  # that was wrong, and it left the parsed ruleset unverified.)
  #
  # This is the strongest available check on authentication policy. cmp proves
  # the bytes; this proves what the server made of them — including the case
  # where a rule is syntactically valid, parses cleanly, and means something
  # broader than intended.
  local hba_errors
  hba_errors="$(psql_ro -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL" 2>/dev/null || echo 'unreadable')"
  check "$([ "${hba_errors}" = '0' ] && echo true || echo false)" \
        'no line of pg_hba.conf failed to parse' "rows with an error: ${hba_errors}"

  local hba_count
  hba_count="$(psql_ro -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL" 2>/dev/null || echo 'unreadable')"
  check "$([ "${hba_count}" = '6' ] && echo true || echo false)" \
        'exactly six rules parsed' "found ${hba_count}"

  # ORDER AND SEMANTICS, AS ONE STRING. pg_hba is first-match-wins, so the
  # sequence is part of the policy: the same six rules in another order are a
  # different policy. Each rule is rendered from the PARSED columns — type,
  # database, user, address, netmask, method — never from the file text, so a
  # broadened rule is caught by what it MEANS rather than by how it is spelled.
  # `host all all 127.0.0.1/32 scram-sha-256` never contains the string
  # "ai_capital_migrator" and is caught here regardless.
  local expected_rules='local|ai_capital_v3|ai_capital_migrator|||scram-sha-256
local|all|thanapold|||peer
local|all|all|||reject
host|ai_capital_v3|ai_capital_pipeline|127.0.0.1|255.255.255.255|scram-sha-256
host|all|all|0.0.0.0|0.0.0.0|reject
host|all|all|::|::|reject'
  local actual_rules
  actual_rules="$(psql_ro -c "
    SELECT type
        || '|' || array_to_string(database, ',')
        || '|' || array_to_string(user_name, ',')
        || '|' || coalesce(address, '')
        || '|' || coalesce(netmask, '')
        || '|' || auth_method
      FROM pg_hba_file_rules
     WHERE error IS NULL
     ORDER BY rule_number" 2>/dev/null || echo '<unreadable>')"
  if [ "${actual_rules}" = "${expected_rules}" ]; then
    ok 'the parsed rules match the canonical policy exactly, in order'
  else
    bad 'the PARSED HBA differs from the canonical policy'
    printf '        expected:\n%s\n        actual:\n%s\n' \
      "$(printf '%s\n' "${expected_rules}" | /usr/bin/sed 's/^/          /')" \
      "$(printf '%s\n' "${actual_rules}"   | /usr/bin/sed 's/^/          /')"
  fi

  # Two properties restated against the parsed view, so a failure says WHICH
  # guarantee was lost rather than only that a diff appeared.
  check "$([ "$(psql_ro -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL AND type <> 'local' AND 'ai_capital_migrator' = ANY(user_name) AND auth_method <> 'reject'")" = '0' ] && echo true || echo false)" \
        'no non-local rule names the migrator with a non-reject method'
  check "$([ "$(psql_ro -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL AND type <> 'local' AND 'all' = ANY(user_name) AND auth_method <> 'reject'")" = '0' ] && echo true || echo false)" \
        'no non-local rule admits ALL users — the migrator has no TCP path'
  check "$([ "$(psql_ro -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL AND auth_method IN ('trust','ident','password')")" = '0' ] && echo true || echo false)" \
        'no trust, ident or cleartext-password rule parsed'

  printf '\n== roles: exactly two hold a password\n'
  local with_pw
  with_pw="$(psql_ro -c "SELECT count(*) FROM pg_authid WHERE rolpassword IS NOT NULL AND rolname LIKE 'ai\\_capital%'")"
  check "$([ "${with_pw}" = '2' ] && echo true || echo false)" 'exactly two ai_capital roles have a password' "found ${with_pw}"

  printf '\n== the lockdown has NOT been applied\n'
  # 090 line 41 revokes this membership. If it is gone, the Phase-H legacy copy
  # is already impossible and that must be reported loudly, not discovered at
  # copy time.
  check "$([ "$(psql_ro -c "SELECT pg_has_role('${MIGRATOR_ROLE}', '${OWNER_ROLE}', 'MEMBER')")" = 't' ] && echo true || echo false)" \
        "${MIGRATOR_ROLE} still holds ${OWNER_ROLE} (the lockdown has not run)"

  printf '\n== migrations\n'
  local applied
  applied="$(psql_ro -c 'SELECT count(*) FROM db.schema_migrations' 2>/dev/null || echo 'unreadable')"
  check "$([ "${applied}" = '19' ] && echo true || echo false)" 'nineteen migrations recorded' "found ${applied}"

  printf '\n== extensions\n'
  local ext
  for ext in vector btree_gist; do
    check "$([ "$(psql_ro -c "SELECT count(*) FROM pg_extension WHERE extname = '${ext}'")" = '1' ] && echo true || echo false)" \
          "${ext} is installed"
  done

  printf '\n== PUBLIC holds nothing\n'
  check "$([ "$(psql_ro -c "SELECT has_database_privilege('public', '${TARGET_DB}', 'CONNECT')")" = 'f' ] && echo true || echo false)" \
        'PUBLIC cannot CONNECT to the database'
}

main() {
  case "${1-}" in
    --running) verify_running ;;
    --stopped) verify_stopped ;;
    *)
      printf 'usage: verify.sh --running | --stopped\n\n' >&2
      printf '  --running  live read-only verification against a running cluster\n' >&2
      printf '  --stopped  filesystem, control-file and port verification; no connection\n\n' >&2
      printf 'There is no default mode.\n' >&2
      exit 2
      ;;
  esac
  printf '\n'
  if [ "${FAILURES}" -ne 0 ]; then
    printf 'VERIFICATION FAILED: %s check(s).\n' "${FAILURES}" >&2
    exit 1
  fi
  printf 'VERIFICATION PASSED.\n'
}

main "$@"
