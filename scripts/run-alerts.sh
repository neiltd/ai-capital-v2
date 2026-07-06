#!/bin/bash
# Hot-ticker alert wrapper for launchd (every 30 min during market hours).
#
# Uses launchd rather than cron: cron invocations were hitting macOS TCC
# "Operation not permitted" errors reading files under ~/Desktop, while
# launchd user agents inherit the logged-in user's TCC grants.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="/Users/thanapold/Desktop/Projects.nosync"
cd "$ROOT/apps/scenario-simulator" || exit 2
exec /opt/homebrew/bin/npx tsx src/cli/cli-alerts.ts
