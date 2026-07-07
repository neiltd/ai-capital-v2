#!/bin/bash
# 15-minute intraday price refresh wrapper for cron.
#
# Cron's minimal env lacks node/npx on PATH and never cd's into the app, so
# `env: node: No such file or directory` and a silently-missing .env
# (cli-refresh.ts uses `dotenv/config`, which reads .env from CWD) were both
# breaking the old crontab entry. This wrapper fixes both.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export DATA_ROOT="/Users/thanapold/Desktop/Projects.nosync/apps"

# Mirror the launchd worker's DATABASE_URL (daily-queue.worker.plist). Without
# it, cli-refresh silently writes prices to the stale SQLite portfolio.db
# instead of the live Postgres portfolio the pipeline/dashboard read.
export DATABASE_URL="${DATABASE_URL:-postgres://thanapold@localhost:5432/ai_capital}"

cd /Users/thanapold/Desktop/Projects.nosync/apps/scenario-simulator || exit 2
exec /Users/thanapold/Desktop/Projects.nosync/node_modules/.bin/tsx src/cli/cli-refresh.ts
