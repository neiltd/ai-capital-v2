# Commodity Export Contracts

**Status:** Design document — pre-implementation  
**Version:** 1.0  
**Date:** 2026-05-14  
**Parent:** historical_timeseries_architecture.md

---

## 1. Export File Inventory

| File path | Contents | Update cadence | Consumers |
|---|---|---|---|
| `exports/oil-project/oil-prices.json` | Brent, WTI, Dubai crude daily prices | Daily (business days) | Oil Intelligence frontend |
| `exports/oil-project/gas-prices.json` | Henry Hub, TTF, NBP daily prices | Daily (business days) | Oil Intelligence frontend |
| `exports/oil-project/lng-prices.json` | JKM LNG daily prices | Daily (business days) | Oil Intelligence frontend |
| `exports/oil-project/structural.json` | OPEC production, US inventories, spare capacity | Weekly/monthly | Oil Intelligence frontend |
| `exports/multi-asset.json` (future) | Cross-asset price series | Daily | Future multi-asset views |

All files are written by the Data Hub export runner. All files use the **camelCase external contract** (schemaVersion 2.0+). Frontends consume these files as-is — no transformation.

---

## 2. Common Export Envelope

Every commodity export file begins with this envelope:

```typescript
interface CommodityExportEnvelope {
  schemaVersion:       string;    // '2.0'
  exportType:          string;    // 'oil-prices' | 'gas-prices' | 'lng-prices' | 'structural'
  generatedAt:         string;    // ISO datetime of this export run
  asOf:                string;    // YYYY-MM-DD — most recent date included in this export
  coverageFrom:        string;    // YYYY-MM-DD — earliest date included in this export
  frequencyNormalized: string;    // 'daily' | 'weekly' | 'monthly' — normalized output frequency
  dataHealth: {
    allSeriesFresh:    boolean;
    staleSeriesCount:  number;
    veryStaleSeriesCount: number;
    failedSeriesCount: number;
    staleSeriesIds:    string[];   // benchmarkIds of stale series
  };
  series: SeriesBlock[];
}
```

### 2.1 SeriesBlock

Each element of `series[]` describes one benchmark:

```typescript
interface SeriesBlock {
  benchmarkId:   string;   // stable identifier — 'brent_crude', 'wti_crude', etc.
  name:          string;   // human-readable display name
  assetClass:    string;   // 'commodity'
  subClass:      string;   // 'crude_oil' | 'natural_gas' | 'lng' | etc.
  unit:          string;   // 'USD/barrel' | 'USD/MMBtu' | 'EUR/MWh' | etc.
  currency:      string;   // 'USD' | 'EUR' | 'GBP'
  timezone:      string;   // always 'UTC' for Data Hub exports
  frequency:     string;   // native frequency of this series in this export
  source:        string;   // primary data source ('eia' | 'platts' | 'fred' | etc.)
  freshness:     FreshnessBlock;
  datapoints:    Datapoint[];
}
```

### 2.2 FreshnessBlock

```typescript
interface FreshnessBlock {
  lastUpdated:          string;   // ISO datetime — last successful fetch
  lastDataPoint:        string;   // YYYY-MM-DD — most recent non-null data point
  coverageFrom:         string;   // YYYY-MM-DD — earliest available in store
  dataLag:              string;   // 'D+1' | 'D+2' | 'W+1' | etc.
  staleness:            'fresh' | 'stale' | 'very_stale' | 'unknown';
  staleThresholdHours:  number;
  nextExpectedUpdate:   string;   // ISO datetime — estimated next update
  fetchStatus:          'success' | 'partial' | 'failed' | 'skipped';
}
```

### 2.3 Datapoint

```typescript
interface Datapoint {
  date:             string;       // YYYY-MM-DD (UTC business day)
  value:            number | null; // null for missing/holiday/failed
  status:           DatapointStatus;
  missingReason?:   MissingReason; // present only when value is null
  isRevised?:       boolean;       // true if this value differs from the originally reported value
  revisionCount?:   number;        // how many times this data point has been revised (≥1 if revised)
}

type DatapointStatus =
  | 'final'        // settlement price, no further revision expected
  | 'provisional'  // released but subject to revision within normal cycle
  | 'preliminary'  // early estimate, almost certain to be revised
  | 'revised'      // previously published value has been officially corrected
  | 'estimated'    // value computed by hub (e.g. interpolated) — not from source
  | 'missing';     // no value available for this date

type MissingReason =
  | 'market_holiday'     // all relevant markets were closed
  | 'fetch_failed'       // hub attempted to fetch but received no data
  | 'source_not_yet_published' // within normal publication lag, not yet available
  | 'data_gap'           // source has a known gap in historical coverage
  | 'weekend';           // non-business day in this series' schedule
```

---

## 3. oil-prices.json — Full Schema

**Path:** `exports/oil-project/oil-prices.json`  
**Benchmarks:** Brent Crude, WTI Crude, Dubai/Oman Crude  
**Coverage:** Rolling 90-day window + year-to-date (configurable)

```json
{
  "schemaVersion": "2.0",
  "exportType": "oil-prices",
  "generatedAt": "2026-05-14T06:12:00.000Z",
  "asOf": "2026-05-13",
  "coverageFrom": "2026-01-01",
  "frequencyNormalized": "daily",
  "dataHealth": {
    "allSeriesFresh": true,
    "staleSeriesCount": 0,
    "veryStaleSeriesCount": 0,
    "failedSeriesCount": 0,
    "staleSeriesIds": []
  },
  "series": [
    {
      "benchmarkId": "brent_crude",
      "name": "Brent Crude Oil",
      "assetClass": "commodity",
      "subClass": "crude_oil",
      "unit": "USD/barrel",
      "currency": "USD",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "eia",
      "freshness": {
        "lastUpdated": "2026-05-14T06:12:00.000Z",
        "lastDataPoint": "2026-05-13",
        "coverageFrom": "2026-01-01",
        "dataLag": "D+1",
        "staleness": "fresh",
        "staleThresholdHours": 36,
        "nextExpectedUpdate": "2026-05-15T06:00:00.000Z",
        "fetchStatus": "success"
      },
      "datapoints": [
        { "date": "2026-05-13", "value": 71.84, "status": "final" },
        { "date": "2026-05-12", "value": 73.21, "status": "final" },
        { "date": "2026-05-09", "value": 74.55, "status": "final" },
        { "date": "2026-05-08", "value": 75.10, "status": "final" }
      ]
    },
    {
      "benchmarkId": "wti_crude",
      "name": "WTI Crude Oil",
      "assetClass": "commodity",
      "subClass": "crude_oil",
      "unit": "USD/barrel",
      "currency": "USD",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "eia",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    },
    {
      "benchmarkId": "dubai_crude",
      "name": "Dubai/Oman Crude",
      "assetClass": "commodity",
      "subClass": "crude_oil",
      "unit": "USD/barrel",
      "currency": "USD",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "platts",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    }
  ]
}
```

---

## 4. gas-prices.json — Full Schema

**Path:** `exports/oil-project/gas-prices.json`  
**Benchmarks:** Henry Hub (USD/MMBtu), TTF (EUR/MWh), NBP (GBP/therm)  
**Note on units:** Gas benchmarks use heterogeneous units due to market convention. The export preserves native units with `unit` and `currency` fields. A future `usdEquivalent` field may be added alongside native values when FX data is available.

```json
{
  "schemaVersion": "2.0",
  "exportType": "gas-prices",
  "generatedAt": "2026-05-14T06:12:00.000Z",
  "asOf": "2026-05-13",
  "coverageFrom": "2026-01-01",
  "frequencyNormalized": "daily",
  "dataHealth": { "...": "same structure as oil-prices" },
  "series": [
    {
      "benchmarkId": "henry_hub",
      "name": "Henry Hub Natural Gas",
      "assetClass": "commodity",
      "subClass": "natural_gas",
      "unit": "USD/MMBtu",
      "currency": "USD",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "eia",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    },
    {
      "benchmarkId": "ttf_gas",
      "name": "TTF Natural Gas (Netherlands)",
      "assetClass": "commodity",
      "subClass": "natural_gas",
      "unit": "EUR/MWh",
      "currency": "EUR",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "ice",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    },
    {
      "benchmarkId": "nbp_gas",
      "name": "NBP Natural Gas (UK)",
      "assetClass": "commodity",
      "subClass": "natural_gas",
      "unit": "GBP/therm",
      "currency": "GBP",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "ice",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    }
  ]
}
```

---

## 5. lng-prices.json — Full Schema

**Path:** `exports/oil-project/lng-prices.json`  
**Benchmarks:** JKM (Japan-Korea Marker), TTF-LNG equivalent  
**Note:** JKM is a Platts-assessed price (requires licensing). Fallback: FRED series PNGASJPUSDM (monthly, lower resolution).

```json
{
  "schemaVersion": "2.0",
  "exportType": "lng-prices",
  "generatedAt": "2026-05-14T06:12:00.000Z",
  "asOf": "2026-05-13",
  "coverageFrom": "2026-01-01",
  "frequencyNormalized": "daily",
  "dataHealth": { "...": "same structure" },
  "series": [
    {
      "benchmarkId": "jkm_lng",
      "name": "JKM LNG Spot (Japan-Korea Marker)",
      "assetClass": "commodity",
      "subClass": "lng",
      "unit": "USD/MMBtu",
      "currency": "USD",
      "timezone": "UTC",
      "frequency": "daily",
      "source": "platts",
      "freshness": { "...": "same structure" },
      "datapoints": [ "..." ]
    }
  ]
}
```

---

## 6. structural.json — Schema (Future Phase 2)

**Path:** `exports/oil-project/structural.json`  
**Note:** Structural series have lower frequency than daily price benchmarks. Weekly, monthly, and annual data coexist in this file. Each series block declares its own `frequency`.

```json
{
  "schemaVersion": "2.0",
  "exportType": "structural",
  "generatedAt": "2026-05-14T06:12:00.000Z",
  "asOf": "2026-05-13",
  "coverageFrom": "2024-01-01",
  "frequencyNormalized": "mixed",
  "dataHealth": { "...": "same structure" },
  "series": [
    {
      "benchmarkId": "us_crude_inventory",
      "name": "US Commercial Crude Inventories",
      "assetClass": "structural",
      "subClass": "inventory",
      "unit": "million barrels",
      "currency": null,
      "timezone": "UTC",
      "frequency": "weekly",
      "frequencyNotes": "Published Wednesdays (EIA WPSR). Date is the week-ending Friday.",
      "source": "eia",
      "freshness": { "...": "same structure, staleThresholdHours: 168 (1 week)" },
      "datapoints": [
        { "date": "2026-05-09", "value": 441.8, "status": "preliminary" },
        { "date": "2026-05-02", "value": 433.6, "status": "final" }
      ]
    },
    {
      "benchmarkId": "opec_production",
      "name": "OPEC Total Crude Production",
      "assetClass": "structural",
      "subClass": "production",
      "unit": "million barrels per day",
      "currency": null,
      "timezone": "UTC",
      "frequency": "monthly",
      "frequencyNotes": "OPEC secondary source survey. Date is first of reporting month.",
      "source": "opec-monthly",
      "freshness": { "...": "same structure, staleThresholdHours: 744 (31 days)" },
      "datapoints": [
        { "date": "2026-05-01", "value": 26.81, "status": "provisional" },
        { "date": "2026-04-01", "value": 26.74, "status": "final" }
      ]
    }
  ]
}
```

---

## 7. Field Reference

| Field | Type | Required | Stability | Description |
|---|---|---|---|---|
| `schemaVersion` | string | yes | always '2.0' | Consumer must gate on this |
| `exportType` | string | yes | stable | Identifies which export contract |
| `generatedAt` | ISO datetime | yes | stable | When this file was generated |
| `asOf` | YYYY-MM-DD | yes | stable | Most recent date in this file |
| `coverageFrom` | YYYY-MM-DD | yes | stable | Earliest date in this file |
| `frequencyNormalized` | string | yes | stable | Output frequency of this file |
| `dataHealth.*` | object | yes | stable | Export-level data quality summary |
| `series[].benchmarkId` | string | yes | **immutable** | Primary join key — never changes |
| `series[].unit` | string | yes | **immutable** | Never changes for a given benchmarkId |
| `series[].currency` | string | yes | **immutable** | Never changes for a given benchmarkId |
| `series[].freshness` | object | yes | stable | Always present, always current |
| `series[].datapoints[].date` | YYYY-MM-DD | yes | stable | UTC business day |
| `series[].datapoints[].value` | number or null | yes | stable | null = missing/holiday/failed |
| `series[].datapoints[].status` | enum | yes | stable | Always present |
| `series[].datapoints[].isRevised` | boolean | no | stable | Present and true only when revised |
| `series[].datapoints[].revisionCount` | number | no | stable | Present only when revised |

**Immutable fields:** `benchmarkId`, `unit`, `currency` — these never change for a given benchmark. If a source changes units (e.g., a gas price switches from p/therm to USD/MMBtu), a new `benchmarkId` is created and the old one is marked deprecated.

---

## 8. Versioning Strategy

### 8.1 Schema versioning

`schemaVersion` follows semantic versioning semantics:
- **Major bump** (e.g., 2.0 → 3.0): breaking change — field renamed, removed, or type changed. Old files remain accessible for one migration window.
- **Minor bump** (e.g., 2.0 → 2.1): additive only — new optional fields. Consumers that ignore unknown fields are unaffected.
- Consumers MUST gate on the integer major version: `parseInt(schemaVersion.split('.')[0]) === 2`

### 8.2 BenchmarkId stability

`benchmarkId` values are permanent identifiers. They are never renamed. If a benchmark is retired, it carries `"deprecated": true` and `"deprecatedAt": "YYYY-MM-DD"` in its metadata. A deprecated benchmark continues to appear in exports for 6 months after retirement, then is removed.

### 8.3 Export file path stability

Export file paths are permanent. `exports/oil-project/oil-prices.json` will always be at that path for the oil project frontend. New exports are added at new paths; existing paths are never repurposed.

### 8.4 Data versioning (cache busting)

The export envelope includes a `dataFingerprint` field — a short hash of all series values in this export. If `dataFingerprint` is unchanged between two exports, the data content is identical. Consumers may use this as a lightweight cache key without parsing the full payload.

```json
{
  "dataFingerprint": "a3f2c891"
}
```

---

## 9. Consumer Contract Guarantees

1. **Parseable always.** Export files are always valid JSON. A malformed file is treated as an export failure and the previous file is not replaced.

2. **Envelope always present.** The top-level envelope fields (`schemaVersion`, `exportType`, `generatedAt`, `asOf`, `dataHealth`) are always present, even if all series are stale or failed.

3. **Null is explicit, not absent.** A missing data point is never omitted from the datapoints array — it is present with `"value": null` and an explicit `"status": "missing"`. Consumers must not infer a missing point from the absence of a date.

4. **benchmarkId order is not guaranteed.** Consumers must locate series by `benchmarkId`, not by array index.

5. **No interpolation by default.** The hub never fills missing values by interpolation unless a series is explicitly flagged `"interpolationPolicy": "linear"` in its metadata. All interpolated values carry `"status": "estimated"`.

6. **Revisions are surfaced, not hidden.** When a data point is revised, the export shows the current (revised) value with `"isRevised": true`. The prior value is not in the export — it is in the store's revision audit log. Frontends should display a revision indicator but not the old value.
