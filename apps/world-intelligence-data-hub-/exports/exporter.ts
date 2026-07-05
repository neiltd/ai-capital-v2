import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { EventRecord, EnergyIndicator, MacroIndicator, ExportEnvelope, ExportMeta } from '../lib/types.ts';
import { readStore } from '../store/raw-store.ts';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';

// ── Oil-producing countries for oil project filter ────────────────────────────

const OIL_COUNTRIES = new Set([
  'SAU', 'IRQ', 'IRN', 'RUS', 'USA', 'CAN', 'NGA', 'ARE', 'KWT', 'LBY',
  'VEN', 'KAZ', 'AZE', 'NOR', 'BRA', 'OMN', 'QAT', 'AGO', 'ECU', 'DZA',
]);

const OIL_EVENT_TYPES: EventRecord['type'][] = ['conflict', 'political', 'economic'];

// ── Envelope builder ──────────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0';

function buildMeta(
  recordCount: number,
  sourceVersions: Record<string, string>,
  staleSourcesPresent: boolean,
): ExportMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceVersions,
    recordCount,
    breaking: false,
    staleSourcesPresent,
  };
}

function writeExport<T>(filePath: string, envelope: ExportEnvelope<T>): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  logger.info('exporter', `Written: ${filePath} (${envelope.meta.recordCount} records)`);
}

// ── Export: world-map project ─────────────────────────────────────────────────

export function exportWorldMap(
  sourceVersions: Record<string, string>,
  staleSourcesPresent: boolean,
  daysBack = 30,
): void {
  const events = readStore<EventRecord>('validated', 'events');
  const cutoff  = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
  const filtered = events.filter(e => e.date >= cutoff);

  const sorted = filtered.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return b.date.localeCompare(a.date);
  });

  writeExport(join(PATHS.exports.worldMap, 'events.json'), {
    meta: buildMeta(sorted.length, sourceVersions, staleSourcesPresent),
    data: sorted,
  });
}

// ── Export: oil project ───────────────────────────────────────────────────────

export function exportOilProject(
  sourceVersions: Record<string, string>,
  staleSourcesPresent: boolean,
  daysBack = 30,
): void {
  const events  = readStore<EventRecord>('validated', 'events');
  const energy  = readStore<EnergyIndicator>('validated', 'energy-indicators');
  const cutoff  = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);

  const oilEvents = events
    .filter(e => e.date >= cutoff && OIL_COUNTRIES.has(e.country) && OIL_EVENT_TYPES.includes(e.type))
    .sort((a, b) => b.date.localeCompare(a.date));

  const recentEnergy = energy
    .filter(e => e.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date));

  writeExport(join(PATHS.exports.oilProject, 'oil-events.json'), {
    meta: buildMeta(oilEvents.length, sourceVersions, staleSourcesPresent),
    data: oilEvents,
  });

  writeExport(join(PATHS.exports.oilProject, 'energy-indicators.json'), {
    meta: buildMeta(recentEnergy.length, sourceVersions, staleSourcesPresent),
    data: recentEnergy,
  });
}

// ── Export: stock project (future) ────────────────────────────────────────────

export function exportStockProject(
  sourceVersions: Record<string, string>,
  staleSourcesPresent: boolean,
): void {
  const macro = readStore<MacroIndicator>('validated', 'macro-indicators');

  writeExport(join(PATHS.exports.stockProject, 'macro-indicators.json'), {
    meta: buildMeta(macro.length, sourceVersions, staleSourcesPresent),
    data: macro,
  });
}

// ── Run all exports ───────────────────────────────────────────────────────────

export function runAllExports(
  sourceVersions: Record<string, string>,
  staleSourcesPresent: boolean,
): void {
  logger.info('exporter', 'Generating all exports…');
  exportWorldMap(sourceVersions, staleSourcesPresent);
  exportOilProject(sourceVersions, staleSourcesPresent);
  exportStockProject(sourceVersions, staleSourcesPresent);
  logger.info('exporter', 'All exports complete');
}
