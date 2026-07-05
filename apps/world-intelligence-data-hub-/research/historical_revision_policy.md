# Historical Revision Policy

**Status:** Design document — pre-implementation  
**Version:** 1.0  
**Date:** 2026-05-14  
**Parent:** historical_timeseries_architecture.md

---

## 1. Why Revisions Happen

Commodity and energy data is routinely revised after initial publication:

| Source | Revision pattern | Typical frequency | Magnitude |
|---|---|---|---|
| EIA Weekly Petroleum | Preliminary → final | 4 weeks after initial | 1–5% |
| EIA Monthly Production | Provisional → revised → final | 2–6 months | Up to 10% |
| OPEC production surveys | Secondary source → official | 30–60 days | 2–8% |
| Platts spot assessments | Rarely revised; corrections issued | Ad hoc | Material |
| IEA Oil Market Report | Monthly supply estimates revised | Each monthly release | 0.5–3% |
| BP Statistical Review | Annual data revised in subsequent editions | Annually | 1–5% |

Revisions are not errors — they are a structural property of official energy statistics. The hub must handle them non-destructively and communicate them accurately to consumers.

---

## 2. Revision Lifecycle

### 2.1 Typical lifecycle of a data point

```
D+0  Source publishes preliminary value (e.g., EIA Wednesday report)
     hub fetches → stores as status: "preliminary"

D+7  Source publishes week-2 report with revised prior-week value
     hub detects change → logs revision → updates status to "revised"

D+28 Source publishes month-end reconciliation
     hub detects change → logs revision → updates status to "final"

D+28+ No further revisions expected → status remains "final"
```

### 2.2 Status progression

Status transitions are strictly forward — a data point never goes backward:

```
preliminary → provisional → final       (normal path for EIA weekly)
preliminary →    revised  → final       (if revised before becoming final)
provisional →    revised  → final
final       →    revised               (rare — only for corrections)
```

A `revised` data point that later receives another revision becomes `revised` again (the status remains `revised`; `revisionCount` increments). A `final` data point is not expected to change, but may be corrected if the source issues an official erratum.

---

## 3. Non-Destructive Revision Storage

The canonical value in the annual data file is always the **most recent authoritative value**. Revision history is stored separately in the `revisions/` subdirectory.

### 3.1 Annual data file (canonical)

When a revision is detected, the annual file is updated in-place:

**Before revision:**
```json
{
  "date":      "2026-04-25",
  "value":     433.6,
  "status":    "preliminary",
  "version":   1,
  "fetchedAt": "2026-04-30T06:12:00.000Z",
  "source":    "eia"
}
```

**After revision:**
```json
{
  "date":         "2026-04-25",
  "value":        436.2,
  "status":       "final",
  "version":      2,
  "fetchedAt":    "2026-04-30T06:12:00.000Z",
  "source":       "eia",
  "lastRevisedAt": "2026-05-07T06:15:00.000Z",
  "revisionCount": 1
}
```

The previous value (433.6) is **not in the annual file**. It is in the revision log.

### 3.2 Revision audit log

One revision log file per revision date, stored at:
`store/timeseries/commodities/{benchmarkId}/revisions/{YYYY-MM-DD}.json`

Where `YYYY-MM-DD` is the date the revision was detected by the hub.

```json
{
  "benchmarkId": "us_crude_inventory",
  "revisionDetectedAt": "2026-05-07T06:15:00.000Z",
  "revisedBy": "eia",
  "entries": [
    {
      "dataDate":     "2026-04-25",
      "priorValue":   433.6,
      "priorStatus":  "preliminary",
      "priorVersion": 1,
      "newValue":     436.2,
      "newStatus":    "final",
      "newVersion":   2,
      "deltaAbsolute": 2.6,
      "deltaPct":      0.60
    },
    {
      "dataDate":     "2026-04-18",
      "priorValue":   437.1,
      "priorStatus":  "final",
      "newValue":     437.3,
      "newStatus":    "revised",
      "newVersion":   2,
      "deltaAbsolute": 0.2,
      "deltaPct":      0.05
    }
  ]
}
```

Multiple data points can be revised in a single publication — they are all recorded in one revision log file for that detection date.

---

## 4. Revision Detection Algorithm

The hub detects a revision by comparing the newly fetched value against the stored value for each data point in the fetch window.

```typescript
function detectRevisions(
  stored:    Datapoint[],
  fetched:   FetchedDatapoint[],
  threshold: number = 0.001,  // 0.1% difference threshold — avoids floating-point noise
): RevisionEntry[] {
  const revisions: RevisionEntry[] = [];
  for (const f of fetched) {
    const s = stored.find(d => d.date === f.date);
    if (!s || s.value === null) continue;
    if (f.value === null) continue;
    const delta = Math.abs(f.value - s.value) / s.value;
    if (delta > threshold) {
      revisions.push({ dataDate: f.date, priorValue: s.value, newValue: f.value, ... });
    }
  }
  return revisions;
}
```

The `threshold` prevents spurious revision detection from floating-point representation differences. Different series may have different thresholds:
- Price series (USD/barrel): 0.01 (1%) — prices rarely change by less than 1% due to data errors
- Inventory/production series (Mbpd): 0.001 (0.1%) — small revisions are meaningful

---

## 5. Consumer-Facing Revision Signals

### 5.1 In the export

Consumers see only the current canonical value. The export surfaces revision presence without exposing the old value:

```json
{
  "date":          "2026-04-25",
  "value":         436.2,
  "status":        "final",
  "isRevised":     true,
  "revisionCount": 1
}
```

`isRevised: true` signals to the frontend that this data point was not always 436.2 — it was initially published as a different value. Frontends may display a small indicator (e.g., a `~` marker or tooltip "data revised") but must not show the prior value in the chart.

### 5.2 Frontend display guidance

This document does not prescribe frontend rendering behavior. The export contract provides:
- `isRevised` — whether to show a revision indicator
- `revisionCount` — how many times it was revised (for context in a tooltip)
- `status` — the current authority of the value (`preliminary`, `provisional`, `final`, `revised`)

The frontend decides how to style these. This is a rendering concern, not a data concern.

### 5.3 Revision metadata not in export

The prior value, delta, and revision history are **not in the export file**. This information is in the store's revision audit log (`store/timeseries/.../revisions/`). If a future use case requires revision history in the export (e.g., a "revision waterfall" visualization), a dedicated `revision-history.json` export can be added without modifying the main export contract.

---

## 6. Status Field Semantics — Full Reference

| Status | Set by | Meaning | Likely to be revised? |
|---|---|---|---|
| `preliminary` | Hub on initial fetch | Source marked preliminary, or hub infers from lag position | Very likely — usually revised within 1–4 weeks |
| `provisional` | Hub on fetch after preliminary window | Source published but within revision window | Likely — within normal revision cycle |
| `final` | Hub after revision window closes | Source has made final determination | Rarely — only via official erratum |
| `revised` | Hub on revision detection | A previously stored value was changed | May be revised again |
| `estimated` | Hub explicitly | Value was computed by hub, not from source | Always — estimated values can be updated when real data arrives |
| `missing` | Hub | No value available | N/A — replaced if/when source publishes |

### 6.1 Status inference rules

For sources that do not explicitly label their data as preliminary/final, the hub infers status from the lag position:

```typescript
function inferStatus(
  dataDate:    string,  // YYYY-MM-DD
  fetchedAt:   string,  // ISO datetime
  lag:         string,  // 'D+1', 'W+4', 'M+2', etc.
  revisionWindow: string, // 'W+4', 'M+3', etc.
): DatapointStatus {
  const age = daysSince(dataDate, fetchedAt);
  const lagDays  = parseLagDays(lag);
  const revDays  = parseLagDays(revisionWindow);

  if (age < lagDays * 1.5)  return 'preliminary';
  if (age < revDays)        return 'provisional';
  return 'final';
}
```

EIA's explicit weekly inventory data carries the source's own preliminary/final labels. These take precedence over inferred status.

---

## 7. Handling Source Corrections (Errata)

An official erratum is a correction to data that was previously marked `final`. These are rare but do occur (e.g., a transcription error in a historical series).

**Policy:**
1. Hub detects correction via routine fetch (value changed for a `final` data point)
2. Correction is logged in the revision audit log with `correctionType: "official_erratum"`
3. The data point status changes from `final` → `revised`
4. The annual data file is updated
5. The export carries `isRevised: true`, `revisionCount` incremented

Corrections to data older than 90 days are flagged separately in the revision log with `isHistoricalCorrection: true`, so operators can inspect unusual activity.

---

## 8. Backfill Revision Policy

When the hub backfills historical data (e.g., onboarding a new benchmark with 5 years of history), it fetches the current published values — which are already the final/revised values as of today. No revision log entries are created for backfill, because the hub has no prior stored values to compare against.

Backfill data points are stored with:
- `status: "final"` if within the source's normal revision window + buffer
- `version: 1`
- A special `backfillAt` field (ISO datetime) instead of `fetchedAt` to distinguish backfill from live fetch

Subsequent live fetches may revise backfill data if the source continues to publish revisions. This is handled identically to live-data revisions.

---

## 9. Revision Monitoring and Alerting

The run log records a summary of revisions detected in each export run:

```json
{
  "run": "2026-05-14T06:12:00.000Z",
  "revisionsDetected": [
    {
      "benchmarkId":   "us_crude_inventory",
      "dataDate":      "2026-04-25",
      "priorValue":    433.6,
      "newValue":      436.2,
      "deltaPct":      0.60,
      "newStatus":     "final"
    }
  ],
  "historicalCorrections": [],
  "largeRevisionsDetected": []
}
```

A **large revision** is defined as `|deltaPct| > 3%` for price series or `|deltaPct| > 5%` for structural series. Large revisions are flagged for human review — they may indicate a source error rather than a legitimate revision.

---

## 10. Summary of Key Policy Decisions

| Decision | Policy |
|---|---|
| Revision storage | Non-destructive — prior values in audit log, canonical value in annual file |
| Consumer visibility | Current value only — `isRevised` flag, no prior value exposed |
| Revision detection | Compare fetched vs stored; 0.1% threshold to avoid float noise |
| Status inference | From source label if available; else from lag position |
| Final data revisions | Permitted (official errata); flagged distinctly |
| Backfill revisions | No revision log on first backfill; tracked as live data on subsequent fetches |
| Interpolation | Never on revision handling; missing values stay null |
| Large revision alerting | Flag for human review at >3% for price series |
