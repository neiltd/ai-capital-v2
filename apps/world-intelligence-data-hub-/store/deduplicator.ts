import { createHash } from 'crypto';
import type { DedupIndex } from '../lib/types.ts';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-fs.ts';

// ── Index persistence ─────────────────────────────────────────────────────────

function loadIndex(): DedupIndex {
  return readJsonOr<DedupIndex>(PATHS.store.dedupIndex, {});
}

function saveIndex(index: DedupIndex): void {
  writeJsonAtomic(PATHS.store.dedupIndex, index);
}

// ── Hash function ─────────────────────────────────────────────────────────────

// Intentionally does NOT include full content — survives minor edits
// to the same event from different sources.
export function dedupHash(source: string, id: string, date: string, title: string): string {
  return createHash('sha256')
    .update(`${source}\x00${id}\x00${date}\x00${title.slice(0, 120).toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 24);
}

// ── Filter new records ────────────────────────────────────────────────────────

export interface DedupKey {
  source: string;
  id: string;
  date: string;
  title: string;
}

// Read-only: checks the index for records not already seen. Does NOT mutate
// or persist the index — a record only becomes permanently "seen" once it has
// survived downstream validation and been persisted (see markSeen below).
// Otherwise a record that fails validation would be blacklisted forever even
// though it was never actually stored, and a later corrected republish of the
// same event would be silently dropped as a duplicate.
export function filterNew<T>(
  records: T[],
  getKey: (r: T) => DedupKey,
): { newRecords: T[]; duplicateCount: number } {
  const index = loadIndex();
  const newRecords: T[] = [];
  let duplicateCount = 0;

  for (const record of records) {
    const { source, id, date, title } = getKey(record);
    const hash = dedupHash(source, id, date, title);

    if (index[hash]) {
      duplicateCount++;
      logger.debug('dedup', `Duplicate: ${title.slice(0, 60)}…`);
      continue;
    }

    newRecords.push(record);
  }

  logger.info('dedup', `${newRecords.length} new / ${duplicateCount} duplicates filtered`);
  return { newRecords, duplicateCount };
}

// Commits records' hashes into the dedup index and persists it. Call only
// after records have been validated and durably persisted to the stores —
// this is the point of no return for dedup purposes.
export function markSeen<T>(
  records: T[],
  getKey: (r: T) => DedupKey,
): void {
  if (records.length === 0) return;

  const index = loadIndex();
  const now = new Date().toISOString();

  for (const record of records) {
    const { source, id, date, title } = getKey(record);
    const hash = dedupHash(source, id, date, title);
    index[hash] = { source, recordId: id, seenAt: now };
  }

  saveIndex(index);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function dedupStats(): { totalEntries: number; bySource: Record<string, number> } {
  const index = loadIndex();
  const bySource: Record<string, number> = {};
  for (const entry of Object.values(index)) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
  }
  return { totalEntries: Object.keys(index).length, bySource };
}
