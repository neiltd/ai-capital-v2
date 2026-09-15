#!/bin/bash
# Monthly dependency-graph scan wrapper for cron.
#
# Cron's minimal PATH lacks node/npm (they live at /opt/homebrew/bin), so the
# bare "cd ... && npm run scan" cron entry has always failed silently — same
# bug class as the intraday price-refresh cron, fixed the same way.

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

cd "$ROOT/apps/dependency-graph-engine" || exit 2
npm run scan && npm run export
