#!/bin/bash
# Intraday price refresh — a MANUAL tool (slice S4D).
#
# It has no crontab entry and no launchd job; the only mention of it in
# installed configuration is a comment. It is run deliberately by an operator,
# and S4D does not create a scheduled job for it.
#
# Cron's minimal env lacks node/npx on PATH and never cd's into the app, so
# `env: node: No such file or directory` and a silently-missing .env
# (cli-refresh.ts uses `dotenv/config`, which reads .env from CWD) were both
# breaking the old crontab entry. This wrapper fixes both.
#
# CREDENTIAL POLICY LIVES IN THE LAUNCHER, NOT HERE — see scripts/run-alerts.sh
# for why a shell-side default or `${VAR:?}` check is not sufficient.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# ROOT IS DERIVED FROM THIS SCRIPT'S OWN LOCATION.
#
# It used to be the literal /Users/thanapold/Desktop/Projects.nosync, which
# pinned the runtime to one directory and blocked the relocation out of ~/Desktop
# that macOS TCC forces (launchd cannot execute scripts there: the daily,
# watchdog and alerts agents have been failing with "Operation not permitted").
#
# BASH_SOURCE[0], not $0 and not cwd: $0 is the interpreter's view and differs
# when the file is sourced, while cwd is whatever launchd or an operator happened
# to leave behind. The script's own path is the one thing that always describes
# the checkout it belongs to.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Derived FROM ROOT, so the two can never disagree about which checkout is live.
export DATA_ROOT="$ROOT/apps"
cd "$ROOT/apps/scenario-simulator" || exit 2

exec "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/queue/bin/run-stage.ts" \
  -- "$ROOT/node_modules/.bin/tsx" src/cli/cli-refresh.ts
