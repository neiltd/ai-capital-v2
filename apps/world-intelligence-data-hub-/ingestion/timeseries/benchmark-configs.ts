// Canonical registry of all supported benchmarks.
// benchmarkId values are immutable — never rename, only deprecate.
// Add new benchmarks here; the store and exporter pick them up automatically.

import type { BenchmarkConfig } from './types.ts';

// ── Phase 1 benchmarks ────────────────────────────────────────────────────────

export const BENCHMARK_CONFIGS: BenchmarkConfig[] = [

  // ── Crude oil ───────────────────────────────────────────────────────────────

  {
    benchmarkId:         'brent_crude',
    name:                'Brent Crude Oil',
    assetClass:          'commodity',
    subClass:            'crude_oil',
    unit:                'USD/barrel',
    currency:            'USD',
    frequency:           'daily',
    source:              'eia',
    dataLag:             'D+1',
    staleThresholdHours: 36,         // allow for a business day + overnight lag
    revisionWindowDays:  28,         // EIA typically finalizes within 4 weeks
    revisionThreshold:   0.001,      // 0.1% — filter float noise
    eia: {
      route:    'petroleum/pri/spt/data/',
      seriesId: 'RBRTE',
    },
  },

  {
    benchmarkId:         'wti_crude',
    name:                'WTI Crude Oil',
    assetClass:          'commodity',
    subClass:            'crude_oil',
    unit:                'USD/barrel',
    currency:            'USD',
    frequency:           'daily',
    source:              'eia',
    dataLag:             'D+1',
    staleThresholdHours: 36,
    revisionWindowDays:  28,
    revisionThreshold:   0.001,
    eia: {
      route:    'petroleum/pri/spt/data/',
      seriesId: 'RWTC',
    },
  },

  // ── Natural gas ─────────────────────────────────────────────────────────────

  {
    benchmarkId:         'henry_hub',
    name:                'Henry Hub Natural Gas',
    assetClass:          'commodity',
    subClass:            'natural_gas',
    unit:                'USD/MMBtu',
    currency:            'USD',
    frequency:           'daily',
    source:              'eia',
    dataLag:             'D+1',
    staleThresholdHours: 36,
    revisionWindowDays:  28,
    revisionThreshold:   0.001,
    eia: {
      route:    'natural-gas/pri/fut/data/',  // daily Henry Hub spot via NYMEX futures endpoint
      seriesId: 'RNGWHHD',
    },
  },
];

// ── Export groupings (used by timeseries-exporter.ts) ────────────────────────

export const OIL_PRICE_BENCHMARKS  = ['brent_crude', 'wti_crude'];
export const GAS_PRICE_BENCHMARKS  = ['henry_hub'];
export const LNG_PRICE_BENCHMARKS:  string[] = [];  // Phase 2: 'jkm_lng', 'ttf_gas'

// Lookup by benchmarkId
const CONFIG_MAP = new Map(BENCHMARK_CONFIGS.map(c => [c.benchmarkId, c]));

export function getBenchmarkConfig(benchmarkId: string): BenchmarkConfig | undefined {
  return CONFIG_MAP.get(benchmarkId);
}
