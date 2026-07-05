import { readFileSync, existsSync } from 'fs';
import type { QuotaEntry, QuotaState, SourceConfig } from '../lib/types.ts';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';
import { writeJsonAtomic } from '../lib/atomic-fs.ts';

// ── Source configuration registry ───────────────────────────────────────────

export const SOURCE_CONFIGS: Record<string, SourceConfig> = {
  acled: {
    name: 'acled',
    ttlHours: 24,
    maxStalenessHours: 24,
    dailyLimit: null,
    monthlyLimit: 10_000,
    resetPeriod: 'monthly',
    requestsPerRun: 1,
  },
  eia: {
    name: 'eia',
    ttlHours: 12,
    maxStalenessHours: 36,
    dailyLimit: 1_000,
    monthlyLimit: null,
    resetPeriod: 'daily',
    requestsPerRun: 2,   // spot-prices + us-production (SERIES array)
  },
  gdelt: {
    name: 'gdelt',
    ttlHours: 0.25,          // 15 minutes
    maxStalenessHours: 2,
    dailyLimit: null,
    monthlyLimit: null,
    resetPeriod: 'none',
    requestsPerRun: 10,  // 10 query strings (QUERIES array) — no enforced limit
  },
  worldbank: {
    name: 'worldbank',
    ttlHours: 168,            // 7 days
    maxStalenessHours: 336,
    dailyLimit: null,
    monthlyLimit: null,
    resetPeriod: 'none',
    requestsPerRun: 3,   // 3 indicators (INDICATORS array) — no enforced limit
  },
  ucdp: {
    name: 'ucdp',
    ttlHours: 168,            // 7 days — academic dataset, no daily updates
    maxStalenessHours: 336,
    dailyLimit: 5_000,        // UCDP token limit per day
    monthlyLimit: null,
    resetPeriod: 'daily',
    requestsPerRun: 1,        // single paginated fetch (pagesize=500)
  },
};

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayUTC(): string  { return new Date().toISOString().slice(0, 10); }
function thisMonthUTC(): string { return new Date().toISOString().slice(0, 7); }

// ── QuotaTracker ─────────────────────────────────────────────────────────────

export class QuotaTracker {
  private state: QuotaState;

  constructor() {
    this.state = this.load();
    this.resetIfNeeded();
  }

  private load(): QuotaState {
    if (!existsSync(PATHS.quota.state)) return {};
    try {
      return JSON.parse(readFileSync(PATHS.quota.state, 'utf-8')) as QuotaState;
    } catch {
      logger.warn('quota', 'Corrupted state file — starting fresh');
      return {};
    }
  }

  private save(): void {
    writeJsonAtomic(PATHS.quota.state, this.state);
  }

  private resetIfNeeded(): void {
    const today = todayUTC();
    const month = thisMonthUTC();
    let dirty = false;

    for (const [source, config] of Object.entries(SOURCE_CONFIGS)) {
      const entry = this.state[source];
      if (!entry) continue;

      if (config.resetPeriod === 'daily' && entry.resetDate !== today) {
        logger.info('quota', `Daily quota reset for ${source}`, { wasUsed: entry.dailyUsed });
        this.state[source] = { ...entry, dailyUsed: 0, resetDate: today };
        dirty = true;
      } else if (config.resetPeriod === 'monthly' && entry.resetDate !== month) {
        // dailyUsed is incremented unconditionally by recordFetch() regardless
        // of resetPeriod, but monthly-period sources have no daily rollover
        // check above — reset it here too so it can't grow unbounded across
        // months (it's purely informational for these sources: dailyLimit is
        // null wherever resetPeriod is 'monthly').
        logger.info('quota', `Monthly quota reset for ${source}`, { wasUsed: entry.monthlyUsed });
        this.state[source] = { ...entry, dailyUsed: 0, monthlyUsed: 0, resetDate: month };
        dirty = true;
      }
    }

    if (dirty) this.save();
  }

  canFetch(source: string): { allowed: boolean; reason?: string } {
    const config = SOURCE_CONFIGS[source];
    if (!config) return { allowed: false, reason: `Unknown source: ${source}` };

    const entry = this.state[source];
    if (!entry) return { allowed: true };

    if (config.dailyLimit !== null && entry.dailyUsed >= config.dailyLimit) {
      return {
        allowed: false,
        reason: `Daily limit reached (${entry.dailyUsed}/${config.dailyLimit})`,
      };
    }

    if (config.monthlyLimit !== null && entry.monthlyUsed >= config.monthlyLimit) {
      return {
        allowed: false,
        reason: `Monthly limit reached (${entry.monthlyUsed}/${config.monthlyLimit})`,
      };
    }

    return { allowed: true };
  }

  isCacheFresh(source: string): boolean {
    const config = SOURCE_CONFIGS[source];
    const lastFetch = this.state[source]?.lastSuccessfulFetch;
    if (!config || !lastFetch) return false;
    const ageMs = Date.now() - new Date(lastFetch).getTime();
    return ageMs < config.ttlHours * 3_600_000;
  }

  isStale(source: string): boolean {
    const config = SOURCE_CONFIGS[source];
    const lastFetch = this.state[source]?.lastSuccessfulFetch;
    if (!config || !lastFetch) return true;
    const ageMs = Date.now() - new Date(lastFetch).getTime();
    return ageMs > config.maxStalenessHours * 3_600_000;
  }

  recordFetch(source: string, success: boolean): void {
    const today = todayUTC();
    const month = thisMonthUTC();
    const config = SOURCE_CONFIGS[source];
    const increment = config?.requestsPerRun ?? 1;
    const entry: QuotaEntry = this.state[source] ?? {
      source,
      dailyUsed: 0,
      monthlyUsed: 0,
      resetDate: config?.resetPeriod === 'monthly' ? month : today,
    };

    this.state[source] = {
      ...entry,
      dailyUsed:   entry.dailyUsed + increment,
      monthlyUsed: entry.monthlyUsed + increment,
      lastSuccessfulFetch: success ? new Date().toISOString() : entry.lastSuccessfulFetch,
    };
    this.save();
  }

  getLastFetch(source: string): string | undefined {
    return this.state[source]?.lastSuccessfulFetch;
  }

  getSummary(): Record<string, { dailyUsed: number; monthlyUsed: number; lastFetch?: string; stale: boolean }> {
    const summary: ReturnType<typeof this.getSummary> = {};
    for (const source of Object.keys(SOURCE_CONFIGS)) {
      const entry = this.state[source];
      summary[source] = {
        dailyUsed:   entry?.dailyUsed ?? 0,
        monthlyUsed: entry?.monthlyUsed ?? 0,
        lastFetch:   entry?.lastSuccessfulFetch,
        stale:       this.isStale(source),
      };
    }
    return summary;
  }
}
