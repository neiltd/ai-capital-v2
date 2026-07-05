# Frequency Normalization Rules

**Status:** Design document — pre-implementation  
**Version:** 1.0  
**Date:** 2026-05-14  
**Parent:** historical_timeseries_architecture.md

---

## 1. Purpose

Commodity data arrives at heterogeneous frequencies from different sources: daily, weekly, monthly, quarterly, and annually. This document defines the rules for how the Data Hub:

1. Stores data at its native frequency
2. Normalizes frequency for export
3. Handles business day schedules (weekends, holidays)
4. Handles missing observations within a series
5. Handles timezone differences across global markets
6. Specifies when interpolation is permitted
7. Distinguishes structural datasets from high-frequency datasets in exports

---

## 2. Timezone Normalization

**Rule: All stored and exported dates are UTC calendar dates.**

### 2.1 Date normalization

A commodity settlement price is anchored to the **trading session date in its primary market**, then converted to UTC calendar date for storage:

| Benchmark | Primary market | Session time | UTC date rule |
|---|---|---|---|
| Brent Crude | ICE London | 08:00–22:30 UTC | Session date = UTC date |
| WTI Crude | NYMEX New York | 13:00–20:00 UTC | Session date = UTC date |
| Dubai Crude | Platts Singapore | 16:30 Asia/Singapore = 08:30 UTC | Session date = UTC calendar date of 08:30 UTC |
| Henry Hub | NYMEX New York | 13:00–20:00 UTC | Session date = UTC date |
| JKM LNG | Platts Singapore | Assessment as of 16:30 Asia/Singapore | Session date = UTC calendar date |
| TTF Natural Gas | ICE Amsterdam | 07:00–17:00 CET | UTC date of 07:00 CET opening |
| NBP Natural Gas | ICE London | 07:00–17:00 GMT/BST | UTC date |

**Edge case — Singapore:** Platts publishes Singapore assessments dated in Asia/Singapore time (UTC+8). A Singapore date of 2026-05-14 at 16:30 local = 2026-05-14 08:30 UTC. Both sides are the same UTC calendar date. No conversion needed for daily prices. If Platts uses a late-session timestamp that crosses UTC midnight (unlikely for daily assessments), use the UTC calendar date of the session opening, not the settlement time.

### 2.2 No local time stored

The `date` field in storage and exports is always a `YYYY-MM-DD` string representing the UTC calendar date of the trading session. No timestamp, no timezone offset. This is intentional — settlement prices are daily anchored values, not point-in-time values.

### 2.3 Fetched-at timestamps

`fetchedAt` (stored internally, not exported) is a full ISO datetime with UTC timezone: `2026-05-14T06:12:00.000Z`. This records when the hub fetched the data, not when the price was established.

---

## 3. Business Day Schedules

### 3.1 Market calendars

Each benchmark has an associated market calendar. Data is expected only on business days of that market. Missing data on a non-business day is `status: "missing"`, `missingReason: "market_holiday"` or `missingReason: "weekend"`.

The hub maintains a simple in-memory holiday calendar per market, updated annually:

```typescript
// lib/market-calendars.ts (future)
const LONDON_HOLIDAYS_2026 = new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
const NEW_YORK_HOLIDAYS_2026 = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
const SINGAPORE_HOLIDAYS_2026 = new Set(['2026-01-01', '2026-01-28', '2026-01-29', '2026-04-03', '2026-05-01', '2026-05-12', '2026-08-09', '2026-10-26', '2026-12-25']);
```

### 3.2 Multi-market holidays

If a price is quoted across multiple markets (e.g., Brent is traded on ICE London but referenced globally), the hub uses the **primary market's holiday schedule**. If the primary market is closed, no data is expected regardless of whether other markets are open.

### 3.3 Weekends

Saturday and Sunday are never business days for any current benchmark. A weekend date is represented as `status: "missing"`, `missingReason: "weekend"`.

**Policy on weekend gaps in exports:** Weekend gaps are included in the exported datapoints array. Consumers must handle null values on Saturday and Sunday. Frontends should skip nulls when plotting continuous lines.

---

## 4. High-Frequency vs. Structural Frequency Handling

### 4.1 High-frequency benchmarks (daily)

**Examples:** Brent, WTI, Dubai, Henry Hub, JKM, TTF, NBP

Rules:
- Data is stored for every business day
- Weekends and holidays are stored as null with appropriate `missingReason`
- The datapoints array in exports is **dense**: no date gaps within the coverage window
- Consumers can iterate the array and assume dates are continuous (calendar daily), with nulls for non-business days

### 4.2 Structural benchmarks (weekly, monthly, annual)

**Examples:** US crude inventories (weekly), OPEC production (monthly), proved reserves (annual)

Rules:
- Data is stored only for publication dates — the array is **sparse**
- The `date` field for weekly data is the reporting period's **end date** (week-ending Friday for EIA inventory)
- The `date` field for monthly data is the **first day of the reporting month** (2026-05-01 = May 2026 data)
- The `date` field for annual data is **YYYY-01-01** (2025-01-01 = 2025 annual data)
- No null-filled gaps between publications — absence of a date means the next publication is not yet available
- `frequencyNotes` in the series block documents the date convention

**Structural series date convention — explicit rules:**

| Series | Date field meaning | Example |
|---|---|---|
| EIA weekly crude inventory | Week-ending date (always a Friday) | `2026-05-08` = week ending 8 May |
| OPEC monthly production | First day of reporting month | `2026-04-01` = April 2026 |
| BP proved reserves | January 1 of the reference year | `2025-01-01` = 2025 annual data |
| CFTC COT positions | Friday reporting date | `2026-05-09` = positions as of 9 May |

---

## 5. Missing Data Policy

### 5.1 Definitions

| Status | Meaning | Value in datapoints |
|---|---|---|
| `market_holiday` | Primary market closed — no price expected | `null` |
| `weekend` | Saturday or Sunday | `null` |
| `source_not_yet_published` | Within normal lag window — data coming soon | `null` |
| `fetch_failed` | Hub attempted fetch, source returned no data | `null` |
| `data_gap` | Known historical gap in source coverage | `null` |

### 5.2 Missing data is explicit, never absent

A null value within the coverage window is **always included** in the datapoints array as an explicit entry:

```json
{ "date": "2026-05-10", "value": null, "status": "missing", "missingReason": "weekend" }
```

A date that falls outside the coverage window (`coverageFrom` to `asOf`) is simply not present in the array. Consumers should not interpret absence-outside-coverage as null.

### 5.3 Consecutive missing data escalation

If a non-holiday, non-weekend date has `value: null` for more than 2 consecutive business days, the series is flagged `staleness: "stale"`. After 5 consecutive business days, `staleness: "very_stale"`. This threshold is configurable per series in metadata.

---

## 6. Interpolation Policy

**Default policy: no interpolation.**

The Data Hub does not fill missing values by default. If a daily price is unavailable for a given date, the datapoint is `null`. Frontends are responsible for handling null values in their charts (typically: break the line, or carry forward the last known value as a visual choice — not as a data assertion).

### 6.1 Exception: carry-forward for export

Some frontend views require a continuous line without gaps. For these cases, the export may optionally include a **carry-forward** value alongside the null:

```json
{
  "date": "2026-04-18",
  "value": null,
  "status": "missing",
  "missingReason": "market_holiday",
  "carryForwardValue": 78.42,
  "carryForwardDate": "2026-04-17"
}
```

The `carryForwardValue` is not a data assertion — it is a frontend rendering convenience. Consumers that care about data accuracy must use `value`, not `carryForwardValue`.

**This is opt-in per series.** Only series with `"interpolationPolicy": "carry_forward_for_export": true` in metadata will include this field.

### 6.2 Interpolation for historical backfill gaps

When backfilling historical data and a source has a known gap (e.g., a specific week is missing from EIA's API), the hub does NOT interpolate. The gap is stored as null with `missingReason: "data_gap"`. This is preferable to making up values.

### 6.3 No linear interpolation

Linear interpolation is never performed by the hub. If a future requirement genuinely needs interpolated values (e.g., converting monthly OPEC data to daily for correlation with daily prices), this must be:
1. Implemented as an explicit, named export field (not replacing the native value)
2. Labeled with `status: "estimated"` and `estimationMethod: "linear_interpolation"` or similar
3. Documented in the series metadata

---

## 7. Downsampling Rules

When a frontend chart wants weekly or monthly aggregates from daily data, this is the frontend's responsibility. The Data Hub exports daily data; aggregation is a rendering concern.

**Exception:** For cross-frequency comparison exports (future), where daily prices are joined against monthly structural data, the Data Hub may produce a monthly-aggregated derivative series alongside the daily series. These carry:
- `frequency: "monthly"`
- `aggregationMethod: "last_business_day_of_month"` (or `"arithmetic_mean"` or `"period_average"`)
- `derivedFrom: "brent_crude"` (reference to the source daily series)

Aggregation methods by series type:
- Price series: `last_business_day_of_month` (mirrors how financial data is typically reported)
- Volume/inventory series: `period_sum` or `period_average` depending on whether the measure is a stock or a flow
- Production series: `period_average`

---

## 8. Upsampling Rules (Structural → Daily Alignment)

When structural monthly data (e.g., OPEC production at 26.8 Mbpd for April) is displayed alongside daily Brent prices, consumers need to "expand" the monthly value across the month.

The Data Hub does not perform this upsampling in the export. The structural series export gives one data point per reporting period. Frontends align by:
- Rendering the monthly value as a horizontal band or step function across the relevant dates
- Never treating a monthly value as a specific-day value

If the Data Hub produces a joined cross-asset export in the future, structural values will be annotated with `periodStart` and `periodEnd` fields to make the alignment explicit:

```json
{
  "date": "2026-04-01",
  "periodStart": "2026-04-01",
  "periodEnd": "2026-04-30",
  "value": 26.81,
  "status": "provisional"
}
```

---

## 9. Frequency Normalization Summary Table

| Series | Native frequency | Export frequency | Weekend policy | Holiday policy | Missing policy |
|---|---|---|---|---|---|
| Brent Crude | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| WTI Crude | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| Dubai Crude | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| Henry Hub | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| JKM LNG | Daily (weekdays) | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| TTF Natural Gas | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| NBP Natural Gas | Daily | Daily | null + weekend | null + market_holiday | null + fetch_failed |
| US Crude Inventory | Weekly (Friday) | Weekly | N/A (sparse) | Delayed to next week | null + fetch_failed |
| OPEC Production | Monthly | Monthly | N/A (sparse) | N/A | null + source_not_yet_published |
| Proved Reserves | Annual | Annual | N/A (sparse) | N/A | null + source_not_yet_published |
