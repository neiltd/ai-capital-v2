import { createHash } from 'crypto';
import type { EnergyIndicator, MacroIndicator } from '../../lib/types.ts';
import type { EIASeriesResponse, EIADataPoint } from '../../ingestion/clients/eia.ts';
import type { WorldBankResponse, WorldBankDataPoint } from '../../ingestion/clients/worldbank.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function stableId(source: string, seed: string): string {
  return createHash('sha256').update(`${source}:${seed}`).digest('hex').slice(0, 20);
}

// ── EIA → EnergyIndicator[] ───────────────────────────────────────────────────

// Map EIA series description snippets to clean metric names
function resolveMetric(description: string, label: string): string {
  const d = description.toLowerCase();
  if (d.includes('wti') || d.includes('west texas'))   return 'wti_price_usd';
  if (d.includes('brent'))                              return 'brent_price_usd';
  if (d.includes('production') || label.includes('production')) return 'production_mbpd';
  if (d.includes('import'))                             return 'imports_mbpd';
  if (d.includes('export'))                             return 'exports_mbpd';
  if (d.includes('inventory') || d.includes('stock'))  return 'inventory_mb';
  return label;
}

export function normalizeEIA(
  raw: unknown,
  fetchedAt: string,
): EnergyIndicator[] {
  const allSeries = raw as Record<string, EIASeriesResponse>;
  const results: EnergyIndicator[] = [];

  for (const [label, series] of Object.entries(allSeries)) {
    const points: EIADataPoint[] = series?.response?.data ?? [];

    for (const point of points) {
      if (point.value === null || point.value === undefined) continue;
      const numVal = typeof point.value === 'string' ? parseFloat(point.value) : point.value;
      if (isNaN(numVal)) continue;

      const metric = resolveMetric(point['series-description'] ?? '', label);
      const country = point['area-name']?.toLowerCase().includes('world') ? 'WORLD' : 'USA';

      results.push({
        id:       stableId('eia', `${metric}:${country}:${point.period}`),
        source:   'eia',
        metric,
        value:    numVal,
        unit:     point.units ?? 'unknown',
        country,
        date:     point.period,
        fetchedAt,
        rawHash:  shortHash(point),
      });
    }
  }

  return results;
}

// ── World Bank → MacroIndicator[] ─────────────────────────────────────────────

const INDICATOR_LABEL_MAP: Record<string, string> = {
  'NY.GDP.MKTP.CD':   'gdp_usd',
  'FP.CPI.TOTL.ZG':  'inflation_pct',
  'SP.POP.TOTL':      'population',
};

export function normalizeWorldBank(
  raw: unknown,
  fetchedAt: string,
): MacroIndicator[] {
  const allIndicators = raw as Record<string, WorldBankResponse[]>;
  const results: MacroIndicator[] = [];

  for (const [label, responses] of Object.entries(allIndicators)) {
    for (const response of responses) {
      const dataPoints: WorldBankDataPoint[] = Array.isArray(response[1]) ? response[1] : [];

      for (const point of dataPoints) {
        if (point.value === null) continue;

        const indicatorId = point.indicator?.id ?? '';
        const metric = INDICATOR_LABEL_MAP[indicatorId] ?? label;

        results.push({
          id:       stableId('worldbank', `${metric}:${point.country.id}:${point.date}`),
          source:   'worldbank',
          metric,
          value:    point.value,
          unit:     metric.includes('pct') ? 'percent' : metric.includes('usd') ? 'USD' : 'count',
          country:  point.country.id,
          date:     point.date,
          fetchedAt,
          rawHash:  shortHash(point),
        });
      }
    }
  }

  return results;
}
