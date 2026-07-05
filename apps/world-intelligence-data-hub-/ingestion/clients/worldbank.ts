import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError, type SourceClient } from './base.client.ts';

// World Bank API v2 — no auth required
// Returns macro economic indicators by country and indicator code.

export interface WorldBankDataPoint {
  indicator: { id: string; value: string };
  country:   { id: string; value: string };
  date:      string;                  // e.g. "2024"
  value:     number | null;
  decimal:   number;
}

export type WorldBankResponse = [
  { page: number; pages: number; per_page: number; total: number },
  WorldBankDataPoint[],
];

// Indicators to fetch
const INDICATORS: Array<{ id: string; label: string }> = [
  { id: 'NY.GDP.MKTP.CD',   label: 'gdp_usd' },
  { id: 'FP.CPI.TOTL.ZG',  label: 'inflation_pct' },
  { id: 'SP.POP.TOTL',      label: 'population' },
];

// Countries of strategic interest for energy/macro analysis
const COUNTRIES = [
  'SAU', 'IRQ', 'IRN', 'RUS', 'USA', 'CHN', 'NGA', 'ARE', 'KWT', 'LBY',
  'VEN', 'KAZ', 'AZE', 'NOR', 'BRA', 'OMN', 'QAT', 'AGO', 'ECU',
];

export class WorldBankClient implements SourceClient {
  readonly name = 'worldbank';

  async fetch(_since?: string): Promise<Record<string, WorldBankResponse[]>> {
    const results: Record<string, WorldBankResponse[]> = {};

    for (const { id, label } of INDICATORS) {
      const countryCodes = COUNTRIES.join(';');
      const url = new URL(
        `https://api.worldbank.org/v2/country/${countryCodes}/indicator/${id}`,
      );
      url.searchParams.set('format', 'json');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('mrv', '3');   // most recent 3 values per country

      logger.info(this.name, `Fetching indicator: ${label} (${id})`);
      const res = await fetchWithTimeout(url.toString(), {}, 20_000);

      if (!res.ok) {
        throw new SourceFetchError(this.name, `HTTP ${res.status} for ${label}`, res.status);
      }

      const data = (await res.json()) as WorldBankResponse;
      const pointCount = Array.isArray(data[1]) ? data[1].length : 0;
      logger.info(this.name, `Got ${pointCount} data points for ${label}`);
      results[label] = [data];
    }

    return results;
  }
}
