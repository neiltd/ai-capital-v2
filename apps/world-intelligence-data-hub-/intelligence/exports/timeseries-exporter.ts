// Timeseries exporter — reads from TimeseriesStore, builds camelCase export files.
// Produces: oil-prices.json, gas-prices.json, lng-prices.json
// Does NOT call any APIs. Only reads from the local store.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../lib/paths.ts';
import { logger } from '../../lib/logger.ts';
import {
  getRange, getLastDataPoint, readMetadata,
} from '../../store/timeseries-store.ts';
import {
  BENCHMARK_CONFIGS,
  OIL_PRICE_BENCHMARKS, GAS_PRICE_BENCHMARKS, LNG_PRICE_BENCHMARKS,
  getBenchmarkConfig,
} from '../../ingestion/timeseries/benchmark-configs.ts';
import type { StoredDatapoint } from '../../ingestion/timeseries/types.ts';
import type {
  ExternalCommodityExport, ExternalCommoditySeries,
  ExternalCommodityDatapoint, ExternalCommodityFreshness,
  ExternalDataHealth, StalenessLevel, CommodityDatapointStatus, MissingReason,
} from './contract/external-types.ts';

// ── Coverage window ───────────────────────────────────────────────────────────
// Export 1 year of data (YTD + rolling 90 days prior).
// Enough for chart display without making the file unwieldy.

const EXPORT_DAYS = 365;

function coverageFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - EXPORT_DAYS);
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Staleness computation ─────────────────────────────────────────────────────

function computeStaleness(
  lastUpdated: string | null,
  staleThresholdHours: number,
): StalenessLevel {
  if (!lastUpdated) return 'unknown';
  const ageHours = (Date.now() - new Date(lastUpdated).getTime()) / 3_600_000;
  if (ageHours < staleThresholdHours)        return 'fresh';
  if (ageHours < staleThresholdHours * 2)    return 'stale';
  return 'very_stale';
}

function nextExpectedUpdate(staleThresholdHours: number): string {
  return new Date(Date.now() + staleThresholdHours * 3_600_000).toISOString();
}

// ── Datapoint projection ──────────────────────────────────────────────────────

function projectDatapoint(dp: StoredDatapoint): ExternalCommodityDatapoint {
  const out: ExternalCommodityDatapoint = {
    date:   dp.date,
    value:  dp.value,
    status: dp.status as CommodityDatapointStatus,
  };
  if (dp.value === null) {
    // Infer missingReason from context — weekends are detectable by day of week
    const dow = new Date(dp.date + 'T12:00:00Z').getUTCDay();
    out.missingReason = (dow === 0 || dow === 6)
      ? 'weekend' as MissingReason
      : 'fetch_failed' as MissingReason;
  }
  if (dp.revisionCount && dp.revisionCount > 0) {
    out.isRevised     = true;
    out.revisionCount = dp.revisionCount;
  }
  return out;
}

// ── Series block builder ──────────────────────────────────────────────────────

function buildSeriesBlock(benchmarkId: string, from: string, to: string): ExternalCommoditySeries | null {
  const config = getBenchmarkConfig(benchmarkId);
  if (!config) {
    logger.warn('timeseries-exporter', `Unknown benchmarkId: ${benchmarkId}`);
    return null;
  }

  const storedPoints = getRange(benchmarkId, from, to);
  const lastPoint    = getLastDataPoint(benchmarkId);
  const metadata     = readMetadata(benchmarkId);

  // Compute freshness from the most recent stored point's fetchedAt
  const lastFetchedAt = lastPoint?.fetchedAt ?? null;
  const staleness     = computeStaleness(lastFetchedAt, config.staleThresholdHours);

  const freshness: ExternalCommodityFreshness = {
    lastUpdated:         lastFetchedAt ?? new Date().toISOString(),
    lastDataPoint:       lastPoint?.date ?? null,
    coverageFrom:        metadata?.coverageFrom ?? (storedPoints[0]?.date ?? null),
    dataLag:             config.dataLag,
    staleness,
    staleThresholdHours: config.staleThresholdHours,
    nextExpectedUpdate:  nextExpectedUpdate(config.staleThresholdHours),
    fetchStatus:         storedPoints.length > 0 ? 'success' : 'never',
  };

  return {
    benchmarkId: config.benchmarkId,
    name:        config.name,
    assetClass:  config.assetClass,
    subClass:    config.subClass,
    unit:        config.unit,
    currency:    config.currency,
    timezone:    'UTC',
    frequency:   config.frequency,
    source:      config.source,
    freshness,
    datapoints:  storedPoints.map(projectDatapoint),
  };
}

// ── Data health summary ───────────────────────────────────────────────────────

function buildDataHealth(series: ExternalCommoditySeries[]): ExternalDataHealth {
  const stale     = series.filter(s => s.freshness.staleness === 'stale');
  const veryStale = series.filter(s => s.freshness.staleness === 'very_stale');
  const failed    = series.filter(s => s.freshness.fetchStatus === 'never' || s.freshness.fetchStatus === 'failed');
  return {
    allSeriesFresh:       stale.length === 0 && veryStale.length === 0,
    staleSeriesCount:     stale.length,
    veryStaleSeriesCount: veryStale.length,
    failedSeriesCount:    failed.length,
    staleSeriesIds:       [...stale, ...veryStale].map(s => s.benchmarkId),
  };
}

// ── Export builders ───────────────────────────────────────────────────────────

function buildExport(
  exportType: string,
  benchmarkIds: string[],
): ExternalCommodityExport {
  const from = coverageFromDate();
  const to   = todayStr();

  const series = benchmarkIds
    .map(id => buildSeriesBlock(id, from, to))
    .filter((s): s is ExternalCommoditySeries => s !== null);

  const asOf = series
    .map(s => s.freshness.lastDataPoint)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1) ?? to;

  const coverageFrom = series
    .map(s => s.datapoints[0]?.date)
    .filter((d): d is string => d !== undefined)
    .sort()
    .at(0) ?? from;

  return {
    schemaVersion:       '2.0',
    exportType,
    generatedAt:         new Date().toISOString(),
    asOf,
    coverageFrom,
    frequencyNormalized: 'daily',
    dataHealth:          buildDataHealth(series),
    series,
  };
}

// ── Write helper ──────────────────────────────────────────────────────────────

function writeExport(filePath: string, data: ExternalCommodityExport): { bytes: number } {
  const json  = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(json, 'utf-8');
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, json);
  return { bytes };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TimeseriesExportResult {
  oilPrices: { seriesCount: number; datapointCount: number; bytes: number; asOf: string };
  gasPrices: { seriesCount: number; datapointCount: number; bytes: number; asOf: string };
  lngPrices: { seriesCount: number; datapointCount: number; bytes: number; asOf: string };
}

export function runTimeseriesExports(): TimeseriesExportResult {
  // Oil prices
  const oilExport = buildExport('oil-prices', OIL_PRICE_BENCHMARKS);
  const oilWritten = writeExport(PATHS.exports.timeseries.oilPrices, oilExport);
  logger.info('timeseries-exporter', `oil-prices.json — ${oilExport.series.length} series, asOf ${oilExport.asOf}`);

  // Gas prices
  const gasExport = buildExport('gas-prices', GAS_PRICE_BENCHMARKS);
  const gasWritten = writeExport(PATHS.exports.timeseries.gasPrices, gasExport);
  logger.info('timeseries-exporter', `gas-prices.json — ${gasExport.series.length} series, asOf ${gasExport.asOf}`);

  // LNG prices (Phase 2 benchmarks — may be empty)
  const lngExport = buildExport('lng-prices', LNG_PRICE_BENCHMARKS);
  const lngWritten = writeExport(PATHS.exports.timeseries.lngPrices, lngExport);
  logger.info('timeseries-exporter', `lng-prices.json — ${lngExport.series.length} series, asOf ${lngExport.asOf}`);

  return {
    oilPrices: {
      seriesCount:    oilExport.series.length,
      datapointCount: oilExport.series.reduce((n, s) => n + s.datapoints.length, 0),
      bytes:          oilWritten.bytes,
      asOf:           oilExport.asOf,
    },
    gasPrices: {
      seriesCount:    gasExport.series.length,
      datapointCount: gasExport.series.reduce((n, s) => n + s.datapoints.length, 0),
      bytes:          gasWritten.bytes,
      asOf:           gasExport.asOf,
    },
    lngPrices: {
      seriesCount:    lngExport.series.length,
      datapointCount: lngExport.series.reduce((n, s) => n + s.datapoints.length, 0),
      bytes:          lngWritten.bytes,
      asOf:           lngExport.asOf,
    },
  };
}
