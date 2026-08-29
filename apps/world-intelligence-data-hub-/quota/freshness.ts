// Per-source feed freshness, exported as an authoritative PULL surface.
//
// WHY THIS EXISTS. `alertOnStaleSourcesOnce` was the only consumer of
// `quota.isStale()` that ever reached a human, and it was removed with the LINE
// channel on 2026-08-28. Nothing else read per-source staleness — not the
// dashboard, not morning-status, not the briefing. That control existed because
// ACLED was 403-broken for nine days without anyone noticing, so losing it was a
// visibility regression distinct from the accepted "pipeline failures are
// pull-based" limitation.
//
// This is NOT a notification: no delivery state, no retry state, no markers, no
// outbound messaging. It is a file that says which feeds are current and which
// are not, written by the component that already owns the answer.

import { writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { QuotaTracker, SOURCE_CONFIGS } from './quota-tracker.ts';

export const FRESHNESS_SCHEMA_VERSION = 1;

/** Anchored to this module, never to cwd. */
export const FRESHNESS_PATH = fileURLToPath(new URL('./freshness.json', import.meta.url));

export interface SourceFreshness {
  source: string;
  lastSuccessfulFetch: string | null;
  /** The bound this source is judged against, so the record explains itself. */
  maxStalenessHours: number;
  ageHours: number | null;
  stale: boolean;
  /** Why it is stale, in words, or null when it is current. */
  reason: string | null;
}

export interface FreshnessFile {
  schemaVersion: number;
  exportedAt: string;
  sources: SourceFreshness[];
}

/**
 * Built from the tracker's OWN `isStale`, so the threshold lives in exactly one
 * place. A dashboard that re-implemented the comparison would drift from the
 * pipeline's definition of stale, which is how two components come to disagree
 * about whether a feed is dead.
 */
export function buildFreshness(quota: QuotaTracker, now: Date = new Date()): FreshnessFile {
  const sources: SourceFreshness[] = Object.keys(SOURCE_CONFIGS).map(source => {
    const last = quota.getLastFetch(source) ?? null;
    const maxStalenessHours = SOURCE_CONFIGS[source].maxStalenessHours;
    const ageHours = last ? (now.getTime() - new Date(last).getTime()) / 3_600_000 : null;
    const stale = quota.isStale(source);
    return {
      source,
      lastSuccessfulFetch: last,
      maxStalenessHours,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      stale,
      reason: !stale ? null
        : last === null ? 'no successful fetch has ever been recorded'
        : `last success was ${Math.round((ageHours ?? 0))}h ago, past the ${maxStalenessHours}h bound`,
    };
  });
  return { schemaVersion: FRESHNESS_SCHEMA_VERSION, exportedAt: now.toISOString(), sources };
}

/** Temp + rename, so a crash mid-write cannot leave a truncated surface. */
export function writeFreshness(quota: QuotaTracker, path: string = FRESHNESS_PATH, now: Date = new Date()): FreshnessFile {
  const file = buildFreshness(quota, now);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, path);
  return file;
}
