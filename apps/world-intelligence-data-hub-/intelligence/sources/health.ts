import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { SourceHealthEntry, SourceHealthState } from '../../lib/types.ts';
import { PATHS } from '../../lib/paths.ts';
import { logger } from '../../lib/logger.ts';

// ── Persistence ───────────────────────────────────────────────────────────────

function load(): SourceHealthState {
  if (!existsSync(PATHS.intelligence.sourceHealth)) return {};
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.sourceHealth, 'utf-8')) as SourceHealthState;
  } catch {
    logger.warn('health', 'Corrupted source-health.json — starting fresh');
    return {};
  }
}

function save(state: SourceHealthState): void {
  mkdirSync(dirname(PATHS.intelligence.sourceHealth), { recursive: true });
  writeFileSync(PATHS.intelligence.sourceHealth, JSON.stringify(state, null, 2));
}

// ── Default entry ─────────────────────────────────────────────────────────────

function blank(sourceId: string): SourceHealthEntry {
  return {
    source_id:            sourceId,
    total_fetches:        0,
    successful_fetches:   0,
    failed_fetches:       0,
    empty_feed_count:     0,
    consecutive_failures: 0,
    error_count:          0,
  };
}

// ── Monitor ───────────────────────────────────────────────────────────────────

// Smoothing factor for exponential moving average of response times.
const EMA_ALPHA = 0.2;

export class SourceHealthMonitor {
  private state: SourceHealthState;

  constructor() {
    this.state = load();
  }

  recordSuccess(sourceId: string, responseTimeMs: number): void {
    const e = this.state[sourceId] ?? blank(sourceId);
    const prevAvg = e.avg_response_time_ms;
    this.state[sourceId] = {
      ...e,
      total_fetches:         e.total_fetches + 1,
      successful_fetches:    e.successful_fetches + 1,
      consecutive_failures:  0,
      last_success:          new Date().toISOString(),
      last_response_time_ms: responseTimeMs,
      avg_response_time_ms:  prevAvg !== undefined
        ? Math.round((1 - EMA_ALPHA) * prevAvg + EMA_ALPHA * responseTimeMs)
        : responseTimeMs,
    };
    save(this.state);
  }

  recordFailure(sourceId: string, reason: string): void {
    const e = this.state[sourceId] ?? blank(sourceId);
    this.state[sourceId] = {
      ...e,
      total_fetches:         e.total_fetches + 1,
      failed_fetches:        e.failed_fetches + 1,
      error_count:           e.error_count + 1,
      consecutive_failures:  e.consecutive_failures + 1,
      last_failure:          new Date().toISOString(),
      last_failure_reason:   reason.slice(0, 300),
    };
    save(this.state);
  }

  recordEmptyFeed(sourceId: string): void {
    const e = this.state[sourceId] ?? blank(sourceId);
    this.state[sourceId] = {
      ...e,
      empty_feed_count: e.empty_feed_count + 1,
    };
    save(this.state);
  }

  getHealth(sourceId: string): SourceHealthEntry | undefined {
    return this.state[sourceId];
  }

  // A source is unhealthy if it has failed consecutively >= threshold times.
  isUnhealthy(sourceId: string, threshold = 3): boolean {
    return (this.state[sourceId]?.consecutive_failures ?? 0) >= threshold;
  }

  getAll(): SourceHealthEntry[] {
    return Object.values(this.state);
  }

  getSummary(): {
    total_tracked:  number;
    healthy:        number;
    degraded:       number;   // 1–2 consecutive failures
    unhealthy:      number;   // 3+ consecutive failures
    never_checked:  number;
  } {
    const entries   = this.getAll();
    const healthy   = entries.filter(e => e.consecutive_failures === 0).length;
    const degraded  = entries.filter(e => e.consecutive_failures >= 1 && e.consecutive_failures < 3).length;
    const unhealthy = entries.filter(e => e.consecutive_failures >= 3).length;
    return {
      total_tracked:  entries.length,
      healthy,
      degraded,
      unhealthy,
      never_checked:  0,   // populated by caller who knows the full source list
    };
  }
}
