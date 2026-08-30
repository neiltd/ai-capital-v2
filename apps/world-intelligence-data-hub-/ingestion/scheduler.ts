// Long-running scheduler — fires each source on its own cadence.
// Usage: npm run schedule
//
// Cron expressions:
//   GDELT:      every 15 minutes
//   ACLED:      every 24 hours (01:00 UTC)
//   EIA:        every 12 hours (06:00 / 18:00 UTC)
//   World Bank: every Sunday at 02:00 UTC

import cron from 'node-cron';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../lib/logger.ts';

const __dir  = dirname(fileURLToPath(import.meta.url));
const runScript = join(__dir, '..', 'run.ts');

// ── Run a single named source via the CLI entry point ─────────────────────────
// Each scheduled task spawns a fresh process so that a crash in one source
// does not kill the scheduler.

function runSource(source: string): void {
  logger.info('scheduler', `Triggering: ${source}`);
  execFile(
    'npx',
    ['tsx', runScript, source],
    { cwd: join(__dir, '..') },
    (err, stdout, stderr) => {
      if (err) {
        logger.error('scheduler', `${source} process exited with error`, { error: err.message });
      }
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    },
  );
}

// ── Schedule definitions ──────────────────────────────────────────────────────

const schedules: Array<{ source: string; expression: string; label: string }> = [
  { source: 'gdelt',     expression: '*/15 * * * *',   label: 'Every 15 min'       },
  // ACLED cannot return recent events under the current entitlement (12-month
  // recency embargo — see quota/freshness.ts RESTRICTIONS.acled). This daily
  // schedule therefore requests impossible data and burns quota on a guaranteed
  // empty 200, as if recovery by retry were expected. Behaviour deliberately
  // UNCHANGED in this pass; the smallest safe proposal is recorded in
  // docs/incidents/2026-08-29-world-intel-freshness.md — gate the schedule on
  // the declared restriction so an entitlement change re-enables it
  // automatically, rather than deleting the integration.
  { source: 'acled',     expression: '0 1 * * *',      label: 'Daily at 01:00 UTC' },
  { source: 'eia',       expression: '0 6,18 * * *',   label: 'Twice daily'        },
  { source: 'worldbank', expression: '0 2 * * 0',      label: 'Weekly Sun 02:00'   },
];

// ── Start ─────────────────────────────────────────────────────────────────────

// ── SCHEDULING AUTHORITY GUARD ───────────────────────────────────────────────
// There is exactly ONE production scheduling authority: the BullMQ DAG in
// packages/queue (submitted by launchd via daily-queue.sh -> run-daily.ts).
// This daemon is a second, unmanaged authority — it appears in no launchd job,
// and its GDELT entry fires every 15 minutes, which would bypass the dormancy
// setting entirely and resume structured collection nobody consumes.
//
// It is NOT deleted: the cadences and the per-source process isolation here are
// still the reference for how sources were meant to be driven. It simply refuses
// to start unless someone opts in deliberately, so it cannot become a competing
// authority by accident.
if (process.env.RUN_LEGACY_WORLD_INTEL_SCHEDULER !== 'true') {
  logger.info('scheduler', 'Refusing to start: the production scheduling authority is the BullMQ DAG');
  logger.info('scheduler', '  Structured ingestion is scheduled by packages/queue, and is dormant by default.');
  logger.info('scheduler', '  Scheduled structured ingestion is DORMANT and activation-ready, not one flag away:');
  logger.info('scheduler', '    1. install and verify the dedicated structured worker (ops/launchd-proposed/), then');
  logger.info('scheduler', '    2. set SCHEDULE_STRUCTURED_INGESTION=true.');
  logger.info('scheduler', '  Manual one-off run (unaffected by either setting): npm run pipeline');
  logger.info('scheduler', '  To run this legacy daemon anyway: RUN_LEGACY_WORLD_INTEL_SCHEDULER=true npm run schedule');
  process.exit(0);
}

logger.info('scheduler', '═══════════════════════════════════════');
logger.info('scheduler', ' World Intelligence Data Hub — Scheduler');
logger.info('scheduler', '═══════════════════════════════════════');

for (const { source, expression, label } of schedules) {
  logger.info('scheduler', `Registered: ${source.padEnd(12)} ${expression.padEnd(16)} (${label})`);
  cron.schedule(expression, () => runSource(source), { timezone: 'UTC' });
}

logger.info('scheduler', 'All sources scheduled. Waiting for triggers…');
logger.info('scheduler', 'Press Ctrl+C to stop.');

// Keep process alive
process.on('SIGINT', () => {
  logger.info('scheduler', 'Scheduler stopped by user');
  process.exit(0);
});
