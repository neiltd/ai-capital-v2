import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-fs.ts';

// ── Path helpers ─────────────────────────────────────────────────────────────

export function rawPath(source: string, date: string): string {
  return join(PATHS.store.rawRoot, source, `${date}.json`);
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Read / write ─────────────────────────────────────────────────────────────

export function readRaw(source: string, date: string): unknown | null {
  const path = rawPath(source, date);
  return readJsonOr<unknown | null>(path, null);
}

export function writeRaw(source: string, date: string, data: unknown): void {
  const dir = join(PATHS.store.rawRoot, source);
  mkdirSync(dir, { recursive: true });
  const path = rawPath(source, date);
  writeJsonAtomic(path, data);
  logger.debug('raw-store', `Snapshot saved → ${path}`);
}

export function rawExists(source: string, date: string): boolean {
  return existsSync(rawPath(source, date));
}

// ── Content hashing ───────────────────────────────────────────────────────────

export function hashContent(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .slice(0, 16);
}

// ── Normalized / validated JSON stores ───────────────────────────────────────

function jsonStorePath(tier: 'normalized' | 'validated', name: string): string {
  const base = tier === 'normalized' ? PATHS.store.normalized : PATHS.store.validated;
  return join(base, `${name}.json`);
}

export function readStore<T>(tier: 'normalized' | 'validated', name: string): T[] {
  const path = jsonStorePath(tier, name);
  return readJsonOr<T[]>(path, []);
}

export function writeStore<T>(tier: 'normalized' | 'validated', name: string, records: T[]): void {
  const base = tier === 'normalized' ? PATHS.store.normalized : PATHS.store.validated;
  mkdirSync(base, { recursive: true });
  const path = jsonStorePath(tier, name);
  writeJsonAtomic(path, records);
  logger.debug('raw-store', `Store written → ${path} (${records.length} records)`);
}

export function appendStore<T extends { id: string }>(
  tier: 'normalized' | 'validated',
  name: string,
  newRecords: T[],
): number {
  if (newRecords.length === 0) return 0;
  const existing = readStore<T>(tier, name);
  const existingIds = new Set(existing.map(r => r.id));
  const toAdd = newRecords.filter(r => !existingIds.has(r.id));
  if (toAdd.length > 0) {
    writeStore(tier, name, [...existing, ...toAdd]);
  }
  logger.info('raw-store', `Appended ${toAdd.length} records to ${tier}/${name}.json (${existing.length + toAdd.length} total)`);
  return toAdd.length;
}

// ── Raw snapshot listing (for backfill / compression scripts) ────────────────

export function listRawDates(source: string): string[] {
  const dir = join(PATHS.store.rawRoot, source);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

export function rawFileSize(source: string, date: string): number {
  const path = rawPath(source, date);
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}
