// Entry point — run the full ingestion pipeline once.
// Usage:
//   npm run pipeline                  → all sources
//   npm run pipeline -- newsapi       → single source by name
//   npm run pipeline -- newsapi acled → multiple specific sources

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { QuotaTracker } from './quota/quota-tracker.ts';
import type { SourceClient } from './ingestion/clients/base.client.ts';
import { SOURCE_NAMES, createClient } from './lib/sources-config.ts';
import { runPipeline, buildSourceVersions } from './ingestion/pipelines/pipeline.ts';
import { runAllExports } from './exports/exporter.ts';
import { writeRunManifest, writeExportManifest } from './lib/manifest.ts';
import { logger } from './lib/logger.ts';

// A source can be individually "failed" this run yet still look like a clean
// pipeline overall (anyOk gates the exit code, deliberately — see below).
// That's how ACLED being 403-broken for 9 days went unnoticed: it never
// showed up anywhere the briefing/user actually looks. This sends one LINE
// ping per day (not per run) when any source has gone stale beyond its
// configured maxStalenessHours, so a dead source stays visible without
// making one flaky feed take down the whole pipeline.
async function alertOnStaleSourcesOnce(quota: QuotaTracker): Promise<void> {
  const staleSources = SOURCE_NAMES.filter(name => quota.isStale(name));
  if (staleSources.length === 0) return;

  const marker = join(process.cwd(), 'quota', `stale-alerted-${new Date().toISOString().slice(0, 10)}.json`);
  if (existsSync(marker)) return;

  const lineEnvPath = join(process.cwd(), '..', 'scenario-simulator', '.env');
  if (!existsSync(lineEnvPath)) {
    logger.warn('run', `Stale sources: ${staleSources.join(', ')} — no LINE env found to alert`);
    return;
  }
  const env: Record<string, string> = {};
  for (const line of readFileSync(lineEnvPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = env.LINE_USER_ID;
  if (!token || !userId) {
    logger.warn('run', `Stale sources: ${staleSources.join(', ')} — LINE creds missing`);
    return;
  }

  const text = `⚠️ World-intel: ${staleSources.join(', ')} ${staleSources.length === 1 ? 'has' : 'have'} had no successful fetch in longer than expected. Geopolitical coverage may be silently degraded.`;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) logger.warn('run', `Stale-source LINE alert failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    logger.warn('run', `Stale-source LINE alert error: ${(err as Error).message}`);
  }

  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ staleSources, alertedAt: new Date().toISOString() }, null, 2));
}

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

  await alertOnStaleSourcesOnce(quota);

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
