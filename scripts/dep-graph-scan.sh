#!/bin/bash
# Monthly dependency-graph scan wrapper for cron.
#
# Cron's minimal PATH lacks node/npm (they live at /opt/homebrew/bin), so the
# bare "cd ... && npm run scan" cron entry has always failed silently — same
# bug class as the intraday price-refresh cron, fixed the same way.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd /Users/thanapold/Desktop/Projects.nosync/apps/dependency-graph-engine || exit 2
npm run scan && npm run export
