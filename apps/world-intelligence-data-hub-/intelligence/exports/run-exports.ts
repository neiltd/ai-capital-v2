// Export runner — reads intelligence outputs, writes versioned JSON exports.
// Called by `npm run export`. Safe to run multiple times (idempotent).
//
// Reads from:
//   intelligence/outputs/events/{date}.json
//   intelligence/outputs/storylines/storylines.json
//
// Writes to (stable paths — downstream projects depend on these):
//   exports/world-map/intelligence.json
//   exports/oil-project/intelligence.json
//   exports/stock-project/intelligence.json
//   exports/manifest.json  (updated, not replaced)

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join }           from 'path';
import { createHash }     from 'crypto';
import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import { validateEvent }          from '../schema/intelligence-event.ts';
import type { Storyline }         from '../schema/storyline.ts';
import { StorylineSchema }        from '../schema/storyline.ts';
import { buildWorldIntelExport }  from './world-intel-exporter.ts';
import { buildOilExport }         from './oil-exporter.ts';
import { buildStockExport }       from './stock-exporter.ts';
import { buildV2EventsFile, buildV2Manifest, buildV2HumanEventEntry } from './worldmap-v2-exporter.ts';
import {
  toExternalWorldIntelExport,
  toExternalOilExport,
  toExternalStockExport,
} from './contract/mappers.ts';
import { runTimeseriesExports } from './timeseries-exporter.ts';
import { runCrossDomainObservation, saveCrossDomainSnapshot } from '../cross-domain/observer.ts';
import type { ExportManifest, ManifestEntry } from './types.ts';
import { PATHS }          from '../../lib/paths.ts';
import { logger }         from '../../lib/logger.ts';
import { loadPendingRecords, markExported, loadHumanStore } from '../human/store.ts';
import type { HumanIntelRecord } from '../human/store.ts';
import { loadAnalysisStore, loadBriefs } from '../human/analysis-store.ts';
import { writeJsonAtomic } from '../../lib/atomic-fs.ts';

// ── Internal types (not exported to consumers) ────────────────────────────────

interface EventFile {
  date:               string;
  extraction_version: string;
  prompt_version:     string;
  model:              string;
  stats:              Record<string, unknown>;
  events:             IntelligenceEvent[];
}

interface StorylineFile {
  storylines: Storyline[];
}

// ── Loaders ───────────────────────────────────────────────────────────────────

function findLatestEventDate(): string | null {
  try {
    const files = readdirSync(PATHS.intelligence.outputEvents);
    const dates = files
      .map(f => f.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
      .filter((d): d is string => !!d)
      .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  } catch {
    return null;
  }
}

function loadEvents(date: string): { file: EventFile; version: string; actualDate: string; droppedInvalidCount: number } | null {
  // Try the requested date first; if missing, fall back to the most recent
  // available event file. This makes the daily `export` step keep refreshing
  // the consumer-facing JSON snapshots even when the upstream pipeline only
  // runs weekly (Sundays) — previously the export would bail and consumers
  // would read stale data without any signal.
  let activeDate = date;
  let p = join(PATHS.intelligence.outputEvents, `${activeDate}.json`);
  if (!existsSync(p)) {
    const fallback = findLatestEventDate();
    if (!fallback) {
      logger.warn('export', `No event file for ${date} and no fallback available — skipping`);
      return null;
    }
    if (fallback === date) {
      logger.warn('export', `No event file for ${date} — skipping`);
      return null;
    }
    logger.warn('export', `No event file for ${date} — falling back to latest available: ${fallback}`);
    activeDate = fallback;
    p = join(PATHS.intelligence.outputEvents, `${activeDate}.json`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8'));
  } catch (err) {
    logger.error('export', `Failed to load events for ${activeDate}: ${(err as Error).message}`);
    return null;
  }

  // Envelope-level validation — a malformed top-level shape means the
  // upstream pipeline produced something we don't understand at all. This is
  // a hard failure and must not be silently swallowed (unlike individual bad
  // events below, which are dropped one-by-one).
  if (
    !raw || typeof raw !== 'object' ||
    !Array.isArray((raw as Record<string, unknown>).events)
  ) {
    throw new Error(`Malformed event file envelope at ${p} — expected an object with an "events" array`);
  }

  const rawFile = raw as EventFile;
  let droppedInvalidCount = 0;
  const validEvents: IntelligenceEvent[] = [];
  for (const ev of rawFile.events as unknown[]) {
    const result = validateEvent(ev);
    if (result.success) {
      validEvents.push(result.data);
    } else {
      droppedInvalidCount++;
      const id = (ev as { event_id?: string } | null)?.event_id ?? 'unknown';
      logger.warn('export', `Dropping invalid event (event_id=${id}) from ${activeDate}: ${result.error}`);
    }
  }

  const file: EventFile = { ...rawFile, events: validEvents };
  return { file, version: file.extraction_version ?? 'unknown', actualDate: activeDate, droppedInvalidCount };
}

function loadStorylines(): { storylines: Storyline[]; droppedInvalidCount: number } {
  const p = join(PATHS.intelligence.outputs, 'storylines', 'storylines.json');
  if (!existsSync(p)) return { storylines: [], droppedInvalidCount: 0 };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return { storylines: [], droppedInvalidCount: 0 };
  }

  // Envelope-level validation — same policy as loadEvents: a malformed
  // top-level shape is a hard failure, not silently-empty data.
  if (
    !raw || typeof raw !== 'object' ||
    !Array.isArray((raw as Record<string, unknown>).storylines)
  ) {
    throw new Error(`Malformed storyline file envelope at ${p} — expected an object with a "storylines" array`);
  }

  let droppedInvalidCount = 0;
  const valid: Storyline[] = [];
  for (const s of (raw as StorylineFile).storylines as unknown[]) {
    const result = StorylineSchema.safeParse(s);
    if (result.success) {
      valid.push(result.data);
    } else {
      droppedInvalidCount++;
      const id = (s as { storyline_id?: string } | null)?.storyline_id ?? 'unknown';
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.warn('export', `Dropping invalid storyline (storyline_id=${id}): ${issues}`);
    }
  }

  return { storylines: valid, droppedInvalidCount };
}

// ── Writers ───────────────────────────────────────────────────────────────────

function writeExport(filePath: string, data: unknown): { bytes: number; sha256: string } {
  const json  = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(json, 'utf-8');
  const sha256 = createHash('sha256').update(json, 'utf-8').digest('hex');
  writeJsonAtomic(filePath, data);
  return { bytes, sha256 };
}

// ── Manifest ──────────────────────────────────────────────────────────────────

function loadManifest(): ExportManifest {
  if (!existsSync(PATHS.exports.manifest)) {
    return {
      manifest_version: '1.0',
      last_updated:     new Date().toISOString(),
      exports: { 'world-intelligence': null, 'oil-project': null, 'stock-project': null },
    };
  }
  try {
    return JSON.parse(readFileSync(PATHS.exports.manifest, 'utf-8')) as ExportManifest;
  } catch {
    return {
      manifest_version: '1.0',
      last_updated:     new Date().toISOString(),
      exports: { 'world-intelligence': null, 'oil-project': null, 'stock-project': null },
    };
  }
}

function saveManifest(manifest: ExportManifest): void {
  manifest.last_updated = new Date().toISOString();
  writeJsonAtomic(PATHS.exports.manifest, manifest);
}

// ── Run ───────────────────────────────────────────────────────────────────────

export interface ExportRunResult {
  date:                       string;   // actual date the exported data represents
  requested_date:             string;   // originally requested date
  is_stale:                   boolean;  // true when requested_date !== date (pipeline served fallback data)
  dropped_invalid_events:     number;   // individual events that failed schema validation and were dropped
  dropped_invalid_storylines: number;   // individual storylines that failed schema validation and were dropped
  world_intel: { event_count: number; story_count: number; country_count: number; bytes: number };
  oil:         { event_count: number; hormuz_risk: string; bytes: number };
  stock:       { event_count: number; signal_count: number; sector_count: number; bytes: number };
}

export function runExports(date: string): ExportRunResult {
  const loaded = loadEvents(date);
  if (!loaded) throw new Error(`No event data available for ${date}`);

  const { file, version, actualDate, droppedInvalidCount: droppedInvalidEvents } = loaded;
  const events        = file.events;
  const storylinesRes = loadStorylines();
  const storylines    = storylinesRes.storylines;
  const droppedInvalidStorylines = storylinesRes.droppedInvalidCount;
  const manifest   = loadManifest();
  const now        = new Date().toISOString();
  const isStale    = actualDate !== date;

  if (isStale) {
    logger.warn('export', `Export for ${date} is serving fallback data from ${actualDate} — marking is_stale`);
  }
  if (droppedInvalidEvents > 0) {
    logger.warn('export', `Dropped ${droppedInvalidEvents} invalid event(s) during validation for ${actualDate}`);
  }
  if (droppedInvalidStorylines > 0) {
    logger.warn('export', `Dropped ${droppedInvalidStorylines} invalid storyline(s) during validation`);
  }

  logger.info('export', `Running exports for ${actualDate} (requested ${date}) — ${events.length} events, ${storylines.length} storylines`);

  const pendingHuman: HumanIntelRecord[] = loadPendingRecords();
  if (pendingHuman.length > 0) {
    logger.info('export', `Merging ${pendingHuman.length} pending human-intel record(s) into exports`);
  }

  // ── World Intelligence ─────────────────────────────────────────────────────
  // Internal builder produces snake_case; mapper converts to camelCase before write.

  const worldIntel    = { ...buildWorldIntelExport(actualDate, events, storylines, version), requested_date: date, is_stale: isStale };
  const worldIntelExt = toExternalWorldIntelExport(worldIntel);
  const wiPath        = join(PATHS.exports.worldMap, 'intelligence.json');
  const wiPayload = pendingHuman.length ? { ...(worldIntelExt as unknown as Record<string, unknown>), human_intel: pendingHuman } : worldIntelExt;
  const wiWritten     = writeExport(wiPath, wiPayload);

  const wiEntry: ManifestEntry = {
    schema_version: worldIntelExt.schemaVersion,
    generated_at:   worldIntelExt.generatedAt,
    date:           worldIntelExt.date,
    requested_date: worldIntelExt.requestedDate ?? date,
    is_stale:       worldIntelExt.isStale ?? isStale,
    event_count:    worldIntelExt.eventCount,
    file:           'world-map/intelligence.json',
  };
  manifest.exports['world-intelligence'] = wiEntry;

  logger.info('export', `world-map/intelligence.json — ${worldIntel.event_count} events, ${worldIntel.storylines.length} storylines, ${worldIntel.country_signals.length} country signals`);

  // ── Oil Project ────────────────────────────────────────────────────────────

  const oil       = { ...buildOilExport(actualDate, events, version), requested_date: date, is_stale: isStale };
  const oilExt    = toExternalOilExport(oil);
  const oilPath   = join(PATHS.exports.oilProject, 'intelligence.json');
  const oilPayload = pendingHuman.length ? { ...(oilExt as unknown as Record<string, unknown>), human_intel: pendingHuman } : oilExt;
  const oilWritten = writeExport(oilPath, oilPayload);

  const oilEntry: ManifestEntry = {
    schema_version: oilExt.schemaVersion,
    generated_at:   oilExt.generatedAt,
    date:           oilExt.date,
    requested_date: oilExt.requestedDate ?? date,
    is_stale:       oilExt.isStale ?? isStale,
    event_count:    oilExt.eventCount,
    file:           'oil-project/intelligence.json',
  };
  manifest.exports['oil-project'] = oilEntry;

  logger.info('export', `oil-project/intelligence.json — ${oil.event_count} energy events, Hormuz: ${oil.hormuz_risk.risk_level}, ${oil.commodity_signals.length} commodity signals`);

  // ── Stock Project ──────────────────────────────────────────────────────────

  const stock      = { ...buildStockExport(actualDate, events, version), requested_date: date, is_stale: isStale };
  const stockExt   = toExternalStockExport(stock);
  const stockPath  = join(PATHS.exports.stockProject, 'intelligence.json');
  const stockPayload = pendingHuman.length ? { ...(stockExt as unknown as Record<string, unknown>), human_intel: pendingHuman } : stockExt;
  const stockWritten = writeExport(stockPath, stockPayload);

  const stockEntry: ManifestEntry = {
    schema_version: stockExt.schemaVersion,
    generated_at:   stockExt.generatedAt,
    date:           stockExt.date,
    requested_date: stockExt.requestedDate ?? date,
    is_stale:       stockExt.isStale ?? isStale,
    event_count:    stockExt.eventCount,
    file:           'stock-project/intelligence.json',
  };
  manifest.exports['stock-project'] = stockEntry;

  logger.info('export', `stock-project/intelligence.json — ${stock.event_count} market events, ${stock.macro_risk_signals.length} macro signals, ${stock.sector_exposure.length} sector exposures`);

  // ── Update manifest ────────────────────────────────────────────────────────

  saveManifest(manifest);
  if (pendingHuman.length > 0) {
    markExported(pendingHuman.map(r => r.id));
    logger.info('export', `Marked ${pendingHuman.length} human-intel record(s) as exported`);
  }
  logger.info('export', `Manifest updated → ${PATHS.exports.manifest}`);

  // ── Cross-domain observation ───────────────────────────────────────────────
  // Joins intelligence events + storylines against commodity price data.
  // Purely observational — no AI, no causal claims, no pipeline feedback.
  try {
    const crossDomainSnap = runCrossDomainObservation(date, events, storylines);
    saveCrossDomainSnapshot(crossDomainSnap);
    logger.info('export', `Cross-domain: ${crossDomainSnap.summary.energyLinkedStorylines} energy-linked storylines, ${crossDomainSnap.summary.pairedObservationDays} paired obs. days`);
  } catch (err) {
    logger.warn('export', `Cross-domain observation skipped: ${(err as Error).message}`);
  }

  // ── Commodity time-series exports ─────────────────────────────────────────
  // Reads from store/timeseries/ — non-fatal if store is empty (no prices fetched yet).
  let timeseriesResult = null;
  try {
    timeseriesResult = runTimeseriesExports();
    logger.info('export', `Timeseries exports complete — oil: ${timeseriesResult.oilPrices.datapointCount}pts, gas: ${timeseriesResult.gasPrices.datapointCount}pts`);
  } catch (err) {
    logger.warn('export', `Timeseries export skipped: ${(err as Error).message}`);
  }

  // ── worldmaphistory_v2 import files ───────────────────────────────────────
  const analyses  = loadAnalysisStore();
  const aMap      = new Map(analyses.map(a => [a.event_id, a]));
  const allHuman  = loadHumanStore();
  const humanV2   = allHuman
    .map(r => buildV2HumanEventEntry(r, aMap.get(r.id)))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const v2Events   = buildV2EventsFile(events, actualDate);
  const v2EventsMerged = {
    ...v2Events,
    eventCount: v2Events.eventCount + humanV2.length,
    events:     [...v2Events.events, ...humanV2],
  };
  const v2Manifest = buildV2Manifest(v2EventsMerged.eventCount, actualDate);

  const briefs     = loadBriefs();
  const briefsFile = {
    schemaVersion: '1.0.0',
    generatedAt:   new Date().toISOString(),
    briefs,
  };

  const V2_IMPORT_PATHS = [
    join(PATHS.root, '..', 'worldmaphistory_v2', 'public', 'data', 'imports'),
  ];
  for (const dir of V2_IMPORT_PATHS) {
    if (!existsSync(join(dir, '..'))) continue;
    try {
      // Write data files first, manifest.json last — consumers poll manifest.json
      // to discover what's available, so it must only land once every file it
      // describes has already been fully (atomically) written.
      writeJsonAtomic(join(dir, 'events.json'),              v2EventsMerged);
      writeJsonAtomic(join(dir, 'intelligence-briefs.json'), briefsFile);
      writeJsonAtomic(join(dir, 'manifest.json'),            v2Manifest);
      logger.info('export', `worldmaphistory_v2 imports → ${dir}`);
    } catch {
      // Non-fatal — v2 may not be present in all environments
    }
  }

  return {
    date:                       actualDate,
    requested_date:             date,
    is_stale:                   isStale,
    dropped_invalid_events:     droppedInvalidEvents,
    dropped_invalid_storylines: droppedInvalidStorylines,
    world_intel: {
      event_count:   worldIntel.event_count,
      story_count:   worldIntel.storylines.length,
      country_count: worldIntel.country_signals.length,
      bytes:         wiWritten.bytes,
    },
    oil: {
      event_count: oil.event_count,
      hormuz_risk: oil.hormuz_risk.risk_level,
      bytes:       oilWritten.bytes,
    },
    stock: {
      event_count:   stock.event_count,
      signal_count:  stock.macro_risk_signals.length,
      sector_count:  stock.sector_exposure.length,
      bytes:         stockWritten.bytes,
    },
  };
}
