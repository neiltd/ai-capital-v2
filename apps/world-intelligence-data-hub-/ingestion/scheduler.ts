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
  { source: 'acled',     expression: '0 1 * * *',      label: 'Daily at 01:00 UTC' },
  { source: 'eia',       expression: '0 6,18 * * *',   label: 'Twice daily'        },
  { source: 'worldbank', expression: '0 2 * * 0',      label: 'Weekly Sun 02:00'   },
];

// ── Start ─────────────────────────────────────────────────────────────────────

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
