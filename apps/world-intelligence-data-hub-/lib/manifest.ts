import { readFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { RunManifest } from './types.ts';
import { PATHS } from './paths.ts';
import { logger } from './logger.ts';
import { writeJsonAtomic } from './atomic-fs.ts';

// ── Run manifest (per-run record) ─────────────────────────────────────────────

export function writeRunManifest(manifest: RunManifest): void {
  mkdirSync(PATHS.runs, { recursive: true });
  const path = join(PATHS.runs, `${manifest.runId.replace(/[:.]/g, '-')}.json`);
  writeJsonAtomic(path, manifest);
  logger.info('manifest', `Run manifest written → ${path}`);
}

// ── Export manifest (describes all current export files) ─────────────────────

interface ExportFileEntry {
  size: number;
  sha256: string;
  recordCount: number;
  generatedAt: string;
}

function hashFile(path: string): string {
  if (!existsSync(path)) return '';
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

function parseRecordCount(path: string): { count: number; generatedAt: string } {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      count:       data?.meta?.recordCount ?? data?.data?.length ?? 0,
      generatedAt: data?.meta?.generatedAt ?? '',
    };
  } catch {
    return { count: 0, generatedAt: '' };
  }
}

const EXPORT_FILES = [
  'world-map/events.json',
  'oil-project/oil-events.json',
  'oil-project/energy-indicators.json',
  'stock-project/macro-indicators.json',
];

export function writeExportManifest(): void {
  const entries: Record<string, ExportFileEntry> = {};

  for (const file of EXPORT_FILES) {
    const fullPath = join(PATHS.exports.root, file);
    if (!existsSync(fullPath)) continue;

    const { size }        = statSync(fullPath);
    const sha256          = hashFile(fullPath);
    const { count, generatedAt } = parseRecordCount(fullPath);

    entries[file] = { size, sha256, recordCount: count, generatedAt };
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    exports: entries,
  };

  writeJsonAtomic(PATHS.exports.manifest, manifest);
  logger.info('manifest', `Export manifest written → ${PATHS.exports.manifest}`);
  logger.info('manifest', `Covered ${Object.keys(entries).length} export files`);
}
