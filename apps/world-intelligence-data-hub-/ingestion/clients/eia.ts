import { requireKey } from '../../lib/env.ts';
import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError, type SourceClient } from './base.client.ts';

// Raw shape from EIA API v2
export interface EIADataPoint {
  period: string;
  'area-name': string;
  'product-name': string;
  'series-description': string;
  value: string | number | null;
  units: string;
}

export interface EIASeriesResponse {
  response: {
    total: number;
    dateFormat: string;
    frequency: string;
    data: EIADataPoint[];
  };
}

// Series to fetch: spot prices (WTI, Brent) and US weekly production
const SERIES: Array<{ route: string; label: string; frequency: string }> = [
  { route: 'petroleum/pri/spt/data/', label: 'spot-prices',   frequency: 'daily'  },
  { route: 'petroleum/sum/sndw/data/', label: 'us-production', frequency: 'weekly' },
];

export class EIAClient implements SourceClient {
  readonly name = 'eia';

  async fetch(since?: string): Promise<Record<string, EIASeriesResponse>> {
    const key = requireKey('EIA_KEY', this.name);
    const from = (since ?? new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()).slice(0, 10);
    const results: Record<string, EIASeriesResponse> = {};

    for (const { route, label, frequency } of SERIES) {
      const url = new URL(`https://api.eia.gov/v2/${route}`);
      url.searchParams.set('api_key', key);
      url.searchParams.set('frequency', frequency);
      url.searchParams.set('data[0]', 'value');
      url.searchParams.set('start', from);
      url.searchParams.set('sort[0][column]', 'period');
      url.searchParams.set('sort[0][direction]', 'desc');
      url.searchParams.set('length', '30');

      logger.info(this.name, `Fetching ${label} since ${from}`);
      const res = await fetchWithTimeout(url.toString(), {}, 20_000);

      if (!res.ok) {
        const body = await res.text();
        throw new SourceFetchError(this.name, `HTTP ${res.status} on ${label}: ${body}`, res.status);
      }

      const data = (await res.json()) as EIASeriesResponse;
      logger.info(this.name, `Got ${data.response?.data?.length ?? 0} points for ${label}`);
      results[label] = data;
    }

    return results;
  }
}
