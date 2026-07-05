import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-fs.ts';
import type {
  BenchmarkConfig, FetchedDatapoint, StoredDatapoint,
  DatapointStatus, YearFile, RevisionEntry, RevisionLog, AppendResult,
} from '../ingestion/timeseries/types.ts';

// ── Path helpers ──────────────────────────────────────────────────────────────

function benchmarkDir(benchmarkId: string): string {
  return join(PATHS.store.timeseries.commodities, benchmarkId);
}

function yearFilePath(benchmarkId: string, year: number): string {
  return join(benchmarkDir(benchmarkId), `${year}.json`);
}

function metadataPath(benchmarkId: string): string {
  return join(benchmarkDir(benchmarkId), 'metadata.json');
}

function revisionLogPath(benchmarkId: string, date: string): string {
  return join(benchmarkDir(benchmarkId), 'revisions', `${date}.json`);
}

// ── Year file I/O ─────────────────────────────────────────────────────────────

function emptyYearFile(benchmarkId: string, year: number): YearFile {
  return { benchmarkId, year, datapoints: [], lastModified: new Date().toISOString() };
}

function readYearFile(benchmarkId: string, year: number): YearFile {
  const path = yearFilePath(benchmarkId, year);
  return readJsonOr<YearFile>(path, emptyYearFile(benchmarkId, year));
}

function writeYearFile(benchmarkId: string, year: number, file: YearFile): void {
  const dir = benchmarkDir(benchmarkId);
  mkdirSync(dir, { recursive: true });
  file.lastModified = new Date().toISOString();
  writeJsonAtomic(yearFilePath(benchmarkId, year), file);
}

// ── Revision log I/O ──────────────────────────────────────────────────────────

function writeRevisionLog(benchmarkId: string, source: string, entries: RevisionEntry[]): void {
  if (entries.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const logPath = revisionLogPath(benchmarkId, today);
  mkdirSync(join(benchmarkDir(benchmarkId), 'revisions'), { recursive: true });

  // Append to existing today's log if present (multiple fetches in one day)
  const existing = readJsonOr<RevisionLog | null>(logPath, null);
  const log: RevisionLog = existing
    ? { ...existing, entries: [...existing.entries, ...entries] }
    : { benchmarkId, revisionDetectedAt: new Date().toISOString(), revisedBy: source, entries };

  writeJsonAtomic(logPath, log);
  logger.info('timeseries-store', `Revision log → ${logPath} (${entries.length} entries)`);
}

// ── Metadata I/O ──────────────────────────────────────────────────────────────

export function ensureMetadata(config: BenchmarkConfig): void {
  const path = metadataPath(config.benchmarkId);
  mkdirSync(benchmarkDir(config.benchmarkId), { recursive: true });
  if (!existsSync(path)) {
    writeJsonAtomic(path, { ...config, schemaVersion: '1.0', lastModified: new Date().toISOString() });
  }
}

export function readMetadata(benchmarkId: string): BenchmarkConfig | null {
  const path = metadataPath(benchmarkId);
  return readJsonOr<BenchmarkConfig | null>(path, null);
}

// ── Status inference ──────────────────────────────────────────────────────────
// Infers whether a newly fetched point is preliminary/provisional/final
// based on how many days have passed since the data date.

function inferStatus(dataDate: string, config: BenchmarkConfig): DatapointStatus {
  const ageDays = Math.floor(
    (Date.now() - new Date(dataDate).getTime()) / 86_400_000,
  );
  const lagDays = parseInt(config.dataLag.replace(/\D/g, ''), 10) || 1;
  if (ageDays < lagDays * 2)                  return 'preliminary';
  if (ageDays < config.revisionWindowDays)    return 'provisional';
  return 'final';
}

// ── Core append ───────────────────────────────────────────────────────────────

export function appendDatapoints(
  config:     BenchmarkConfig,
  fetched:    FetchedDatapoint[],
): AppendResult {
  const result: AppendResult = {
    benchmarkId: config.benchmarkId,
    appended: 0, revised: 0, unchanged: 0,
  };

  // Group fetched points by year
  const byYear = new Map<number, FetchedDatapoint[]>();
  for (const dp of fetched) {
    const year = parseInt(dp.date.slice(0, 4), 10);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(dp);
  }

  for (const [year, points] of byYear) {
    const file = readYearFile(config.benchmarkId, year);
    const index = new Map(file.datapoints.map(d => [d.date, d]));
    const revisions: RevisionEntry[] = [];

    for (const fp of points) {
      const existing = index.get(fp.date);
      const newStatus = inferStatus(fp.date, config);

      if (!existing) {
        // New data point
        const stored: StoredDatapoint = {
          date:      fp.date,
          value:     fp.value,
          status:    fp.value === null ? 'missing' : newStatus,
          version:   1,
          fetchedAt: fp.fetchedAt,
          source:    fp.source,
        };
        index.set(fp.date, stored);
        result.appended++;
        continue;
      }

      // Check for revision
      if (existing.value === null && fp.value === null) {
        result.unchanged++;
        continue;
      }
      if (existing.value !== null && fp.value !== null) {
        const delta = Math.abs(fp.value - existing.value) / existing.value;
        if (delta <= config.revisionThreshold) {
          // Values are effectively identical — update status if it changed
          if (newStatus !== existing.status) {
            existing.status = newStatus;
          }
          result.unchanged++;
          continue;
        }
        // Genuine revision
        revisions.push({
          dataDate:      fp.date,
          priorValue:    existing.value,
          priorStatus:   existing.status,
          priorVersion:  existing.version,
          newValue:      fp.value,
          newStatus:     'revised',
          newVersion:    existing.version + 1,
          deltaAbsolute: Math.abs(fp.value - existing.value),
          deltaPct:      (fp.value - existing.value) / existing.value,
        });
        existing.value         = fp.value;
        existing.status        = 'revised';
        existing.version       = existing.version + 1;
        existing.lastRevisedAt = fp.fetchedAt;
        existing.revisionCount = (existing.revisionCount ?? 0) + 1;
        result.revised++;
      } else {
        // null → non-null or non-null → null: treat as revision
        revisions.push({
          dataDate:      fp.date,
          priorValue:    existing.value,
          priorStatus:   existing.status,
          priorVersion:  existing.version,
          newValue:      fp.value,
          newStatus:     fp.value !== null ? 'revised' : 'missing',
          newVersion:    existing.version + 1,
          deltaAbsolute: null,
          deltaPct:      null,
        });
        existing.value         = fp.value;
        existing.status        = fp.value !== null ? 'revised' : 'missing';
        existing.version       = existing.version + 1;
        existing.lastRevisedAt = fp.fetchedAt;
        existing.revisionCount = (existing.revisionCount ?? 0) + 1;
        result.revised++;
      }
    }

    // Rebuild datapoints array sorted by date
    file.datapoints = [...index.values()].sort((a, b) => a.date.localeCompare(b.date));
    writeYearFile(config.benchmarkId, year, file);

    if (revisions.length > 0) {
      writeRevisionLog(config.benchmarkId, config.source, revisions);
    }
  }

  return result;
}

// ── Range query ───────────────────────────────────────────────────────────────

export function getRange(
  benchmarkId: string,
  from: string,    // YYYY-MM-DD inclusive
  to:   string,    // YYYY-MM-DD inclusive
): StoredDatapoint[] {
  const fromYear = parseInt(from.slice(0, 4), 10);
  const toYear   = parseInt(to.slice(0, 4),   10);
  const results: StoredDatapoint[] = [];

  for (let year = fromYear; year <= toYear; year++) {
    const file = readYearFile(benchmarkId, year);
    for (const dp of file.datapoints) {
      if (dp.date >= from && dp.date <= to) results.push(dp);
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Freshness query ───────────────────────────────────────────────────────────

export function getLastDataPoint(benchmarkId: string): StoredDatapoint | null {
  // Walk years backward from current year until we find a non-null point
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year >= currentYear - 5; year--) {
    const file = readYearFile(benchmarkId, year);
    const nonNull = file.datapoints.filter(d => d.value !== null);
    if (nonNull.length > 0) {
      return nonNull[nonNull.length - 1]!;
    }
  }
  return null;
}
