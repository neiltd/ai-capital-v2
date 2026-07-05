// Backfill historical data for a single source.
// Usage: npm run backfill -- --source=acled --from=2026-01-01 --to=2026-05-01
//
// Respects quota. Writes to raw store only.
// Does NOT normalize or export — run npm run pipeline after backfill.

import { QuotaTracker }   from '../quota/quota-tracker.ts';
import type { SourceClient } from '../ingestion/clients/base.client.ts';
import { SOURCE_NAMES, createClient } from '../lib/sources-config.ts';
import { writeRaw, todayStr } from '../store/raw-store.ts';
import { logger } from '../lib/logger.ts';

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag?.split('=')[1];
}

// Built from the same canonical source list run.ts uses, so `--source=` here
// always matches what the real pipeline can actually run (e.g. includes
// ucdp, excludes the retired newsapi source).
const CLIENTS: Record<string, SourceClient> = Object.fromEntries(
  SOURCE_NAMES.map(name => [name, createClient(name)]),
);

// ── Date range generator ──────────────────────────────────────────────────────

function* dateRange(from: string, to: string): Generator<string> {
  const current = new Date(from);
  const end     = new Date(to);
  while (current <= end) {
    yield current.toISOString().slice(0, 10);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

// ── Main — receives validated args so TypeScript can narrow the types ─────────

async function main(source: string, client: SourceClient, from: string, to: string): Promise<void> {
  const quota = new QuotaTracker();

  logger.info('backfill', `Backfilling ${source} from ${from} to ${to}`);

  const dates = [...dateRange(from, to)];
  logger.info('backfill', `${dates.length} days to fetch`);

  for (const date of dates) {
    const { allowed, reason } = quota.canFetch(source);
    if (!allowed) {
      logger.warn('backfill', `Quota exceeded — stopping at ${date}: ${reason}`);
      break;
    }

    try {
      logger.info('backfill', `Fetching ${source} for ${date}…`);
      const raw = await client.fetch(date);
      writeRaw(source, date, raw);
      quota.recordFetch(source, true);

      await new Promise(r => setTimeout(r, 2_000)); // throttle
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('backfill', `Failed for ${date}: ${msg}`);
      quota.recordFetch(source, false);
      // Continue to next date rather than aborting
    }
  }

  logger.info('backfill', 'Backfill complete. Run "npm run pipeline" to normalize and export.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

const sourceName = arg('source');
const fromDate   = arg('from');
const toDate     = arg('to') ?? todayStr();

if (!sourceName || !fromDate) {
  console.error('Usage: npm run backfill -- --source=<name> --from=YYYY-MM-DD [--to=YYYY-MM-DD]');
  console.error(`Available sources: ${Object.keys(CLIENTS).join(', ')}`);
  process.exit(1);
}

// TypeScript narrows sourceName and fromDate to string after the guard above.
const client = CLIENTS[sourceName];
if (!client) {
  logger.error('backfill', `Unknown source: ${sourceName}`);
  logger.error('backfill', `Available: ${Object.keys(CLIENTS).join(', ')}`);
  process.exit(1);
}

// Pass narrowed strings into main — avoids module-level closure narrowing issues.
main(sourceName, client, fromDate, toDate).catch(err => {
  logger.error('backfill', 'Fatal error', { error: String(err) });
  process.exit(1);
});
