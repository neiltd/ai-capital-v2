# Historical Commodity Time-Series Architecture

**Status:** Design document — pre-implementation  
**Version:** 1.0  
**Date:** 2026-05-14  
**Scope:** Data Hub canonical storage and export layer for commodity and energy time-series

---

## 1. Philosophy and Ownership Boundaries

### 1.1 The Data Hub is the canonical source of truth

All commodity time-series data lives in the Data Hub. Frontends are read-only consumers of exported JSON files. No frontend may:

- Call commodity data APIs directly
- Own historical datasets in their source tree
- Perform normalization, revision handling, or interpolation
- Cache data beyond a rolling local demo snapshot

The consequence is that the Data Hub's export layer fully defines what frontends can display. If a benchmark is not in the export, it does not exist on the frontend.

### 1.2 Separation of internal store from external contract

The internal store format is optimized for efficient append, revision safety, and queryability. The external export format is optimized for frontend consumption: camelCase, self-describing, ready to parse without transformation.

These two formats are distinct and bridged by the same mapper pattern as the intelligence event pipeline.

### 1.3 Structural datasets vs. high-frequency datasets

Two fundamentally different data classes exist in this domain:

| Class | Examples | Update cadence | Revision risk | Storage strategy |
|---|---|---|---|---|
| **High-frequency** | Brent/WTI/Dubai daily prices, Henry Hub, JKM LNG spot | Daily (business days) | Low (settlement prices are near-final) | Append-only daily files per year |
| **Structural** | Proved reserves, OPEC quotas, pipeline capacity, national production capacity | Monthly / annually / on-event | High (officially revised repeatedly) | Versioned snapshot files with revision audit log |

High-frequency data grows predictably: ~250 data points/year/series. Structural data is sparse but revision-intensive and must preserve its history.

---

## 2. Asset Taxonomy

### 2.1 Supported benchmarks — Phase 1

| benchmarkId | Name | Native frequency | Unit | Primary source |
|---|---|---|---|---|
| `brent_crude` | Brent Crude Oil (ICE front-month) | Daily | USD/barrel | EIA |
| `wti_crude` | WTI Crude Oil (NYMEX front-month) | Daily | USD/barrel | EIA |
| `dubai_crude` | Dubai/Oman Crude | Daily | USD/barrel | Platts/S&P |
| `henry_hub` | Henry Hub Natural Gas | Daily | USD/MMBtu | EIA |
| `jkm_lng` | Japan-Korea Marker LNG | Daily | USD/MMBtu | Platts/S&P |
| `ttf_gas` | TTF Natural Gas (Dutch hub) | Daily | EUR/MWh | ICE/EIA |
| `nbp_gas` | NBP Natural Gas (UK) | Daily | GBP/therm | ICE |

### 2.2 Supported benchmarks — Phase 2 (future)

| benchmarkId | Name | Asset class |
|---|---|---|
| `gold_spot` | Gold Spot (LBMA AM) | Precious metal |
| `copper_lme` | LME Copper (3-month) | Base metal |
| `us_crude_inventory` | US Commercial Crude Inventories | Structural |
| `opec_production` | OPEC Total Production | Structural |
| `us_crude_production` | US Field Production of Crude Oil | Structural |
| `hormuz_transit` | Strait of Hormuz Transit Volume | Structural |
| `sp500` | S&P 500 Index | Equity index |
| `vix` | CBOE VIX | Volatility |

### 2.3 Asset class taxonomy

```
assetClass:
  commodity
    energy
      crude_oil
      natural_gas
      lng
    precious_metal
    base_metal
    agricultural
  equity_index
  volatility
  structural
    inventory
    production
    capacity
    reserves
```

---

## 3. Canonical Storage Layout

### 3.1 Directory structure

```
store/
  timeseries/                          ← NEW — parallel to existing raw/normalized/validated
    commodities/
      {benchmarkId}/
        metadata.json                  ← series identity, source config, units, status
        YYYY.json                      ← all data points for that calendar year
        revisions/
          YYYY-MM-DD.json              ← revision audit entries logged on the date of revision
    structural/
      {benchmarkId}/
        metadata.json
        snapshots/
          YYYY-MM.json                 ← monthly snapshot of the full current series
        revisions/
          YYYY-MM-DD.json

exports/
  oil-project/
    oil-prices.json                    ← daily prices: Brent, WTI, Dubai (rolling 90-day + YTD)
    gas-prices.json                    ← daily prices: Henry Hub, TTF, NBP (rolling 90-day + YTD)
    lng-prices.json                    ← daily prices: JKM, TTF LNG equivalent (rolling 90-day + YTD)
  [future]
    multi-asset.json                   ← cross-asset export for correlation views
    structural.json                    ← structural datasets (production, inventory, capacity)
```

### 3.2 Metadata file format

`store/timeseries/commodities/brent_crude/metadata.json`

```json
{
  "benchmarkId":     "brent_crude",
  "name":            "Brent Crude Oil",
  "description":     "ICE Brent front-month futures settlement price",
  "assetClass":      "commodity",
  "subClass":        "crude_oil",
  "unit":            "USD/barrel",
  "currency":        "USD",
  "timezone":        "UTC",
  "frequency":       "daily",
  "frequencyNotes":  "Business days only. Weekends and holidays produce no data point.",
  "source": {
    "primary":       "eia",
    "seriesId":      "PET.RBRTE.D",
    "apiEndpoint":   "https://api.eia.gov/v2/petroleum/pri/spt/data/",
    "lag":           "D+1",
    "typicalPublishTime": "16:30 UTC"
  },
  "fallbackSources": [
    { "source": "fred", "seriesId": "DCOILBRENTEU" }
  ],
  "coverageFrom":    "2010-01-04",
  "activeSince":     "2010-01-04",
  "schemaVersion":   "1.0",
  "lastModified":    "2026-05-14T06:00:00.000Z"
}
```

### 3.3 Annual data file format

`store/timeseries/commodities/brent_crude/2026.json`

```json
{
  "benchmarkId": "brent_crude",
  "year": 2026,
  "datapoints": [
    {
      "date":    "2026-01-02",
      "value":   80.42,
      "status":  "final",
      "version": 1,
      "fetchedAt": "2026-01-03T06:00:00.000Z",
      "source":  "eia"
    },
    {
      "date":    "2026-01-03",
      "value":   79.88,
      "status":  "final",
      "version": 1,
      "fetchedAt": "2026-01-04T06:00:00.000Z",
      "source":  "eia"
    }
  ],
  "lastModified": "2026-05-14T06:00:00.000Z"
}
```

`status` values: `preliminary` | `provisional` | `final` | `revised` | `estimated` | `missing`  
`version` is incremented on each revision to this data point.

---

## 4. Update Cadence Policy

### 4.1 Scheduled update windows

| Series class | Schedule | Window | Notes |
|---|---|---|---|
| Daily price benchmarks | Every business day | 06:00–08:00 UTC | D+1 for prior business day's settlement |
| EIA weekly petroleum | Thursday 16:30 UTC | Thursday 17:00 UTC fetch | Covers week ending prior Friday |
| OPEC monthly report | Day after publication (~10th of month) | Morning UTC fetch | |
| IEA Oil Market Report | Day after publication (~15th of month) | Morning UTC fetch | |
| BP Statistical Review | Day after publication (June, annually) | Manual trigger | |

### 4.2 Business day definition

Business days follow the union of:
- London (ICE Brent, NBP, TTF)
- New York (NYMEX WTI, EIA reports)
- Singapore (Dubai, JKM)

If any of these markets is open, data is expected. Global holidays (Christmas, New Year) where all three are closed produce no data and are recorded as `status: "missing"` with `missingReason: "market_holiday"`.

### 4.3 Missed update handling

If a scheduled fetch produces no data where data was expected:

1. The day's slot is written as `{ "value": null, "status": "missing", "missingReason": "fetch_failed" }`
2. The series `freshness.staleness` is set to `"stale"` after 1.5× the expected period
3. The series `freshness.staleness` is set to `"very_stale"` after 3× the expected period
4. Export files are still written — stale series are included with their last known value and `staleness` flag
5. A structured warning is written to the run log
6. No export file is withheld due to one series being stale

---

## 5. Freshness Metadata Standards

Every series in every export carries a `freshness` object:

```json
{
  "freshness": {
    "lastUpdated":        "2026-05-14T06:12:00.000Z",
    "lastDataPoint":      "2026-05-13",
    "coverageFrom":       "2010-01-04",
    "dataLag":            "D+1",
    "staleness":          "fresh",
    "staleThresholdHours": 36,
    "nextExpectedUpdate": "2026-05-15T06:00:00.000Z",
    "source":             "eia",
    "fetchAttempts":      1,
    "fetchStatus":        "success"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `lastUpdated` | ISO datetime | When this series was last successfully fetched |
| `lastDataPoint` | YYYY-MM-DD | Date of the most recent non-null data point |
| `coverageFrom` | YYYY-MM-DD | Earliest date available in the store |
| `dataLag` | string | Typical source lag ("D+1", "D+2", "W+1", "M+10d") |
| `staleness` | enum | `fresh` / `stale` / `very_stale` / `unknown` |
| `staleThresholdHours` | number | Hours after `lastUpdated` before `staleness` becomes `stale` |
| `nextExpectedUpdate` | ISO datetime | Estimated time of next data point availability |
| `source` | string | Which source produced the last successful fetch |
| `fetchAttempts` | number | Number of fetch attempts in last scheduled window |
| `fetchStatus` | enum | `success` / `partial` / `failed` / `skipped` |

Staleness is computed at export time, not stored. A series last updated at T is:
- `fresh` if now < T + staleThresholdHours
- `stale` if T + staleThresholdHours ≤ now < T + 2 × staleThresholdHours
- `very_stale` if now ≥ T + 2 × staleThresholdHours

---

## 6. Fallback and Export Resilience Strategy

### 6.1 Source fallback chain

Each benchmark defines a fallback source chain in `metadata.json`. When the primary source fails:

1. Try each fallback source in order
2. If a fallback succeeds, record `source: "fallback_source_id"` and `fetchStatus: "partial"`
3. If all sources fail, write null for that date with `status: "missing"`, `missingReason: "all_sources_failed"`
4. The fallback used is noted in the series `freshness.source` field

### 6.2 Export-always guarantee

Export files are always generated, even when:
- One or more series have failed to update
- Some data points are null/missing
- A series is very stale

Frontends must handle `null` values and respect `freshness.staleness`. Displaying stale data with appropriate UI indication is preferable to failing silently.

### 6.3 Partial export metadata

The export envelope includes a `dataHealth` summary:

```json
{
  "dataHealth": {
    "allSeriesFresh": false,
    "staleSeriesCount": 1,
    "veryStaleSeriesCount": 0,
    "failedSeriesCount": 0,
    "staleSeriesIds": ["ttf_gas"]
  }
}
```

---

## 7. Future Compatibility Hooks

### 7.1 Cross-commodity correlation

All series share the same date indexing (UTC business day). Joining two series for correlation requires no date transformation — dates align natively. The `benchmarkId` is the join key for cross-commodity analysis.

### 7.2 Geopolitical overlay linkage

Intelligence events carry `date` and `countries` fields. Commodity prices carry `date`. Joining by date range produces the geopolitical overlay: "what commodity price changes occurred in the 7 days following this event?" No schema changes required — the date is the natural join key.

### 7.3 Macro correlation

Structural datasets (OPEC production, US inventories) export alongside price series with the same date convention. Macro indicators from the World Bank (already in the hub as `macro-indicators.json`) use YYYY date strings which are downsampled to annual. The hub can join annual averages of daily price series against annual macro indicators by year string.

### 7.4 Supply-chain linkage

The `benchmarkId` hierarchy (`assetClass → subClass`) allows supply-chain traversal: a crude oil disruption event can fan out to LNG (via feedstock price), copper (via energy-intensive mining costs), and fertilizers (via natural gas as feedstock). Linkage is encoded in a future `supply_chain_links` field on each benchmark's metadata — a list of `benchmarkId`s that are downstream.

### 7.5 Equity integration

When equity/index benchmarks are added in Phase 2, they follow identical schema. The `assetClass: "equity_index"` distinguishes them from commodities. Cross-asset exports (e.g., `multi-asset.json`) merge series from multiple asset classes by date.

---

## 8. Implementation Phases

### Phase 1 — Foundation (implement next)
1. Define `store/timeseries/` directory structure and write `PATHS.timeseries.*` constants
2. Implement `TimeseriesStore` class: `append(benchmarkId, date, value, status)`, `getYear(benchmarkId, year)`, `getRange(benchmarkId, from, to)`
3. Implement `TimseriesExporter`: reads store, computes freshness, writes `oil-prices.json`, `gas-prices.json`, `lng-prices.json`
4. Add EIA connector for Phase 1 benchmarks (Brent, WTI, Henry Hub)
5. Wire into `run-exports.ts`

### Phase 2 — Structural datasets
1. Implement structural store with snapshot + revision log
2. Add OPEC, IEA connectors
3. Add `structural.json` export

### Phase 3 — Multi-asset
1. Add gold, copper, equity index benchmarks
2. Add `multi-asset.json` export
3. Add geopolitical overlay join utility

---

## 9. Open Questions Before Implementation

1. **EIA API key:** Does the team have a registered EIA API v2 key? The EIA endpoint requires registration. Alternative: FRED (Federal Reserve Economic Data) has Brent and WTI as free public series.

2. **Platts/S&P access for Dubai/JKM:** Dubai crude and JKM LNG are Platts-proprietary. Licensing cost is non-trivial. Are these in scope for Phase 1 or Phase 2?

3. **Historical backfill depth:** How far back should Phase 1 backfill? 1 year covers most frontend use cases. 5 years enables trend analysis. 15 years enables full-cycle analysis. Storage implications are minor (daily prices are ~5KB/series/year).

4. **Intraday vs. settlement:** This architecture assumes end-of-day settlement prices. If the oil frontend ever needs intraday or near-real-time prices, the update cadence and storage model need to change significantly. Confirm this is out of scope.

5. **TTF/NBP in EUR/GBP:** TTF is quoted in EUR/MWh and NBP in GBP/therm. Should the hub normalize all gas prices to USD/MMBtu for cross-commodity comparability, or preserve native units and let frontends convert? Recommendation: store native, export native with unit field, and optionally add a `usdEquivalent` alongside when FX data is available.
