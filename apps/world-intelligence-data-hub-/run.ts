// Entry point — run the full ingestion pipeline once.
// Usage:
//   npm run pipeline                  → all sources
//   npm run pipeline -- newsapi       → single source by name
//   npm run pipeline -- newsapi acled → multiple specific sources

import { QuotaTracker } from './quota/quota-tracker.ts';
import type { SourceClient } from './ingestion/clients/base.client.ts';
import { SOURCE_NAMES, createClient } from './lib/sources-config.ts';
import { runPipeline, buildSourceVersions } from './ingestion/pipelines/pipeline.ts';
import { runAllExports } from './exports/exporter.ts';
import { writeRunManifest, writeExportManifest } from './lib/manifest.ts';
import { logger } from './lib/logger.ts';

// NewsAPI removed — GDELT covers the same geopolitical queries (free, unlimited).
// NewsAPI quota is reserved exclusively for capital-intelligence-ingestion (company news).
//
// UCDP is an ACLED fallback: only included when ACLED's last successful fetch
// is more than 48 hours (2 days) old — see maxStalenessHours for 'acled' in
// quota/quota-tracker.ts. Both produce conflict event data; running both in
// parallel wastes quota for overlapping coverage.
//
// Source names come from lib/sources-config.ts (the canonical list also used
// by scripts/dry-run.ts, scripts/validate-credentials.ts and scripts/backfill.ts)
// so this list can't silently drift from theirs again.
function buildClients(quota: QuotaTracker): SourceClient[] {
  const acledStale = quota.isStale('acled')
  const names = acledStale ? SOURCE_NAMES : SOURCE_NAMES.filter(n => n !== 'ucdp');
  return names.map(createClient);
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter(a => !a.startsWith('--'));

  const quota = new QuotaTracker();
  const allClients = buildClients(quota);

  const clients = requested.length > 0
    ? allClients.filter(c => requested.includes(c.name))
    : allClients;

  if (clients.length === 0) {
    logger.error('run', `No matching sources for: ${requested.join(', ')}`);
    logger.info('run', `Available sources: ${allClients.map(c => c.name).join(', ')}`);
    process.exit(1);
  }

  logger.info('run', '═══════════════════════════════════════');
  logger.info('run', ' World Intelligence Data Hub — Pipeline ');
  logger.info('run', '═══════════════════════════════════════');
  logger.info('run', `Quota summary at start`, quota.getSummary());

  // Run ingestion
  const manifest = await runPipeline(clients, quota);

  // Export if any source succeeded
  const anyOk = Object.values(manifest.sources).some(s => s.status === 'ok');
  if (anyOk) {
    const { versions, stale } = buildSourceVersions(quota, manifest.sources);
    runAllExports(versions, stale);
    writeExportManifest();
    manifest.exported = true;
  } else {
    logger.warn('run', 'No sources succeeded — skipping export');
  }

  // Write run record
  writeRunManifest(manifest);

  // Exit summary
  const { sources } = manifest;
  const ok      = Object.values(sources).filter(s => s.status === 'ok').length;
  const skipped = Object.values(sources).filter(s => s.status === 'skipped').length;
  const failed  = Object.values(sources).filter(s => s.status === 'failed').length;

  logger.info('run', '═══════════════════════════════════════');
  logger.info('run', `Done: ${ok} ok / ${skipped} skipped / ${failed} failed`);
  if (failed > 0) {
    const failedNames = Object.entries(sources)
      .filter(([, r]) => r.status === 'failed')
      .map(([name, r]) => `${name} (${r.error})`)
      .join(', ');
    logger.warn('run', `Failed sources: ${failedNames}`);
  }
  // Only treat the run as failed if nothing succeeded. External feeds (ACLED,
  // EIA) go down or rate-limit frequently; as long as one source produced
  // events and exports landed, downstream stages should keep running.
  if (!anyOk) {
    logger.error('run', 'All sources failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error('run', 'Unhandled fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
