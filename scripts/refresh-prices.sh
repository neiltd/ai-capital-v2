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
export DATA_ROOT="/Users/thanapold/Desktop/Projects.nosync/apps"

ROOT="/Users/thanapold/Desktop/Projects.nosync"
cd "$ROOT/apps/scenario-simulator" || exit 2

exec "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/queue/bin/run-stage.ts" \
  -- "$ROOT/node_modules/.bin/tsx" src/cli/cli-refresh.ts
