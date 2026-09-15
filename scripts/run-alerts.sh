#!/bin/bash
# Hot-ticker alert wrapper for launchd (every 30 min during market hours).
#
# Uses launchd rather than cron: cron invocations were hitting macOS TCC
# "Operation not permitted" errors reading files under ~/Desktop, while
# launchd user agents inherit the logged-in user's TCC grants.
#
# CREDENTIAL POLICY LIVES IN THE LAUNCHER, NOT HERE (slice S4D).
# This script used to export a hard-coded superuser connection string as a
# `${VAR:-default}` fallback, so a missing credential silently ran as the
# personal role. Even `${VAR:?}` would be too weak — it accepts whitespace, a
# wrong scheme, and an incomplete URL that libpq completes from PGDATABASE.
# packages/queue/bin/run-stage.ts applies the same validation the worker uses,
# strips every other database credential, and derives DATABASE_URL from the
# validated PIPELINE_DATABASE_URL. This file passes a FIXED command and nothing
# else; it holds no policy and no default.

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
cd "$ROOT/apps/scenario-simulator" || exit 2

exec /opt/homebrew/bin/npx tsx "$ROOT/packages/queue/bin/run-stage.ts" \
  -- /opt/homebrew/bin/npx tsx src/cli/cli-alerts.ts
