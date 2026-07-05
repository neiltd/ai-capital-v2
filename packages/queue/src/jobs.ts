// Job definitions — one per daily.sh stage, in the order daily.sh ran them.
//
// This already IS a real DAG, not a linear chain: `dependsOn` fans out where
// stages are actually independent (e.g. macro-asset-monitor and
// government-flow-monitor have no dependency on each other, and
// investment-brief depends on three separate subtrees). submit.ts's
// buildDAGTree walks these dependsOn edges and builds the corresponding
// BullMQ FlowProducer tree, so independent subtrees execute in parallel.

import type { JobSpec } from './types.js'

const dayOfWeek = (): number => new Date().getDay()  // 0=Sun, 6=Sat
// FORCE_SUNDAY=1 lets you exercise the Sunday-only stages on any day, which is
// how we smoke-test the weekly pipeline without waiting for the actual cron.
const isSunday  = (): boolean => process.env.FORCE_SUNDAY === '1' || dayOfWeek() === 0
const notSunday = (): boolean => !isSunday()

/**
 * Daily pipeline — mirrors daily.sh end-to-end. Each entry corresponds to
 * one `step` call in daily.sh.
 */
export const DAILY_PIPELINE: JobSpec[] = [
  {
    name: 'macro-asset-monitor',
    cmd:  ['npm', 'run', 'fetch'],
    cwd:  'apps/macro-asset-monitor',
  },
  {
    // Independent — fetches from USASpending.gov.
    name: 'government-flow-monitor',
    cmd:  ['npm', 'run', 'fetch'],
    cwd:  'apps/government-flow-monitor',
  },
  {
    // Independent — fetches GDELT/ACLED/EIA/WorldBank.
    // Runs daily; per-source TTLs in quota-tracker.ts ensure UCDP/WorldBank
    // only hit the API once per week, GDELT/EIA/NewsAPI hit daily.
    name: 'world-intel-pipeline',
    cmd:  ['npm', 'run', 'pipeline'],
    cwd:  'apps/world-intelligence-data-hub-',
    timeoutMs: 30 * 60 * 1000,
  },
  {
    // Collect RSS feeds + Twitter accounts into intelligence/outputs/articles/today/
    name: 'world-intel-collect',
    cmd:  ['npm', 'run', 'collect'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-pipeline',
    timeoutMs: 10 * 60 * 1000,
  },
  {
    // Keyword-score collected articles (no LLM — fast)
    name: 'world-intel-score',
    cmd:  ['npm', 'run', 'score'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-collect',
  },
  {
    // Claude (Sonnet) extracts structured events from high-scoring articles
    name: 'world-intel-report',
    cmd:  ['npm', 'run', 'report'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-score',
    timeoutMs: 20 * 60 * 1000,
  },
  {
    // Dedup and link extracted events into storylines (rule-based, fast)
    name: 'world-intel-dedup',
    cmd:  ['npm', 'run', 'dedup'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-report',
  },
  {
    name: 'world-intel-link',
    cmd:  ['npm', 'run', 'link'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-dedup',
  },
  {
    // Memory-agent enriches extracted events with causal_links + expected_consequences
    name: 'world-intel-memory',
    cmd:  ['npm', 'run', 'memory'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-link',
    timeoutMs: 15 * 60 * 1000,
  },
  {
    name: 'world-intel-export',
    cmd:  ['npm', 'run', 'export'],
    cwd:  'apps/world-intelligence-data-hub-',
    dependsOn: 'world-intel-memory',
  },
  {
    name: 'capital-ingestion',
    cmd:  ['npm', 'run', 'pipeline'],
    cwd:  'apps/capital-intelligence-ingestion',
    dependsOn: 'world-intel-export',
    timeoutMs: 90 * 60 * 1000,   // YahooNews still occasionally slow; hard cap at 90min
    retry: { attempts: 2, backoffMs: 300_000 },  // 1 retry after 5min if it dies
  },
  {
    name: 'thesis-memory',
    cmd:  ['npm', 'run', 'update'],
    cwd:  'apps/thesis-memory',
    dependsOn: 'capital-ingestion',
  },
  {
    name: 'ai-analysis-engine',
    cmd:  ['npm', 'run', 'analyze'],
    cwd:  'apps/ai-analysis-engine',
    dependsOn: ['thesis-memory', 'macro-asset-monitor', 'government-flow-monitor'],
    timeoutMs: 15 * 60 * 1000,
  },
  {
    // Independent — fetches its own OHLCV data.
    name: 'wave-analyzer',
    cmd:  ['npm', 'run', 'wave'],
    cwd:  'apps/wave-analyzer',
  },
  {
    // Independent — refreshes portfolio NAV/prices.
    name: 'scenario-refresh',
    cmd:  ['npm', 'run', 'refresh'],
    cwd:  'apps/scenario-simulator',
  },
  {
    name: 'scenario-simulate',
    cmd:  ['npm', 'run', 'simulate'],
    cwd:  'apps/scenario-simulator',
    dependsOn: 'scenario-refresh',
    timeoutMs: 15 * 60 * 1000,
  },
  {
    // Weekly Claude-powered discovery sweep — same Sunday-only cadence as
    // world-intel-pipeline. ~$15/mo savings vs daily.
    name: 'scenario-discover',
    cmd:  ['npm', 'run', 'discover'],
    cwd:  'apps/scenario-simulator',
    dependsOn: 'scenario-simulate',
    skipIf: notSunday,
    timeoutMs: 30 * 60 * 1000,
  },
  {
    name: 'people-tweets',
    cmd:  ['npm', 'run', 'people-tweets'],
    cwd:  'apps/capital-intelligence-ingestion',
    dependsOn: 'scenario-discover',
    skipIf: notSunday,
  },
  {
    // Weekly (Sundays) — 90-day pairwise correlations across portfolio
    // positions, flags concentration clusters. Feeds briefing. Mirrors
    // daily.sh section 5a: runs after people-tweets, before briefing-backtest.
    name: 'correlation',
    cmd:  ['npm', 'run', 'correlation'],
    cwd:  'apps/investment-analyst-agents',
    dependsOn: 'people-tweets',
    skipIf: notSunday,
    timeoutMs: 15 * 60 * 1000,
  },
  {
    name: 'briefing-backtest',
    cmd:  ['npm', 'run', 'backtest'],
    cwd:  'apps/investment-analyst-agents',
    dependsOn: 'correlation',
  },
  {
    name: 'tax-harvest',
    cmd:  ['npm', 'run', 'tax'],
    cwd:  'apps/investment-analyst-agents',
    dependsOn: 'briefing-backtest',
  },
  {
    name: 'risk-metrics',
    cmd:  ['npm', 'run', 'risk'],
    cwd:  'apps/investment-analyst-agents',
    dependsOn: 'tax-harvest',
  },
  {
    name: 'investment-brief',
    cmd:  ['npm', 'run', 'brief'],
    cwd:  'apps/investment-analyst-agents',
    dependsOn: ['ai-analysis-engine', 'risk-metrics', 'wave-analyzer'],
    timeoutMs: 15 * 60 * 1000,
  },
  {
    // Non-LLM digest — reads pipeline_runs.db + brief + portfolio. Writes
    // /tmp/morning-status.md so the user can `cat` it on wake.
    name: 'morning-status',
    cmd:  ['npx', 'tsx', 'scripts/morning-status.ts'],
    cwd:  '.',
    dependsOn: 'investment-brief',
  },
]
