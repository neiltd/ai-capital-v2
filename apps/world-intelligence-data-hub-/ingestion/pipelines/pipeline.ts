import type { SourceClient } from '../clients/base.client.ts';
import type { SourceRunResult, RunManifest } from '../../lib/types.ts';
import { ConfigurationError } from '../../lib/env.ts';
import { QuotaTracker } from '../../quota/quota-tracker.ts';
import { readRaw, writeRaw, todayStr, appendStore } from '../../store/raw-store.ts';
import { filterNew, markSeen } from '../../store/deduplicator.ts';
import { setCursor, getCursor } from '../../store/source-cursors.ts';
import { normalizeNewsAPI, normalizeACLED, normalizeGDELT, normalizeUCDP } from '../../processing/normalizers/event.normalizer.ts';
import { normalizeEIA, normalizeWorldBank } from '../../processing/normalizers/energy.normalizer.ts';
import { validateEvents } from '../../processing/validators/event.validator.ts';
import { validateEnergyIndicators, validateMacroIndicators } from '../../processing/validators/energy.validator.ts';
import type { EventRecord, EnergyIndicator, MacroIndicator } from '../../lib/types.ts';
import { logger } from '../../lib/logger.ts';

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  source: string,
  maxAttempts = 3,
): Promise<T> {
  const delays = [15_000, 60_000, 180_000];
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Configuration errors are deterministic — retrying will never help
      if (err instanceof ConfigurationError) throw err;

      lastErr = err;
      const msg   = err instanceof Error ? err.message : String(err);
      const cause = (err instanceof Error && (err as Error & { cause?: Error }).cause)
        ? (err as Error & { cause: Error }).cause.message
        : undefined;
      if (attempt < maxAttempts) {
        const wait = delays[attempt - 1] ?? 60_000;
        logger.warn('pipeline', `${source} attempt ${attempt}/${maxAttempts} failed — retry in ${wait / 1000}s`, { error: msg, cause });
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  throw lastErr;
}

// ── Source-specific normalization dispatch ────────────────────────────────────

function normalizeRaw(
  source: string,
  raw: unknown,
  fetchedAt: string,
): { events: EventRecord[]; energy: EnergyIndicator[]; macro: MacroIndicator[] } {
  switch (source) {
    case 'newsapi':   return { events: normalizeNewsAPI(raw, fetchedAt),   energy: [], macro: [] };
    case 'acled':     return { events: normalizeACLED(raw, fetchedAt),     energy: [], macro: [] };
    case 'gdelt':     return { events: normalizeGDELT(raw, fetchedAt),     energy: [], macro: [] };
    case 'ucdp':      return { events: normalizeUCDP(raw, fetchedAt),      energy: [], macro: [] };
    case 'eia':       return { events: [],                                  energy: normalizeEIA(raw, fetchedAt), macro: [] };
    case 'worldbank': return { events: [],                                  energy: [], macro: normalizeWorldBank(raw, fetchedAt) };
    default:
      logger.warn('pipeline', `No normalizer registered for source: ${source}`);
      return { events: [], energy: [], macro: [] };
  }
}

// ── Single source run ─────────────────────────────────────────────────────────

async function runSource(
  client: SourceClient,
  quota: QuotaTracker,
): Promise<SourceRunResult> {
  const { name } = client;

  // 1. Check cache freshness
  if (quota.isCacheFresh(name)) {
    logger.info('pipeline', `${name}: cache fresh — skipping`);
    return { source: name, status: 'skipped' };
  }

  // 2. Check quota
  const { allowed, reason } = quota.canFetch(name);
  if (!allowed) {
    logger.warn('pipeline', `${name}: quota blocked — ${reason}`);
    return { source: name, status: 'skipped' };
  }

  // 3. Fetch (with retry)
  const fetchedAt = new Date().toISOString();
  let raw: unknown;
  let attempts = 1;

  try {
    const cursor = getCursor(name);
    raw = await withRetry(
      () => {
        attempts++;
        return client.fetch(cursor?.lastFetchedAt);
      },
      name,
      3,
    );
    attempts--; // correct for pre-increment
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('pipeline', `${name}: all retries exhausted`, { error: msg });
    quota.recordFetch(name, false);
    return { source: name, status: 'failed', error: msg, attempts };
  }

  // 4. Persist raw snapshot — idempotent/safe to have on disk even if the
  // steps below fail, so this stays unconditional. Quota consumption is
  // recorded here too since the fetch itself succeeded regardless of what
  // happens downstream.
  writeRaw(name, todayStr(), raw);
  quota.recordFetch(name, true);

  const eventKey  = (r: EventRecord)      => ({ source: r.source, id: r.id, date: r.date, title: r.title });
  const metricKey = (r: EnergyIndicator | MacroIndicator) => ({ source: r.source, id: r.id, date: r.date, title: r.metric });

  try {
    // 5. Normalize
    const { events, energy, macro } = normalizeRaw(name, raw, fetchedAt);
    logger.info('pipeline', `${name}: normalized ${events.length} events / ${energy.length} energy / ${macro.length} macro`);

    // 6. Dedup filter (read-only — does not commit hashes yet)
    const { newRecords: newEvents, duplicateCount: dupEvents } = filterNew(events, eventKey);
    const { newRecords: newEnergy } = filterNew(energy, metricKey);
    const { newRecords: newMacro }  = filterNew(macro, metricKey);

    // 7. Validate
    const validatedEvents  = validateEvents(newEvents).valid;
    const validatedEnergy  = validateEnergyIndicators(newEnergy).valid;
    const validatedMacro   = validateMacroIndicators(newMacro).valid;

    // 8. Persist to normalized + validated stores
    appendStore('normalized', 'events',            validatedEvents);
    appendStore('normalized', 'energy-indicators', validatedEnergy);
    appendStore('normalized', 'macro-indicators',  validatedMacro);
    appendStore('validated',  'events',            validatedEvents);
    appendStore('validated',  'energy-indicators', validatedEnergy);
    appendStore('validated',  'macro-indicators',  validatedMacro);

    // Only now commit dedup hashes — for records that actually survived
    // validation and made it to disk. Anything filtered out by validation
    // stays eligible for a corrected republish to be re-ingested later.
    markSeen(validatedEvents, eventKey);
    markSeen(validatedEnergy, metricKey);
    markSeen(validatedMacro,  metricKey);

    // Cursor only advances once this source's data is safely persisted, so a
    // failure above leaves the fetch window intact for retry on the next run.
    setCursor(name, { lastFetchedAt: fetchedAt });

    return {
      source:     name,
      status:     'ok',
      fetchedAt,
      newRecords: newEvents.length + newEnergy.length + newMacro.length,
      duplicates: dupEvents,
      attempts,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('pipeline', `${name}: normalize/dedup/validate/persist failed — cursor not advanced, will retry this window next run`, { error: msg });
    return { source: name, status: 'failed', error: msg, attempts };
  }
}

// ── Full pipeline run ─────────────────────────────────────────────────────────

export async function runPipeline(
  clients: SourceClient[],
  quota: QuotaTracker,
): Promise<RunManifest> {
  const runId     = new Date().toISOString();
  const startedAt = runId;
  const sources: Record<string, SourceRunResult> = {};

  logger.info('pipeline', `Run started — ${clients.length} sources`, { runId });

  for (const client of clients) {
    logger.info('pipeline', `─── ${client.name} ───────────────────────`);
    const result = await runSource(client, quota);
    sources[client.name] = result;
    logger.info('pipeline', `${client.name}: ${result.status}`, {
      newRecords: result.newRecords,
      duplicates: result.duplicates,
      error:      result.error,
    });
  }

  const completedAt = new Date().toISOString();
  const manifest: RunManifest = { runId, startedAt, completedAt, sources, exported: false };

  logger.info('pipeline', 'Run complete', {
    ok:      Object.values(sources).filter(s => s.status === 'ok').length,
    skipped: Object.values(sources).filter(s => s.status === 'skipped').length,
    failed:  Object.values(sources).filter(s => s.status === 'failed').length,
  });

  return manifest;
}

// ── Source version map (for export meta) ─────────────────────────────────────

export function buildSourceVersions(
  quota: QuotaTracker,
  sources: Record<string, SourceRunResult>,
): { versions: Record<string, string>; stale: boolean } {
  const versions: Record<string, string> = {};
  let stale = false;

  for (const [name, result] of Object.entries(sources)) {
    if (result.fetchedAt) {
      versions[name] = result.fetchedAt;
    } else {
      const last = quota.getLastFetch(name);
      if (last) versions[name] = last;
    }
    if (quota.isStale(name)) stale = true;
  }

  return { versions, stale };
}
