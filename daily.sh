#!/bin/bash
# Daily investment intelligence pipeline
# Runs all projects in dependency order; external API failures are logged but don't abort.
# Usage: ./daily.sh
# Cron:  0 7 * * 1-5 /Users/thanapold/Desktop/Projects/daily.sh   # weekdays 7am Pacific

# `pipefail` makes a piped command's exit code the FIRST non-zero, instead of
# the last command (tee, which always succeeds). Without this, killed/failed
# `npm run` inside `step()` were silently being reported as success.
set -o pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Phase 3 monorepo: each project lives under apps/<name>/.
# DATA_ROOT is what consumers (unified-platform, capital-intel notebooklm,
# scenario refresh export, government-flow exporter) look at when resolving
# cross-project JSON paths.
export DATA_ROOT="$ROOT/apps"

# Phase 3.2 observability: every step gets a row in pipeline_runs.db via
# packages/pipeline-runs' run-step wrapper. PIPELINE_RUNS_DB is shared by
# wrapper, dashboard, and any app that records sub-stages.
export PIPELINE_RUNS_DB="$ROOT/data/pipeline-runs.db"
TSX="$ROOT/node_modules/.bin/tsx"
RUN_STEP="$ROOT/packages/pipeline-runs/bin/run-step.ts"

mkdir -p "$ROOT/logs" "$ROOT/data"
LOG="$ROOT/logs/daily-$(date +%F).log"
FAILED=()

log()  { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
fail() { echo "[$(date '+%H:%M:%S')] FAILED: $*" | tee -a "$LOG"; }

step() {
  local label="$1"; shift
  local dir="$1";   shift
  log "--- $label"
  if ! (cd "$ROOT/$dir" && "$TSX" "$RUN_STEP" --stage "$label" -- "$@" 2>&1 | tee -a "$LOG"); then
    fail "$label"
    FAILED+=("$label")
  fi
}

log "=============================="
log " Daily pipeline — $(date '+%Y-%m-%d %H:%M')"
log "=============================="

# 1. Market prices + FRED liquidity + USASpending gov contracts
step "macro-asset-monitor"      apps/macro-asset-monitor      npm run fetch
step "government-flow-monitor"  apps/government-flow-monitor  npm run fetch

# 2. Intelligence ingestion (both safe to run same day — no shared quota)
# World-intelligence runs daily; per-source TTLs in quota-tracker.ts ensure
# UCDP/WorldBank only hit the API once per week regardless.
DAY_OF_WEEK=$(date +%u)   # 1=Mon, 7=Sun
step "world-intelligence"       apps/world-intelligence-data-hub-    npm run pipeline
step "world-intel-collect"      apps/world-intelligence-data-hub-    npm run collect
step "world-intel-score"        apps/world-intelligence-data-hub-    npm run score
step "world-intel-report"       apps/world-intelligence-data-hub-    npm run report
step "world-intel-dedup"        apps/world-intelligence-data-hub-    npm run dedup
step "world-intel-link"         apps/world-intelligence-data-hub-    npm run link
step "world-intel-memory"       apps/world-intelligence-data-hub-    npm run memory
step "world-intel-export"       apps/world-intelligence-data-hub-    npm run export
step "capital-ingestion"        apps/capital-intelligence-ingestion  npm run pipeline

# 3. AI analysis (reads ingestion output)
step "thesis-memory"            apps/thesis-memory        npm run update
step "ai-analysis-engine"       apps/ai-analysis-engine   npm run analyze

# 4. Market signals
step "wave-analyzer"            apps/wave-analyzer        npm run wave
step "scenario-refresh"         apps/scenario-simulator   npm run refresh
step "scenario-simulate"        apps/scenario-simulator   npm run simulate

# Discovery runs WEEKLY (Sundays only) to save ~$15/mo on Claude.
# Most candidates that pass threshold today will still be there next Sunday;
# weekly aggregation produces stronger signals than daily noise.
# Manual override: `npm run discover` in apps/scenario-simulator anytime.
if [ "$DAY_OF_WEEK" = "7" ]; then
  step "scenario-discover"      apps/scenario-simulator   npm run discover
else
  log "Skipping scenario-discover — weekly cadence (Sundays only)"
fi

# People-following — weekly pull of tracked execs' tweets.
# Costs ~$0.55/mo on twitterapi.io credits. Output feeds people-analyzer
# which extracts role_change / public_statement events into people-events.json.
if [ "$DAY_OF_WEEK" = "7" ]; then
  step "people-tweets"          apps/capital-intelligence-ingestion  npm run people-tweets
else
  log "Skipping people-tweets — weekly cadence (Sundays only)"
fi

# 5a. Correlation analysis — weekly (Sundays). Computes 90-day pairwise correlations
# across all portfolio positions and flags concentration clusters. Output feeds briefing.
if [ "$DAY_OF_WEEK" = "7" ]; then
  step "correlation"            apps/investment-analyst-agents  npm run correlation
else
  log "Skipping correlation — weekly cadence (Sundays only)"
fi

# 5b. Briefing self-calibration — scores prior recommendations against actual prices.
# Feeds calibration.json into the briefing as a self-awareness mechanism.
step "briefing-backtest"        apps/investment-analyst-agents  npm run backtest

# 6. Tax-loss harvesting + wash-sale tracking — feeds harvest.json into briefing.
step "tax-harvest"              apps/investment-analyst-agents  npm run tax

# 7. Portfolio risk metrics — VAR, Sharpe, beta, max drawdown, per-ticker risk.
step "risk-metrics"             apps/investment-analyst-agents  npm run risk

# 8. Daily briefing
step "investment-brief"         apps/investment-analyst-agents  npm run brief

# 9. Morning status digest — non-LLM, reads pipeline_runs.db + brief + portfolio.
# Writes /tmp/morning-status.md (user `cat`s on wake) + logs/morning-status-$DATE.log.
# Wrapped via step() so any failure is visible on the dashboard like every other stage.
step "morning-status"           .  "$TSX" "$ROOT/scripts/morning-status.ts"

# ── Summary ──────────────────────────────────────────────────────────────────
log "=============================="
if [ ${#FAILED[@]} -eq 0 ]; then
  log " All steps completed successfully"
else
  log " ${#FAILED[@]} step(s) failed: ${FAILED[*]}"
fi
log " Log: $LOG"
log "=============================="

# Clean up logs older than 30 days
find "$ROOT/logs" -name "daily-*.log" -mtime +30 -delete 2>/dev/null

[ ${#FAILED[@]} -eq 0 ]
