// Internal types for the timeseries ingestion pipeline.
// These are NOT the external consumer types — see intelligence/exports/contract/external-types.ts.

export type DatapointStatus =
  | 'final' | 'provisional' | 'preliminary' | 'revised' | 'estimated' | 'missing';

// ── Benchmark configuration ───────────────────────────────────────────────────
// Loaded from benchmark-configs.ts. Written to store metadata files on first run.

export interface BenchmarkConfig {
  benchmarkId:         string;
  name:                string;
  assetClass:          string;
  subClass:            string;
  unit:                string;
  currency:            string;
  frequency:           'daily' | 'weekly' | 'monthly';
  source:              string;
  dataLag:             string;         // 'D+1', 'D+2', 'W+1', etc.
  staleThresholdHours: number;
  revisionWindowDays:  number;         // days after which a provisional becomes final
  revisionThreshold:   number;         // fractional change below which we ignore (float noise)
  coverageFrom?:       string;         // YYYY-MM-DD — earliest stored point (set after first fetch)
  // EIA-specific
  eia?: {
    route:    string;                  // e.g. 'petroleum/pri/spt/data/'
    seriesId: string;                  // e.g. 'RBRTE'
  };
}

// ── Datapoint shapes ──────────────────────────────────────────────────────────

// What the connector returns after normalizing API data
export interface FetchedDatapoint {
  date:      string;         // YYYY-MM-DD
  value:     number | null;
  source:    string;
  fetchedAt: string;         // ISO datetime
}

// What lives on disk in store/timeseries/commodities/{id}/{YYYY}.json
export interface StoredDatapoint {
  date:          string;
  value:         number | null;
  status:        DatapointStatus;
  version:       number;     // 1 on first write; incremented on each revision
  fetchedAt:     string;     // ISO datetime of first fetch
  source:        string;
  lastRevisedAt?: string;    // ISO datetime of most recent revision
  revisionCount?: number;    // absent until first revision
}

// ── Year file shape ───────────────────────────────────────────────────────────

export interface YearFile {
  benchmarkId:  string;
  year:         number;
  datapoints:   StoredDatapoint[];
  lastModified: string;  // ISO datetime
}

// ── Revision audit log ────────────────────────────────────────────────────────

export interface RevisionEntry {
  dataDate:       string;
  priorValue:     number | null;
  priorStatus:    DatapointStatus;
  priorVersion:   number;
  newValue:       number | null;
  newStatus:      DatapointStatus;
  newVersion:     number;
  deltaAbsolute:  number | null;
  deltaPct:       number | null;
}

export interface RevisionLog {
  benchmarkId:         string;
  revisionDetectedAt:  string;   // ISO datetime
  revisedBy:           string;   // source name
  entries:             RevisionEntry[];
}

// ── Append result ─────────────────────────────────────────────────────────────

export interface AppendResult {
  benchmarkId: string;
  appended:    number;  // new data points added
  revised:     number;  // existing data points revised
  unchanged:   number;  // fetched but identical to stored
}
