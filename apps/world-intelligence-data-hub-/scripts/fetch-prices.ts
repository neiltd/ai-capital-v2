// fetch-prices — fetches commodity price series from EIA and stores them.
// Run: npm run fetch-prices
// Run: npm run fetch-prices -- --from 2025-01-01   (backfill from a specific date)
// Run: npm run fetch-prices -- --days 30           (fetch last N days, default 7)
//
// Requires: EIA_KEY in .env
// Does not call the export pipeline — run `npm run export` afterward.

import 'dotenv/config';
import { env } from '../lib/env.ts';
import { logger } from '../lib/logger.ts';
import {
  BENCHMARK_CONFIGS,
} from '../ingestion/timeseries/benchmark-configs.ts';
import { fetchAllBenchmarks } from '../ingestion/timeseries/eia-prices.ts';
import {
  appendDatapoints, ensureMetadata, getLastDataPoint,
} from '../store/timeseries-store.ts';

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  const to   = new Date().toISOString().slice(0, 10);

  const fromFlag = args.indexOf('--from');
  if (fromFlag !== -1 && args[fromFlag + 1]) {
    return { from: args[fromFlag + 1]!, to };
  }

  const daysFlag = args.indexOf('--days');
  const days = daysFlag !== -1 && args[daysFlag + 1] ? parseInt(args[daysFlag + 1]!, 10) : 7;

  const d = new Date();
  d.setDate(d.getDate() - days);
  return { from: d.toISOString().slice(0, 10), to };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Hard fail if EIA_KEY is missing — give a clear message
  if (!env['EIA_KEY']) {
    console.error('\n[fetch-prices] EIA_KEY is not set.');
    console.error('  Register for a free EIA API key at https://www.eia.gov/opendata/');
    console.error('  Then add EIA_KEY=your_key_here to your .env file.\n');
    process.exit(1);
  }

  const { from, to } = parseArgs();
  const configs = BENCHMARK_CONFIGS;

  // Ensure metadata files exist for all benchmarks
  for (const config of configs) {
    ensureMetadata(config);
  }

  console.log(`\nfetch-prices — ${configs.length} benchmarks | ${from} → ${to}`);
  console.log('─'.repeat(60));

  // Fetch from EIA
  const fetched = await fetchAllBenchmarks(configs, from, to);

  // Store and report
  let totalAppended = 0;
  let totalRevised  = 0;

  for (const config of configs) {
    const points  = fetched.get(config.benchmarkId) ?? [];
    if (points.length === 0) {
      console.log(`  ${config.benchmarkId.padEnd(20)} — no data received`);
      continue;
    }

    const result = appendDatapoints(config, points);
    totalAppended += result.appended;
    totalRevised  += result.revised;

    const lastPoint = getLastDataPoint(config.benchmarkId);
    console.log(
      `  ${config.benchmarkId.padEnd(20)} | ` +
      `fetched: ${String(points.length).padStart(3)} | ` +
      `appended: ${result.appended} | ` +
      `revised: ${result.revised} | ` +
      `unchanged: ${result.unchanged} | ` +
      `latest: ${lastPoint?.date ?? 'n/a'}`,
    );
  }

  console.log('─'.repeat(60));
  console.log(`Total — appended: ${totalAppended}, revised: ${totalRevised}`);
  console.log('\nRun `npm run export` to generate price export files.\n');
}

main().catch(err => {
  logger.error('fetch-prices', (err as Error).message);
  process.exit(1);
});
