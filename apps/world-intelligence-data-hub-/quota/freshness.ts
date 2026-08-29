// Per-source provenance, exported as an authoritative PULL surface.
//
// WHY THIS EXISTS. `alertOnStaleSourcesOnce` was the only consumer of
// `quota.isStale()` that ever reached a human, and it went with the LINE channel
// on 2026-08-28. The 2026-08-29 investigation then found ACLED had contributed
// one event since May and GDELT none since 2026-08-21, while every consumer read
// the resulting event list as if it were the world.
//
// This is NOT a notification and NOT a second freshness system: it classifies
// the provenance the exporter was already writing, so consumers can tell
// "nothing happened" from "we cannot see what happened".

import { writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  classifySource, PROVENANCE_SCHEMA_VERSION,
  type ProvenanceRecord, type SourceProvenance, type SourceRestriction, type SourceFailure,
} from '@common/types';
import { QuotaTracker, SOURCE_CONFIGS } from './quota-tracker.ts';

export const FRESHNESS_PATH = fileURLToPath(new URL('./freshness.json', import.meta.url));

/**
 * Standing entitlement limits — DECLARED against upstream evidence, never
 * inferred from an empty response. The distinction is the point: an empty result
 * caused by entitlement looks identical to one caused by a broken query, and
 * only one of them can be fixed by retrying.
 */
export const RESTRICTIONS: Record<string, SourceRestriction> = {
  acled: {
    kind: 'recency-embargo',
    detail:
      'the account may only read events at least 12 months old, so no query can return recent events; ' +
      'this requires a subscription change, not an engineering repair',
    evidence:
      'ACLED /api/acled/read returns HTTP 200 success=true with 0 rows for any recent window, and reports ' +
      'data_query_restrictions.date_recency = {quantity: 12, unit: "Months", date: "2025-08-29"}. ' +
      'Probed read-only 2026-08-29; `event_date >= 2025-01-01` returns rows, unfiltered returns rows dated 2019.',
    accessibleOlderThanDays: 365,
  },
};

/**
 * Observed transport failures carried forward from investigation, because the
 * producer that would otherwise record them is not running.
 *
 * SELF-EXPIRING BY CONSTRUCTION: a declaration is ignored once the source has
 * succeeded more recently than the failure was observed (see `activeFailure`).
 * Without that, a one-off finding would harden into permanent fiction.
 */
export const OBSERVED_FAILURES: Record<string, SourceFailure> = {
  gdelt: {
    at: '2026-08-28T19:50:12.000Z',
    kind: 'transport',
    detail:
      "upstream TLS certificate expired (CN=*.gdeltproject.org, Let's Encrypt, notAfter Aug 28 19:50:12 2026 GMT); " +
      'TCP connects but the handshake is rejected. Verified independently of our trust store — the macOS system CA ' +
      'bundle also rejects it and Node reports CERT_HAS_EXPIRED.',
  },
};

/** A declared failure applies only while the source has not succeeded since. */
function activeFailure(source: string, lastSuccessfulFetch: string | null): SourceFailure | undefined {
  const f = OBSERVED_FAILURES[source];
  if (!f) return undefined;
  if (lastSuccessfulFetch && new Date(lastSuccessfulFetch).getTime() > new Date(f.at).getTime()) return undefined;
  return f;
}

/**
 * Built from ONE injected clock. The previous version took `ageHours` from the
 * injected `now` while taking `stale` from a helper reading `Date.now()`
 * internally, so a record could contradict itself.
 */
export function buildProvenance(quota: QuotaTracker, now: Date = new Date()): ProvenanceRecord {
  const sources: SourceProvenance[] = Object.keys(SOURCE_CONFIGS).map(source => {
    const lastSuccessfulFetch = quota.getLastFetch(source) ?? null;
    return classifySource({
      source,
      lastSuccessfulFetch,
      maxStalenessHours: SOURCE_CONFIGS[source].maxStalenessHours,
      restriction: RESTRICTIONS[source],
      lastFailure: activeFailure(source, lastSuccessfulFetch),
      now,
    });
  });
  return { schemaVersion: PROVENANCE_SCHEMA_VERSION, classifiedAt: now.toISOString(), sources };
}

/** Temp + rename, so a crash mid-write cannot leave a truncated surface. */
export function writeProvenance(
  quota: QuotaTracker,
  path: string = FRESHNESS_PATH,
  now: Date = new Date(),
): ProvenanceRecord {
  const record = buildProvenance(quota, now);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, path);
  return record;
}
