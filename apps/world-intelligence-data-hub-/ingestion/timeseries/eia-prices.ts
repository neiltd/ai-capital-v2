// EIA API v2 connector for commodity price series (end-of-day settlement only).
// No streaming, no intraday, no interpolation.
// Requires EIA_KEY environment variable.

import { env } from '../../lib/env.ts';
import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError } from '../clients/base.client.ts';
import type { BenchmarkConfig, FetchedDatapoint } from './types.ts';

const EIA_BASE = 'https://api.eia.gov/v2/';
const TIMEOUT_MS = 20_000;

// ── EIA API response shapes ───────────────────────────────────────────────────

interface EIAPricePoint {
  period:               string;       // 'YYYY-MM-DD'
  series:               string;       // 'RBRTE', 'RWTC', 'RNGWHHD', etc.
  'series-description': string;
  value:                string | number | null;
  units:                string;
}

interface EIAResponse {
  response: {
    total:       number;
    dateFormat:  string;
    frequency:   string;
    data:        EIAPricePoint[];
  };
}

// ── Fetch one benchmark ───────────────────────────────────────────────────────

export async function fetchBenchmarkPrices(
  config: BenchmarkConfig,
  from:   string,   // YYYY-MM-DD
  to:     string,   // YYYY-MM-DD
): Promise<FetchedDatapoint[]> {
  if (!config.eia) {
    throw new Error(`No EIA config for benchmark: ${config.benchmarkId}`);
  }

  const key = env['EIA_KEY'];
  if (!key) {
    throw new SourceFetchError(
      'eia',
      `EIA_KEY not set — add it to your .env file to fetch ${config.benchmarkId}`,
    );
  }

  const url = new URL(`${EIA_BASE}${config.eia.route}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('frequency', 'daily');
  url.searchParams.set('data[0]', 'value');
  url.searchParams.set('facets[series][]', config.eia.seriesId);
  url.searchParams.set('start', from);
  url.searchParams.set('end', to);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'asc');
  url.searchParams.set('length', '365');

  logger.info('eia-prices', `Fetching ${config.benchmarkId} (${config.eia.seriesId}) ${from} → ${to}`);

  const res = await fetchWithTimeout(url.toString(), {}, TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SourceFetchError('eia', `HTTP ${res.status} for ${config.benchmarkId}: ${body}`, res.status);
  }

  const json = (await res.json()) as EIAResponse;
  const raw  = json.response?.data ?? [];

  const fetchedAt = new Date().toISOString();

  const points: FetchedDatapoint[] = raw
    .filter(d => d.period && d.period.match(/^\d{4}-\d{2}-\d{2}$/))
    .map(d => ({
      date:      d.period,
      value:     d.value !== null && d.value !== '' ? parseFloat(String(d.value)) : null,
      source:    'eia',
      fetchedAt,
    }))
    .filter(d => d.value === null || !isNaN(d.value as number));

  logger.info('eia-prices', `  ${config.benchmarkId}: ${points.length} points received`);
  return points;
}

// ── Fetch multiple benchmarks ─────────────────────────────────────────────────

export async function fetchAllBenchmarks(
  configs: BenchmarkConfig[],
  from:    string,
  to:      string,
): Promise<Map<string, FetchedDatapoint[]>> {
  const results = new Map<string, FetchedDatapoint[]>();

  for (const config of configs) {
    if (!config.eia) continue;
    try {
      const points = await fetchBenchmarkPrices(config, from, to);
      results.set(config.benchmarkId, points);
    } catch (err) {
      logger.error('eia-prices', `Failed to fetch ${config.benchmarkId}: ${(err as Error).message}`);
      results.set(config.benchmarkId, []);
    }
  }

  return results;
}
